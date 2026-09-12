import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from './config.js';
import * as walletStore from './walletStore.js';
import * as store from './store.js';
import * as msg from './messages.js';
import { CHAINS, getChain } from './chains.js';

/**
 * Fondasi bersama semua modul perintah: instance bot, opsi parse HTML, dan
 * utilitas kecil yang dipakai di banyak tempat.
 *
 * Modul ini TIDAK boleh mengimpor modul perintah mana pun — arah impor selalu
 * commands/* → core, tak pernah sebaliknya. Itu yang menjaga tak ada lingkaran
 * impor saat index.ts dipecah.
 */

export const bot = new Telegraf(config.telegram.botToken);

/**
 * Tanda kepemilikan di kaki SETIAP keluaran.
 *
 * Dipasang di lapisan TELEGRAM, bukan di ~90 fungsi pesan dan bukan pula di
 * middleware ctx: ctx.reply, kartu monitor (bot.telegram.sendMessage langsung),
 * dan watchdog semuanya bermuara di sini. Satu titik berarti pesan baru ikut
 * dapat tanpa harus diingat, dan tak ada jalur yang terlewat.
 */
const SIGNATURE = '<i>Powered by Moaru</i>';
const TG_TEXT_MAX = 4096;
const TG_CAPTION_MAX = 1024;

function sign(text: unknown, max: number): unknown {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (text.includes('Powered by Moaru')) return text; // edit berulang tak menumpuk
  const tail = `\n\n${SIGNATURE}`;
  // Batas Telegram: pesan yang kepanjangan DITOLAK seluruhnya, jadi lebih baik
  // kehilangan tanda tangannya daripada kehilangan pesannya.
  return text.length + tail.length > max ? text : text + tail;
}

{
  const tg = bot.telegram as unknown as Record<string, (...a: any[]) => unknown>;
  const wrapText = (name: string, argIndex: number, max: number) => {
    const orig = tg[name]?.bind(tg);
    if (!orig) return;
    tg[name] = (...args: any[]) => {
      args[argIndex] = sign(args[argIndex], max);
      return orig(...args);
    };
  };
  wrapText('sendMessage', 1, TG_TEXT_MAX);
  wrapText('editMessageText', 3, TG_TEXT_MAX);
  // Dokumen (kartu PnL) membawa teksnya di caption.
  for (const [name, i] of [['sendDocument', 2], ['sendPhoto', 2]] as const) {
    const orig = tg[name]?.bind(tg);
    if (!orig) continue;
    tg[name] = (...args: any[]) => {
      const extra = args[i];
      if (extra?.caption) args[i] = { ...extra, caption: sign(extra.caption, TG_CAPTION_MAX) };
      return orig(...args);
    };
  }
  const editMedia = tg.editMessageMedia?.bind(tg);
  if (editMedia) {
    tg.editMessageMedia = (...args: any[]) => {
      const m = args[3];
      if (m?.caption) args[3] = { ...m, caption: sign(m.caption, TG_CAPTION_MAX) };
      return editMedia(...args);
    };
  }
}

/**
 * Nama tiap command yang benar-benar didaftarkan. Telegraf tak menyimpan daftar
 * ini, padahal tanpa daftar tak ada cara memeriksa menu Telegram sudah lengkap —
 * dan perintah yang hidup tapi absen dari menu praktis tak terlihat user.
 * bot.start() ditambahkan manual: ia bukan bot.command().
 */
export const registeredCommands = new Set<string>(['start']);
const originalCommand = bot.command.bind(bot);
(bot as any).command = (cmd: unknown, ...rest: unknown[]) => {
  for (const c of Array.isArray(cmd) ? cmd : [cmd]) {
    if (typeof c === 'string') registeredCommands.add(c);
  }
  return (originalCommand as any)(cmd, ...rest);
};

export const html = { parse_mode: 'HTML' as const };

/**
 * Batas per-transaksi. Mematikannya harus DISENGAJA, bukan efek samping.
 *
 * `.env` KOSONG tetap jatuh ke bawaan yang masuk akal — dulu kosong berarti
 * unlimited, dan itu diam-diam: salah ketik satu baris .env membuka wallet tanpa
 * ada yang menahan. Untuk benar-benar mematikan batas, tulis `off` (atau `0`)
 * secara eksplisit; nilai lain dibaca sebagai angka batas.
 */
const DEFAULT_MAX_ETH = 0.1;
const DEFAULT_MAX_STABLE = 250;

const parseCap = (raw: string, fallback: number): number => {
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === '0') return Infinity;
  const n = Number(v);
  return n > 0 ? n : fallback;
};

export const maxEth = parseCap(config.safety.maxEthPerTx, DEFAULT_MAX_ETH);
export const maxStable = parseCap(config.safety.maxStablePerTx, DEFAULT_MAX_STABLE);

/** Label batas yang menyebut satuan aset yang benar (ETH di Robinhood, BNB di BSC). */
export const capLabelFor = (cap: number, sym: string) => (cap === Infinity ? 'unlimited' : `${cap} ${sym}`);
export const maxEthLabel = capLabelFor(maxEth, 'ETH');

/** Posisi sudah di-burn/tak ada di chain (NFT hilang). */
export const isGoneErr = (e: unknown) => /invalid token id/i.test(String((e as Error)?.message ?? e));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kirim tx dengan pemulihan tabrakan NONCE. Operasi write beruntun (mis. Permit2
 * approve → modifyLiquidities, atau rute swap yang gagal lalu diulang) kadang
 * memakai nonce yang sama karena hitungan "pending" RPC telat → "nonce has already
 * been used" dan seluruh langkah gagal. Saat kena error nonce, ambil nonce SEGAR
 * dari chain lalu ulang (bukan NonceManager yang bisa "kejauhan" saat tx gagal).
 */
export async function sendTxNonceSafe(
  wallet: ethers.Wallet,
  txReq: ethers.TransactionRequest,
): Promise<ethers.TransactionResponse> {
  let nonce: number | undefined;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await wallet.sendTransaction(nonce === undefined ? txReq : { ...txReq, nonce });
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (attempt < 3 && /nonce|already been used|nonce too low|replacement/i.test(msg)) {
        await sleep(800);
        nonce = await wallet.provider!.getTransactionCount(wallet.address, 'pending');
        continue;
      }
      throw e;
    }
  }
  throw new Error('unreachable');
}

/** Umur maksimum sebuah alur wizard sebelum ketikan lama dianggap kedaluwarsa. */
export const FLOW_TTL_MS = 15 * 60_000;
export const isStaleFlow = (startedAt: number): boolean => Date.now() - startedAt > FLOW_TTL_MS;

/**
 * Concurrency saat membangun kartu posisi. 3 dulu dipilih untuk menjaga rate RPC,
 * tapi pengukuran 30 Agu 2026 menunjukkan RPC jauh lebih lapang dari itu (33
 * resolvePoolKeyV4 paralel = 77 ms) sementara satu getPositionDetail makan ~820 ms.
 * Dengan 3, 12 posisi = 4 gelombang ≈ 3,3 dtk sebelum kartu pertama terkirim.
 */
export const POS_CARD_CONCURRENCY = 6;

/**
 * Ketikan nominal → wei, atau null bila tak masuk akal. `Number(raw) > 0` saja
 * meloloskan '1e-9' / desimal berlebih yang lalu membuat parseUnits melempar DI LUAR
 * try (kartu ERROR mentah). Desimal berlebih DIPOTONG (tak pernah membesarkan nominal).
 */
export function parseAmt(raw: string, dec: number): bigint | null {
  const t = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  const wei = ethers.parseUnits(`${i}.${f.slice(0, dec) || '0'}`, dec);
  return wei > 0n ? wei : null;
}

/** Jalankan fn pada items dengan batas concurrency (jaga rate RPC). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Seperti mapLimit, tapi mengembalikan SATU promise per item — begitu, urutan
 * pengiriman tetap terjaga sementara pekerjaan tetap jalan di latar.
 *
 * Kartu posisi dulu dibangun semua dulu (`await mapLimit`) BARU dikirim satu per
 * satu, jadi layar diam sepanjang gelombang build terakhir walau kartu pertama
 * sudah lama siap. Dengan ini kartu #1 terkirim segera setelah #1 jadi.
 */
export function mapLimitStream<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R>[] {
  const out: Array<{ resolve: (v: R) => void; reject: (e: unknown) => void; promise: Promise<R> }> = items.map(() => {
    let resolve!: (v: R) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Tanpa ini, item yang gagal jadi unhandled rejection SEBELUM pemanggil sempat
    // meng-await-nya (Node membunuh proses) — bot mati gara-gara satu kartu error.
    promise.catch(() => {});
    return { resolve, reject, promise };
  });
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i].resolve(await fn(items[i], i));
      } catch (e) {
        out[i].reject(e);
      }
    }
  };
  void Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.map((o) => o.promise);
}

/** Edit pesan progress existing, atau kirim baru bila gagal/tidak ada. */
export async function editProgress(
  ctx: any,
  prog: { message_id: number } | null | undefined,
  text: string,
  extra: Record<string, unknown> = html,
): Promise<{ message_id: number }> {
  if (prog?.message_id && ctx.chat?.id) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, text, extra);
      return prog;
    } catch {
      /* fallback: kirim bubble baru */
    }
  }
  return ctx.reply(text, extra);
}

/**
 * Pendaftaran pembersih alur. Tiap modul yang menyimpan state per-user
 * mendaftarkan pembersihnya di sini, supaya resetFlows() tak perlu tahu ada
 * alur apa saja — itulah yang dulu memaksa semuanya tinggal di satu berkas.
 */
const flowResets: Array<(uid: number) => void> = [];

export function registerFlowReset(fn: (uid: number) => void): void {
  flowResets.push(fn);
}

/** Mulai alur baru = buang sisa alur lama (anti-hijack ketikan). */
export function resetFlows(uid: number): void {
  for (const fn of flowResets) fn(uid);
}

/**
 * The /start grid: every command the bot answers, as one tap each.
 *
 * This deliberately breaks the usual "at most six buttons per card" rule. /start is a
 * launcher, not a card that asks a question -- hiding twelve of fifteen commands behind
 * a submenu costs a tap on every use to save scrolling once.
 *
 * Connect Wallet replaces the whole grid when there is no wallet: nothing else on it
 * would work anyway.
 */
export const START_GRID: Array<[label: string, data: string]> = [
  ['💰 Portfolio', 'portfolio'], ['📊 Positions', 'positions'], ['🧾 PnL', 'pnl'],
  // No Add LP, Close LP or Buy: all three start from a pasted CA or from the position
  // itself in /positions. A button for any of them would only ask for the CA again.
  // Swap stays -- it opens the holdings list, which is the point when the CA is the
  // thing you do not have to hand. It runs /sell: the label is the wider word, the
  // action behind it is still selling a holding back to the pair's base.
  // No Unwrap either: sweepStuckWeth unwraps stray WETH on every chain each minute, and
  // recoverStrayWeth fires the moment an add or close fails. /unwrap stays as a typed
  // command for the rare case both are unavailable; it does not need a button.
  ['🎯 Claim Fees', 'cmd:claim_fees'], ['💱 Swap', 'cmd:sell'], ['🌉 Bridge', 'cmd:bridge'],
  // Withdraw, not Send: it runs /send, but "withdraw" is what moving funds out to your
  // own address is called, and it reads as the exit from the bot rather than a transfer.
  ['📤 Withdraw', 'cmd:send'], ['⛽ Gas', 'cmd:gas'], ['🔔 Alerts', 'cmd:alerts'],
  ['⚙️ Settings', 'cmd:settings'], ['📖 Help', 'help'],
];

export const startKeyboard = () => {
  if (!walletStore.isConnected()) {
    return Markup.inlineKeyboard([[Markup.button.callback('🔗 Connect Wallet', 'connect')]]);
  }
  const rows = [];
  for (let i = 0; i < START_GRID.length; i += 3) {
    rows.push(START_GRID.slice(i, i + 3).map(([t, d]) => Markup.button.callback(t, d)));
  }
  return Markup.inlineKeyboard(rows);
};

/**
 * The WELCOME card, built in one place.
 *
 * /start, a successful connect and every "Back to Menu" button all land here, and when
 * each built its own version they drifted: Back to Menu still opened the old /help card
 * long after /start had become the real menu.
 */
export function startCard(o: { imported?: number; gone?: number } = {}): string {
  const cc = getChain();
  const addr = walletStore.address();
  return msg.msgStarted({
    dryRun: config.safety.dryRun,
    chainLabel: cc.label,
    chainId: cc.chainId,
    positions: store.active().length,
    imported: o.imported ?? 0,
    gone: o.gone ?? 0,
    walletShort: addr ? msg.shortAddr(addr) : null,
    chainLabels: Object.values(CHAINS).map((c) => c.label),
  });
}
