import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { config } from './config.js';

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

/** Batas ETH/tx: nilai <= 0 atau kosong berarti TANPA batas. */
const rawMax = Number(config.safety.maxEthPerTx);
export const maxEth = rawMax > 0 ? rawMax : Infinity;
export const maxEthLabel = maxEth === Infinity ? 'unlimited' : `${maxEth} ETH`;

/** Posisi sudah di-burn/tak ada di chain (NFT hilang). */
export const isGoneErr = (e: unknown) => /invalid token id/i.test(String((e as Error)?.message ?? e));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Umur maksimum sebuah alur wizard sebelum ketikan lama dianggap kedaluwarsa. */
export const FLOW_TTL_MS = 15 * 60_000;
export const isStaleFlow = (startedAt: number): boolean => Date.now() - startedAt > FLOW_TTL_MS;

/** Concurrency saat membangun kartu posisi. */
export const POS_CARD_CONCURRENCY = 3;

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
