import { Telegraf, Markup, Input } from 'telegraf';
import { renderProfitCard } from './card.js';
import { message } from 'telegraf/filters';
import { ethers } from 'ethers';
import { config } from './config.js';
import { provider, wallet, ERC20_ABI } from './chain.js';
import {
  planAddSingleSided,
  ADD_GAS_UNITS,
  VALID_FEES,
  executeAdd,
  executeRemove,
  getPositionDetail,
  discoverAllPools,
  listPositions,
  type AddPlan,
  type PositionDetail,
} from './uniswap.js';
import { listPositionsV4, v4Supported, closePositionV4, openPositionV4, getPoolKeyV4, valuePositionV4, type V4Position } from './uniswapV4.js';
import * as v4store from './v4store.js';
import { screenToken, formatScreen, getEthUsd } from './screening.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust, getBridgeQuote, executeBridge, NATIVE, type BridgeQuote } from './relay.js';
import { startMonitor } from './monitor.js';
import * as store from './store.js';
import * as journal from './journal.js';
import * as msg from './messages.js';
import * as explore from './explore.js';
import {
  CHAINS,
  getChain,
  detectChains,
  baseOf,
  basesFor,
  detectBase,
  isStableBase,
  baseSymbolOf,
  type ChainCtx,
  type BaseKind,
  type BaseAsset,
} from './chains.js';
import { swapExactInBest, previewSwapOut } from './swapRoute.js';

// Posisi sudah di-burn/tak ada di chain (NFT hilang).
const isGoneErr = (e: unknown) => /invalid token id/i.test(String((e as Error)?.message ?? e));

/**
 * PHILIPS LP Bot — otak utama.
 * Command aktif: /start /help /status /positions /history /pnl /explore /add /stop
 * /closeall /buy /sell /bridge /size
 * Screening token berjalan otomatis di dalam /add.
 */

const bot = new Telegraf(config.telegram.botToken);
// Batas ETH/tx: nilai <= 0 atau kosong berarti TANPA batas.
const rawMax = Number(config.safety.maxEthPerTx);
const maxEth = rawMax > 0 ? rawMax : Infinity;



const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ketikan nominal → wei, atau null bila tak masuk akal. `Number(raw) > 0` saja
 * meloloskan '1e-9' / desimal berlebih yang lalu membuat parseUnits melempar DI LUAR
 * try (kartu ERROR mentah). Desimal berlebih DIPOTONG (tak pernah membesarkan nominal).
 */
function parseAmt(raw: string, dec: number): bigint | null {
  const t = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  const wei = ethers.parseUnits(`${i}.${f.slice(0, dec) || '0'}`, dec);
  return wei > 0n ? wei : null;
}
// Berapa kali maksimum ulangi swap saat cash-out sampai token benar-benar habis.
const MAX_CLOSE_SWEEP = 4;
/** Max token hold ditampilkan di /status (setelah filter saldo > 0). */
const SELL_HOLDINGS_CAP = 12; // maks token di daftar /sell
/** Max kandidat CA dicek balance (jurnal + posisi). */
const HOLDINGS_CAND_MAX = 20;
/** Concurrency saat membangun kartu posisi. */
const POS_CARD_CONCURRENCY = 3;

/** Jalankan fn pada items dengan batas concurrency (jaga rate RPC). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
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
 * Swap SELURUH saldo token (bukan delta) ke ETH, ulang sampai saldo = 0.
 * Mengatasi: token sisa dari close sebelumnya, RPC telat update, Relay no-op,
 * dan swap parsial. Setiap iterasi menukar saldo penuh yang tersisa.
 */
async function sweepTokenToBase(
  otherAddr: string,
  otherC: ethers.Contract,
  base: BaseAsset,
  cc: ChainCtx,
  notes: string[],
): Promise<{ baseOut: bigint; txHashes: string[]; leftover: boolean }> {
  let baseOut = 0n;
  const txHashes: string[] = [];
  let prev = -1n;
  for (let attempt = 1; attempt <= MAX_CLOSE_SWEEP; attempt++) {
    const bal: bigint = await otherC.balanceOf(cc.wallet.address);
    if (bal === 0n) break;
    if (bal === prev) {
      notes.push(`Sisa ${bal} unit token tak berkurang — swap dihentikan (butuh sweep manual).`);
      break;
    }
    prev = bal;
    try {
      if (isStableBase(base.kind)) {
        // Stablecoin base (USDG/USDT): swap token → base (fungsi generik pakai base.address).
        const r = await swapTokenToUsdgRobust(otherAddr, bal, base.address, cc);
        baseOut += r.outWei;
        txHashes.push(...r.txHashes);
        notes.push(`Swap ${attempt}: token → ${base.symbol} via ${r.route}`);
      } else {
        const r = await swapTokenToEthRobust(otherAddr, bal, cc);
        baseOut += r.outEthWei;
        txHashes.push(...r.txHashes);
        notes.push(`Swap ${attempt}: token → ETH via ${r.route}`);
      }
    } catch (e) {
      notes.push(`Swap percobaan ${attempt} gagal: ${(e as Error).message.slice(0, 140)}`);
      break;
    }
    await sleep(1500); // beri waktu saldo settle di RPC sebelum verifikasi ulang
  }
  const finalBal: bigint = await otherC.balanceOf(cc.wallet.address);
  return { baseOut, txHashes, leftover: finalBal > 0n };
}

/** Hitung biaya jaringan (est) + kebutuhan untuk buka LP, base-aware.
 *  WETH: deposit (wrap) + gas keduanya dari ETH native. USDG: deposit dari saldo
 *  USDG (harus dipegang, tak bisa wrap) + gas dari ETH native terpisah. */
async function estimateAddCost(cc: ChainCtx, base: import('./chains.js').BaseAsset, depositAmount: string) {
  const depositWei = ethers.parseUnits(depositAmount, base.decimals);
  const [feeData, nativeBal] = await Promise.all([
    cc.provider.getFeeData(),
    cc.provider.getBalance(cc.wallet.address),
  ]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasWei = gasPrice * ADD_GAS_UNITS;

  if (base.wrappable) {
    const wethBal: bigint = await cc.weth.balanceOf(cc.wallet.address);
    const nativeForDeposit = depositWei > wethBal ? depositWei - wethBal : 0n;
    const totalWei = nativeForDeposit + gasWei;
    const shortWei = totalWei > nativeBal ? totalWei - nativeBal : 0n;
    return {
      gasEth: msg.fmtEth(gasWei),
      needLabel: `${msg.fmtEth(totalWei)} ETH`,
      balanceLabel: `${msg.fmtEth(nativeBal)} ETH`,
      shortLabel: shortWei > 0n ? `${msg.fmtEth(shortWei)} ETH` : null,
    };
  }
  const erc = new ethers.Contract(base.address, ERC20_ABI, cc.provider);
  const bal: bigint = await erc.balanceOf(cc.wallet.address);
  const shortBase = depositWei > bal ? depositWei - bal : 0n;
  const shortGas = gasWei > nativeBal ? gasWei - nativeBal : 0n;
  const shorts: string[] = [];
  if (shortBase > 0n) shorts.push(`${ethers.formatUnits(shortBase, base.decimals)} ${base.symbol}`);
  if (shortGas > 0n) shorts.push(`${msg.fmtEth(shortGas)} ETH (gas)`);
  return {
    gasEth: msg.fmtEth(gasWei),
    needLabel: `${depositAmount} ${base.symbol} + gas`,
    balanceLabel: `${ethers.formatUnits(bal, base.decimals)} ${base.symbol} · ${msg.fmtEth(nativeBal)} ETH`,
    shortLabel: shorts.length ? shorts.join(' + ') : null,
  };
}
const maxEthLabel = maxEth === Infinity ? 'tanpa batas' : `${maxEth} ETH`;

// Alur wizard /add (bisa maju–mundur antar langkah).
type AddFlow = {
  token: string;
  chain: string; // kunci chain tempat token berada
  screenBahaya: boolean;
  screenFailed?: boolean; // screening ERROR (bukan BAHAYA) → token tak terverifikasi
  pools: explore.TokenPool[]; // cerminan app.uniswap.org (v3 + v4), urut TVL
  selected?: explore.TokenPool; // pool yang dipilih user
  base?: BaseKind; // pasangan pool terpilih (weth | usdg)
  fee?: number;
  rangePct?: number; // v3: lebar rentang %. v4: -1 = default single-sided
  ethAmount?: string;
  awaitingAmount?: boolean; // menunggu user mengetik nominal
  plan?: AddPlan;
  startedAt: number; // epoch ms — untuk kadaluarsa sesi (anti "angka lama termakan")
};
const flows = new Map<number, AddFlow>();

/**
 * Buang SEMUA alur yang setengah jalan milik user. Handler teks memilih tujuan
 * berdasarkan prioritas statis, jadi sisa alur lama bisa menelan ketikan nominal
 * alur baru (mis. sisa /buy menangkap nominal wizard /add → kartu BELI).
 * Dipanggil di pintu masuk tiap alur + tombol Batal.
 */
function resetFlows(uid: number): void {
  flows.delete(uid);
  fundFlows.delete(uid);
  tswapFlows.delete(uid);
  hubs.delete(uid);
}

/**
 * HUB TOKEN — tempel CA telanjang → satu kartu identitas + 4 aksi.
 * Teks & keyboard disimpan supaya tombol "Kembali" dari alur mana pun bisa
 * merender ulang TANPA screening ulang (0 RPC).
 */
type Hub = { ca: string; chainKey: string; text: string; kb: any; sym: string; dec: number; screenText: string; bahaya: boolean; failed: boolean };
const hubs = new Map<number, Hub>();
// Sesi wizard/swap kedaluwarsa: bila user tinggalkan lalu ketik angka lain jauh
// kemudian, jangan sampai termakan flow basi. 15 menit.
const FLOW_TTL_MS = 15 * 60_000;
const isStaleFlow = (startedAt: number): boolean => Date.now() - startedAt > FLOW_TTL_MS;
// Preset nominal ETH: tersimpan di data/settings.json, dikelola via /size.

// Pilihan lebar rentang (%) + label risiko.
const RANGE_OPTIONS = [
  { pct: 10, label: 'Konservatif' },
  { pct: 30, label: 'Moderat' },
  { pct: 50, label: 'Agresif' },
  { pct: 70, label: 'Sangat Agresif' },
];

const html = { parse_mode: 'HTML' as const };

/** Edit pesan progress existing, atau kirim baru bila gagal/tidak ada. */
async function editProgress(
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

// --- Penjaga: hanya pemilik yang boleh memakai bot ---
bot.use((ctx, next) => {
  // Diam-diam abaikan: membalas orang asing = mengonfirmasi bot ini ada & bisa
  // dipaksa membalas. Grup juga ditolak (kartu saldo terbaca semua anggota).
  if (ctx.from?.id !== config.telegram.allowedUserId || (ctx.chat && ctx.chat.type !== 'private')) {
    console.log('[guard] tolak', ctx.from?.id, ctx.chat?.type);
    return;
  }
  return next();
});

// ---------- Fase 1 ----------
/**
 * Sinkron store dengan realita on-chain (chain aktif): impor posisi LP yang ada
 * di wallet tapi belum tercatat (mis. dibuka manual di Uniswap/CLI), dan tandai
 * posisi ter-track yang sudah tak ada on-chain sebagai 'gone'. Fail-safe: bila
 * pembacaan on-chain gagal → TIDAK menyentuh store (hindari salah tandai gone).
 */
async function syncOnChainPositions(cc: ChainCtx = getChain()): Promise<{ imported: number; gone: number }> {
  let onchain: Awaited<ReturnType<typeof listPositions>>;
  try {
    onchain = await listPositions(cc);
  } catch (e) {
    console.log('[sync] listPositions gagal:', (e as Error).message.slice(0, 120));
    return { imported: 0, gone: 0 };
  }
  const onchainIds = new Set(onchain.map((p) => p.tokenId));
  let imported = 0;
  let gone = 0;
  // ① Impor posisi on-chain (liquidity > 0) yang belum ada di store.
  for (const p of onchain) {
    if (p.liquidity === 0n || store.get(p.tokenId)) continue;
    // Jangan impor pool tanpa base yang dikenal: bot tak punya rute cash-out
    // dua sisi untuk pool semacam itu (lihat stopAndCashOut).
    const base = detectBase(cc, p.token0, p.token1);
    if (!base) continue;
    const isBase0 = base.address.toLowerCase() === p.token0.toLowerCase();
    store.addImported({
      tokenId: p.tokenId,
      chain: cc.key,
      ca: isBase0 ? p.token1 : p.token0,
      fee: p.fee,
      symbol: isBase0 ? p.token1Symbol : p.token0Symbol,
      baseKind: base.kind,
    });
    imported++;
  }
  // ② Posisi ter-track (chain ini) yang sudah tak ada on-chain → gone.
  for (const rec of store.active()) {
    if ((rec.chain ?? cc.key) !== cc.key) continue;
    if (!onchainIds.has(rec.tokenId)) {
      finalizeClose(rec.tokenId, { reason: 'gone' });
      gone++;
    }
  }
  if (imported || gone) console.log(`[sync] impor=${imported} gone=${gone} (chain ${cc.key})`);
  return { imported, gone };
}

// Keyboard inline /start (sama dgn /help tapi tombol Help, bukan Close All).
// 'portfolio' & 'status' kini kartu yang SAMA (kartu uang) — cukup satu tombol.
// Action 'portfolio' tetap hidup untuk tombol di pesan-pesan lama.
const startKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💰 Uang', 'status'), Markup.button.callback('📋 Posisi', 'positions')],
    [Markup.button.callback('📖 Daftar Perintah', 'help')],
  ]);

bot.start(async (ctx) => {
  const { imported, gone } = await syncOnChainPositions().catch(() => ({ imported: 0, gone: 0 }));
  const cc = getChain();
  await ctx.reply(
    msg.msgStarted({
      dryRun: config.safety.dryRun,
      chainLabel: cc.label,
      chainId: cc.chainId,
      positions: store.active().length,
      imported,
      gone,
    }),
    { ...html, ...startKeyboard() },
  );
});
// Keyboard inline aksi cepat pada kartu /help (di samping reply-keyboard persisten).
const helpKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💰 Uang', 'status'), Markup.button.callback('📋 Posisi', 'positions')],
    [Markup.button.callback('🧾 PnL', 'pnl'), Markup.button.callback('📜 Riwayat', 'history')],
    [Markup.button.callback('⛔ Tutup Semua', 'closeall_confirm')], // aksi uang: baris sendiri
  ]);

bot.command('help', (ctx) =>
  ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, ...helpKeyboard() }),
);

// Tombol inline /help → jalankan command terkait (ctx.reply bekerja dari callback).
bot.action('portfolio', async (ctx) => {
  await ctx.answerCbQuery();
  return renderStatus(ctx, false); // /portfolio dilebur ke kartu uang /status
});
bot.action('pnl', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdPnl(ctx);
});
bot.action('positions', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdPositions(ctx);
});
bot.action('status', async (ctx) => {
  await ctx.answerCbQuery();
  return renderStatus(ctx, false);
});
bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdHistory(ctx);
});
bot.action('closeall_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdCloseAll(ctx);
});
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, ...helpKeyboard() });
});

// Waktu render /status terakhir → footer "Refresh N detik lalu" (owner-only bot).
async function renderStatus(ctx: any, edit: boolean) {
  try {
    // Harga ETH (chain utama) sekali — dipakai valuasi semua chain ETH-native.
    const ethUsd = await getEthUsd(getChain().wethAddress, getChain()).catch(() => null);
    const [network, chains] = await Promise.all([
      provider.getNetwork(),
      // Saldo native di SEMUA chain (paralel; chain gagal → amount '?', usd null).
      Promise.all(
        Object.values(CHAINS).map(async (c) => {
          try {
            const b = await c.provider.getBalance(c.wallet.address);
            const amt = Number(ethers.formatEther(b));
            // USD hanya utk ETH-native (pakai ethUsd). Native lain (BNB) tanpa feed:
            // saldo 0 → $0; saldo > 0 tanpa harga → null (tampil "$?", tak dijumlah).
            const usd =
              c.nativeSymbol === 'ETH' ? (ethUsd !== null ? amt * ethUsd : null) : amt === 0 ? 0 : null;
            return { label: c.label, amount: amt.toFixed(4), symbol: c.nativeSymbol, usd };
          } catch {
            return { label: c.label, amount: '?', symbol: c.nativeSymbol, usd: null };
          }
        }),
      ),
    ]);
    // Jumlah token nyangkut. null = PEMBACAAN GAGAL (bukan "bersih") — dulu RPC
    // gagal terbaca sebagai sinyal aman palsu di pintu masuk /sell & sweep.
    let holdingsCount: number | null = null;
    try {
      holdingsCount = (await sellHoldings(getChain())).length;
    } catch {
      /* biarkan null — kartu menyebut "baca token gagal" */
    }
    // Saldo USDG (base asset) di chain utama — best-effort; hanya tampil bila > 0.
    let usdg: { amount: string; usd: number } | undefined;
    try {
      const cc = getChain();
      if (cc.usdgAddress) {
        const uc = new ethers.Contract(cc.usdgAddress, ERC20_ABI, cc.provider);
        const b: bigint = await uc.balanceOf(cc.wallet.address);
        const amt = Number(ethers.formatUnits(b, 6));
        if (amt > 0) usdg = { amount: amt.toFixed(2), usd: amt }; // USDG ≈ $1
      }
    } catch {
      /* abaikan — status tetap tampil tanpa USDG */
    }
    // Nilai posisi LP aktif (v3 + v4). Gagal baca satu posisi tak boleh menggagalkan kartu;
    // jumlah yang gagal dilaporkan supaya total tak terbaca sebagai fakta.
    let lpUsd: number | null = null;
    let lpFailed = 0;
    try {
      const ccLp = getChain();
      const vals = await mapLimit(store.active(), POS_CARD_CONCURRENCY, async (rec) => {
        try {
          const d = await getPositionDetail(rec.tokenId, getChain(rec.chain));
          const v = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, d.baseDecimals));
          return isStableBase(d.baseKind) ? v : ethUsd !== null ? v * ethUsd : null;
        } catch {
          return undefined;
        }
      });
      const v4 = v4Supported(ccLp) ? await listPositionsV4(ccLp).catch(() => []) : [];
      const v4Vals = v4.map((p) => {
        if (p.valueBaseWei === null || !p.base) return undefined;
        const v = Number(ethers.formatUnits(p.valueBaseWei, p.base === 'USDG' ? 6 : 18));
        return p.base === 'USDG' ? v : ethUsd !== null ? v * ethUsd : null;
      });
      const all = [...vals, ...v4Vals];
      lpFailed = all.filter((v) => v === undefined).length;
      const known = all.filter((v): v is number => typeof v === 'number');
      lpUsd = all.some((v) => v === null) && known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
    } catch {
      lpUsd = null;
    }
    // Total USD: null bila harga ETH tak terbaca (ETH mendominasi → total tak sahih).
    const totalUsd =
      ethUsd === null ? null : chains.reduce((s, c) => s + (c.usd ?? 0), 0) + (usdg?.usd ?? 0);

    const text = msg.msgStatus({
      dryRun: config.safety.dryRun,
      chainId: network.chainId,
      positions: store.active().length,
      limitLabel: maxEthLabel === 'tanpa batas' ? '∞' : maxEthLabel,
      wallet: wallet.address,
      chains,
      usdg,
      totalUsd,
      holdingsCount,
      lpUsd,
      lpFailed,
      realizedEth: journal.lifetimeStats().netEth,
    });
    const extra = {
      ...html,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh', 'refresh:status'),
          Markup.button.callback('📋 Posisi', 'positions'),
          Markup.button.callback('🧾 PnL', 'pnl'),
        ],
      ]),
    };
    await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
  } catch (err) {
    // "message is not modified" = refresh saat data tak berubah → benign, abaikan
    // (kalau tidak, tertangkap di sini & salah tampil sbg ❌ ERROR · network).
    if (/not modified/i.test((err as Error).message)) return;
    await ctx.reply(msg.msgError('network', (err as Error).message), html);
  }
}

bot.command('status', (ctx) => renderStatus(ctx, false));

bot.action('refresh:status', async (ctx) => {
  await ctx.answerCbQuery('Memuat ulang…');
  try {
    await renderStatus(ctx, true);
  } catch (e) {
    // "message is not modified" = data tak berubah — bukan error nyata.
    if (!/not modified/i.test((e as Error).message)) throw e;
  }
});

/** Nilai base (float) → USD. WETH: ×ethUsd (bisa null). USDG: 1:1 dollar. */
async function baseToUsd(baseKind: BaseKind, amountFloat: number, cc: ChainCtx): Promise<number | null> {
  if (isStableBase(baseKind)) return amountFloat; // USDG/USDT ≈ $1
  const eu = await getEthUsd(cc.wethAddress, cc);
  return eu !== null ? amountFloat * eu : null;
}

/** Teks PnL posisi, base-aware (WETH → USD via ethUsd; USDG → USD 1:1). */
async function positionPnlText(
  rec: store.PosRecord | undefined,
  d: PositionDetail,
  cc: ChainCtx,
): Promise<string> {
  const dec = d.baseDecimals;
  if (rec?.imported) {
    // Posisi impor: modal awal tak diketahui → tampilkan nilai sekarang, bukan PnL palsu.
    const curVal = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
    const usdV = await baseToUsd(d.baseKind, curVal, cc);
    const valLabel = usdV !== null ? msg.usdPlain(usdV) : `${curVal.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`;
    return `nilai ${valLabel} · entry tak diketahui`;
  }
  const initF = rec ? Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec)) : 0;
  const curF = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
  const pnlF = curF - initF;
  const pct = initF > 0 ? (pnlF / initF) * 100 : 0;
  const usd = await baseToUsd(d.baseKind, pnlF, cc);
  return usd !== null
    ? `${msg.usdSigned(usd)} (${msg.fmtPct(pct)})`
    : `${pnlF >= 0 ? '+' : ''}${pnlF.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol} (${msg.fmtPct(pct)})`;
}

/** Bangun teks+keyboard kartu posisi (RPC). Side-effect: finalizeClose bila NFT gone. */
async function buildPositionCard(
  rec: store.PosRecord,
): Promise<{ text: string; extra: Record<string, unknown> }> {
  let d: PositionDetail;
  try {
    d = await getPositionDetail(rec.tokenId, getChain(rec.chain));
  } catch (e) {
    if (isGoneErr(e)) {
      finalizeClose(rec.tokenId, { reason: 'gone' });
      return {
        text: msg.msgPositionGone(rec.tokenId, rec.symbol, baseSymbolOf(rec.baseKind)),
        extra: html,
      };
    }
    return { text: msg.msgPositionReadFail(rec.tokenId, (e as Error).message), extra: html };
  }
  const cc = getChain(rec.chain);
  // Warm ethUsd cache sekali per chain (getEthUsd sudah TTL 60s).
  if (d.baseKind === 'weth') await getEthUsd(cc.wethAddress, cc);
  const pnlText = await positionPnlText(rec, d, cc);
  // Jarak batas range dari HARGA SEKARANG (live) — bukan konfigurasi saat buka.
  const sgn = d.baseIsToken0 ? -1 : 1;
  const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - d.currentTick)) - 1) * 100;
  const pcts = [pctOf(d.tickUpper), pctOf(d.tickLower)].sort((a, b) => b - a);
  const range = `${msg.fmtPct(pcts[0])} / ${msg.fmtPct(pcts[1])}`;
  const invest = rec.imported
    ? '—'
    : (rec.nominalEth ?? msg.cleanUnits(BigInt(rec.initialWethWei), isStableBase(rec.baseKind ?? 'weth') ? 6 : 18));
  const text = msg.msgPositionCard({
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    fee: rec.fee,
    invest,
    pnlText,
    range,
    inRange: d.inRange,
    age: msg.fmtAge(Date.now() - rec.openedAt),
    dryRun: config.safety.dryRun,
    chain: cc.label,
    baseSymbol: d.baseSymbol,
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('Detail', `detail:${rec.tokenId}`),
        Markup.button.callback('🔄 Refresh', `back:card:${rec.tokenId}`),
      ],
      [Markup.button.callback('⛔ Tutup', `stop:${rec.tokenId}`)], // aksi uang: baris sendiri
    ]),
  };
  return { text, extra };
}

/** Kartu ringkas satu posisi + tombol Tutup/Detail. */
async function renderPositionCard(ctx: any, rec: store.PosRecord, edit: boolean) {
  const { text, extra } = await buildPositionCard(rec);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

/** Tampilan detail (komposisi, nilai, fee). */
async function renderPositionDetail(ctx: any, rec: store.PosRecord, edit: boolean) {
  const cc = getChain(rec.chain);
  const d = await getPositionDetail(rec.tokenId, cc);
  const valF = Number(ethers.formatUnits(d.valueBaseWei, d.baseDecimals));
  const feeF = Number(ethers.formatUnits(d.feesBaseWei, d.baseDecimals));
  const valUsd = await baseToUsd(d.baseKind, valF, cc);
  const feeUsd = await baseToUsd(d.baseKind, feeF, cc);
  const value =
    `${msg.cleanUnits(d.valueBaseWei, d.baseDecimals)} ${d.baseSymbol}` +
    (valUsd !== null ? ` (${msg.usdPlain(valUsd)})` : '');
  const fees =
    `${msg.cleanUnits(d.feesBaseWei, d.baseDecimals)} ${d.baseSymbol}` +
    (feeUsd !== null ? ` (${msg.usdPlain(feeUsd)})` : '');
  const composition =
    `${msg.cleanUnits(d.baseAmountWei, d.baseDecimals)} ${d.baseSymbol} + ${msg.cleanUnits(d.otherAmountWei, d.otherDecimals)} ${d.otherSymbol}`;
  const text = msg.msgPositionDetail({
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    fee: rec.fee,
    composition,
    value,
    fees,
    inRange: d.inRange,
    chain: cc.label,
    baseSymbol: d.baseSymbol,
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('Kembali', `back:card:${rec.tokenId}`),
        Markup.button.callback('Refresh', `detail:${rec.tokenId}`),
      ],
    ]),
  };
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

/**
 * Tutup posisi: tulis history ke JURNAL (file khusus), lalu keluarkan dari
 * store live. Pengecualian: bila masih ada token sisa yang gagal ter-swap
 * (`keep`), record ditahan sebagai STOPPED agar sweep di monitor bisa
 * memulihkannya. Dengan begitu /positions bersih (hanya live) & history ada di
 * /history.
 */
function finalizeClose(
  tokenId: string,
  opts: { resultEthWei?: bigint; reason: journal.JournalEntry['reason']; keep?: boolean },
) {
  // Posisi yang sedang ditutup jalur manual: hanya jalur itu ('cashed') yang boleh
  // menjurnalkan — dia yang memegang angka hasil. Render/sync yang kebetulan
  // melihat NFT sudah hilang ('gone') tak boleh mendahuluinya (PnL jadi 0 permanen).
  if (opts.reason !== 'cashed' && closingInFlight.has(tokenId)) return;
  const rec = store.get(tokenId);
  // Jurnalkan sekali saja (saat transisi dari ACTIVE) — hindari duplikat bila
  // tombol tutup ditekan ulang pada posisi yang sudah tertutup.
  if (rec && rec.status === 'ACTIVE') journal.recordClose(rec, opts);
  if (opts.keep) {
    store.update(tokenId, {
      status: 'STOPPED',
      stoppedAt: Date.now(),
      ...(opts.resultEthWei !== undefined ? { resultEthWei: opts.resultEthWei.toString() } : {}),
    });
  } else {
    store.remove(tokenId);
  }
}

/** Kartu detail satu posisi v4 (nilai + range% + PnL bila dikelola bot) + tombol. */
function buildV4Card(p: V4Position, ethUsdV4: number | null): { text: string; extra: Record<string, unknown> } {
  const feeLabel = p.dynamicFee ? 'dynamic' : `${(p.fee / 10000).toFixed(p.fee % 100 ? 2 : 0)}%`;
  const dec = p.base === 'USDG' ? 6 : 18;
  let valueLabel = '—';
  if (p.valueBaseWei !== null && p.base === 'ETH') {
    const eth = Number(ethers.formatEther(p.valueBaseWei));
    valueLabel = ethUsdV4 !== null ? `${msg.usdPlain(eth * ethUsdV4)}  (${eth.toFixed(5)} ETH)` : `${eth.toFixed(5)} ETH`;
  } else if (p.valueBaseWei !== null && p.base === 'USDG') {
    valueLabel = `${Number(ethers.formatUnits(p.valueBaseWei, 6)).toFixed(2)} USDG`;
  }
  const rangeLabel =
    p.rangePctHigh !== null && p.rangePctLow !== null ? `${msg.fmtPct(p.rangePctHigh)} / ${msg.fmtPct(p.rangePctLow)}` : '—';
  const tracked = v4store.getV4(p.tokenId);
  let pnlText: string | undefined;
  if (tracked && p.valueBaseWei !== null && p.base) {
    const curF = Number(ethers.formatUnits(p.valueBaseWei, dec));
    const entF = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
    const pnlF = curF - entF;
    const pct = entF > 0 ? (pnlF / entF) * 100 : 0;
    pnlText =
      p.base === 'ETH' && ethUsdV4 !== null
        ? `${msg.usdSigned(pnlF * ethUsdV4)} (${msg.fmtPct(pct)})`
        : `${pnlF >= 0 ? '+' : ''}${pnlF.toFixed(dec >= 18 ? 5 : 2)} ${p.base} (${msg.fmtPct(pct)})`;
  }
  const text = msg.msgV4Position({
    tokenId: p.tokenId,
    pair: `${p.sym0} / ${p.sym1}`,
    feeLabel,
    valueLabel,
    rangeLabel,
    inRange: p.inRange,
    pnlText,
    tracked: !!tracked,
  });
  // Tombol "➕ <size> ETH" dihapus: jalur uang tanpa screening/preview/cap dengan
  // rentang default ~170% yang tak pernah ditampilkan. Tambah modal lewat /add.
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', `posv4:${p.tokenId}`), Markup.button.callback('‹ Posisi', 'positions_refresh')],
      [Markup.button.callback('⛔ Tutup Posisi v4', `closev4:${p.tokenId}`)],
    ]),
  };
  return { text, extra };
}

type PosRow = {
  id: string;
  pair: string;
  investLabel: string;
  age: string;
  pnlUsd: number | null;
  pnlPct: number | null;
  inRange: boolean;
  wethEq: number; // setara-WETH utk total invest (USDG→WETH via ethUsd)
};

// /positions — SATU pesan konsolidasi: ringkasan + pohon per-posisi (v3 + v4).
async function cmdPositions(ctx: any, edit = false) {
  const cc = getChain();
  const active = store.active();
  const v4 = v4Supported(cc) ? await listPositionsV4(cc).catch(() => []) : [];
  if (active.length === 0 && v4.length === 0) {
    const t = msg.msgNoPositions();
    return edit ? ctx.editMessageText(t, html).catch(() => {}) : ctx.reply(t, html);
  }
  const ethUsd = await getEthUsd(cc.wethAddress, cc).catch(() => null);

  // v3 (RPC paralel, urutan stabil). Posisi hilang (NFT burned) → finalize & buang.
  const v3rows = await mapLimit(active, POS_CARD_CONCURRENCY, async (rec): Promise<PosRow | null> => {
    try {
      const d = await getPositionDetail(rec.tokenId, getChain(rec.chain));
      const dec = d.baseDecimals;
      const curF = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
      const initF = rec.imported ? null : Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
      let pnlUsd: number | null = null;
      let pnlPct: number | null = null;
      if (initF !== null && initF > 0) {
        const pnlF = curF - initF;
        pnlPct = (pnlF / initF) * 100;
        pnlUsd = await baseToUsd(d.baseKind, pnlF, cc);
      }
      const investNum = initF ?? curF;
      return {
        id: rec.tokenId,
        pair: `${d.baseSymbol}/${rec.symbol}`,
        investLabel: `${investNum.toFixed(dec >= 18 ? 4 : 2)} ${d.baseSymbol}`,
        age: msg.fmtAge(Date.now() - rec.openedAt),
        pnlUsd,
        pnlPct,
        inRange: d.inRange,
        wethEq: d.baseKind === 'weth' ? investNum : ethUsd ? investNum / ethUsd : 0,
      };
    } catch (e) {
      if (isGoneErr(e)) {
        finalizeClose(rec.tokenId, { reason: 'gone' });
        return null;
      }
      return {
        id: rec.tokenId,
        pair: `#${rec.tokenId}`,
        investLabel: 'baca gagal',
        age: '—',
        pnlUsd: null,
        pnlPct: null,
        inRange: false,
        wethEq: 0,
      };
    }
  });

  const rows: PosRow[] = v3rows.filter((r): r is PosRow => r !== null);

  // v4 (baca-saja + PnL bila dikelola bot).
  for (const p of v4) {
    const dec = p.base === 'USDG' ? 6 : 18;
    const tracked = v4store.getV4(p.tokenId);
    const curF = p.valueBaseWei !== null ? Number(ethers.formatUnits(p.valueBaseWei, dec)) : null;
    let investNum = curF ?? 0;
    let pnlUsd: number | null = null;
    let pnlPct: number | null = null;
    if (tracked) {
      const entF = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
      investNum = entF;
      if (curF !== null && entF > 0) {
        const pnlF = curF - entF;
        pnlPct = (pnlF / entF) * 100;
        pnlUsd = p.base === 'ETH' ? (ethUsd !== null ? pnlF * ethUsd : null) : pnlF; // USDG ≈ $1
      }
    }
    const sym = p.base === 'USDG' ? 'USDG' : 'ETH';
    rows.push({
      id: p.tokenId,
      pair: `${p.sym0}/${p.sym1}`,
      investLabel: `${investNum.toFixed(dec >= 18 ? 4 : 2)} ${sym} · v4`,
      age: tracked ? msg.fmtAge(Date.now() - tracked.openedAt) : '—',
      pnlUsd,
      pnlPct,
      inRange: p.inRange ?? false, // null (tak diketahui) → dianggap out (konservatif)
      wethEq: p.base === 'USDG' ? (ethUsd ? investNum / ethUsd : 0) : investNum,
    });
  }

  const totalWethEq = rows.reduce((s, r) => s + r.wethEq, 0);
  const pnlVals = rows.map((r) => r.pnlUsd).filter((x): x is number => x !== null);
  const totalPnlUsd = pnlVals.length ? pnlVals.reduce((a, b) => a + b, 0) : null;
  const text = msg.msgPositionsList({
    dryRun: config.safety.dryRun,
    activeCount: rows.length,
    totalInvestLabel: `≈ ${totalWethEq.toFixed(4)} WETH`,
    totalPnlUsd,
    outOfRange: rows.filter((r) => !r.inRange).length,
    rows,
  });

  // Maks 6 tombol id (posisi ke-7+ tetap tercantum di daftar & bisa lewat /stop).
  // Label = pair LENGKAP. v4 menulis 'WETH / PONS' (berspasi) — dirapatkan supaya
  // tombol tak melebar, dan dipotong bila simbol tokennya panjang.
  const labelOf = (pair: string): string => {
    const s = pair
      .split('/')
      .map((p) => p.trim())
      .join('/');
    return s.length > 20 ? s.slice(0, 19) + '…' : s;
  };
  const top = rows.slice(0, 6);
  const names = top.map((r) => labelOf(r.pair));
  // Dua posisi token sama → tombolnya kembar dan tak bisa dibedakan. Yang kembar saja diberi #id.
  const dup = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const idBtns = top.map((r, i) =>
    Markup.button.callback(dup.has(names[i]) ? `${names[i]} #${r.id}` : names[i], `pos_detail_${r.id}`),
  );
  const kbRows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < idBtns.length; i += 2) kbRows.push(idBtns.slice(i, i + 2));
  kbRows.push([
    Markup.button.callback('‹ Kembali', 'positions_back'),
    Markup.button.callback('🔄 Refresh', 'positions_refresh'),
  ]);
  kbRows.push([Markup.button.callback('⛔ Tutup Semua', 'closeall_confirm')]);
  const extra = { ...html, ...Markup.inlineKeyboard(kbRows) };
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}
bot.command('positions', (ctx) => cmdPositions(ctx, false));

// Kembali dari daftar posisi → kartu menu, EDIT pesan yang sama (tak menumpuk bubble baru).
bot.action('positions_back', async (ctx) => {
  await ctx.answerCbQuery();
  const extra = { ...html, ...helpKeyboard() };
  try {
    return await ctx.editMessageText(msg.msgHelp(config.safety.dryRun), extra);
  } catch {
    return ctx.reply(msg.msgHelp(config.safety.dryRun), extra); // pesan terlalu tua untuk diedit
  }
});

// Refresh daftar posisi (edit pesan yang sama).
bot.action('positions_refresh', async (ctx) => {
  await ctx.answerCbQuery('Memuat ulang…');
  try {
    await cmdPositions(ctx, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — benign
    await ctx.reply(msg.msgError('positions', (e as Error).message), html);
  }
});

// Detail satu posisi (dari tombol #id di daftar) — kartu penuh v3 atau v4.
bot.action(/^pos_detail_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery('Memuat…');
  const rec = store.get(id);
  if (rec) {
    try {
      const c = await buildPositionCard(rec);
      return ctx.reply(c.text, c.extra);
    } catch (e) {
      return ctx.reply(msg.msgError('detail', (e as Error).message), html);
    }
  }
  try {
    const cc = getChain();
    const p = (await listPositionsV4(cc).catch(() => [])).find((x) => x.tokenId === id);
    if (!p) return ctx.reply(msg.msgError('detail', 'posisi tak ditemukan.'), html);
    const ethUsdV4 = p.base === 'ETH' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : null;
    const c = buildV4Card(p, ethUsdV4);
    return ctx.reply(c.text, c.extra);
  } catch (e) {
    return ctx.reply(msg.msgError('detail', (e as Error).message), html);
  }
});

// /history — riwayat trade tertutup, dari file jurnal khusus (tak muncul di /positions).
function cmdHistory(ctx: any) {
  const total = journal.lifetimeStats().count;
  const items = journal.read(8).map((e) => ({
    tokenId: e.tokenId,
    symbol: e.symbol,
    pnlPct: e.pnlPct,
    pnlEth: e.pnlEth,
    reason: e.reason,
    ca: e.ca,
    chain: e.chain,
    closedAt: e.closedAt,
  }));
  return ctx.reply(msg.msgJournal(items, total), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('🧾 Rekap PnL', 'pnl'), Markup.button.callback('📋 Posisi', 'positions')]]),
  });
}
bot.command('history', cmdHistory);

// /pnl — rekap PnL seumur hidup (agregasi jurnal).
function cmdPnl(ctx: any) {
  const s = journal.lifetimeStats();
  return ctx.reply(
    msg.msgPnl({
      dryRun: config.safety.dryRun,
      known: s.known,
      excluded: s.excluded,
      wins: s.wins,
      losses: s.losses,
      netEth: s.netEth,
      grossWin: s.grossWin,
      grossLoss: s.grossLoss,
      best: s.best,
      worst: s.worst,
      count: s.count,
    }),
    {
      ...html,
      ...Markup.inlineKeyboard([[Markup.button.callback('📜 Riwayat', 'history'), Markup.button.callback('📋 Posisi', 'positions')]]),
    },
  );
}
bot.command('pnl', cmdPnl);


// /explore — top 5 pool by APR (single-sided ETH/USDG), sinkron REAL-TIME Uniswap.
// Kartu EXPLORE dulu buntu: hanya Refresh, sementara CA-nya tak dibawa ke mana pun.
const exploreKb = (pools: explore.ExplorePool[]) =>
  Markup.inlineKeyboard([
    ...pools
      .filter((p) => p.otherAddr)
      .slice(0, 3)
      .map((p) => [Markup.button.callback(`➕ LP ${p.pair.split('/')[0]}`, `x:${p.otherAddr}`)]),
    [Markup.button.callback('🔄 Refresh', 'explore:refresh')],
  ]);

async function loadExplore(): Promise<{ text: string; pools: explore.ExplorePool[] }> {
  const cc = getChain();
  const pools = await explore.fetchTopPools(cc, 5);
  return { text: explore.renderExplore(pools, cc.label), pools };
}

// Tombol pool → wizard /add penuh (screening & preview tetap jalan).
bot.action(/^x:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  resetFlows(ctx.from!.id);
  return continueAddlp(ctx, ctx.match[1], getChain().key, null);
});

async function cmdExplore(ctx: any) {
  const loading = await ctx.reply('📈 memuat pool teratas dari Uniswap…');
  try {
    const { text, pools } = await loadExplore();
    await ctx.telegram.editMessageText(loading.chat.id, loading.message_id, undefined, text, {
      ...html,
      ...exploreKb(pools),
    });
  } catch (e) {
    await ctx.telegram.editMessageText(
      loading.chat.id,
      loading.message_id,
      undefined,
      msg.msgError('explore', (e as Error).message),
      html,
    );
  }
}
bot.command('explore', cmdExplore);

bot.action('explore:refresh', async (ctx) => {
  await ctx.answerCbQuery('Memuat…');
  try {
    const { text, pools } = await loadExplore();
    await ctx.editMessageText(text, { ...html, ...exploreKb(pools) });
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — bukan error
    await ctx.reply(msg.msgError('explore', (e as Error).message), html);
  }
});

bot.action(/^detail:(\d+)$/, async (ctx) => {
  const rec = store.get(ctx.match[1]);
  if (!rec) return ctx.answerCbQuery('Posisi tak ditemukan.');
  await ctx.answerCbQuery('Memuat…');
  try {
    await renderPositionDetail(ctx, rec, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — bukan error
    await ctx.reply(msg.msgError('detail', (e as Error).message), html);
  }
});

bot.action(/^back:card:(\d+)$/, async (ctx) => {
  const rec = store.get(ctx.match[1]);
  if (!rec) return ctx.answerCbQuery('Posisi tak ditemukan.');
  await ctx.answerCbQuery('Memuat…');
  try {
    await renderPositionCard(ctx, rec, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — bukan error
    await ctx.reply(msg.msgError('card', (e as Error).message), html);
  }
});

// ---------- Fase 3: tulis (wizard /add bertahap) ----------

/** Keyboard pilih pool: pasangan (WETH/USDG) · fee · kedalaman. Callback bawa base. */
const POOL_PICK_MAX = 8; // batas tombol keyboard (sisanya debu)

// tickSpacing pool: v4 langsung; v3 dipetakan dari fee tier standar.
function poolSpacing(p: explore.TokenPool): number {
  if (p.poolKey?.tickSpacing) return p.poolKey.tickSpacing;
  const m: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
  return m[p.fee] ?? 60;
}
// Seberapa dekat harga harus bergerak sebelum single-side MULAI terisi — tepi
// range wajib kelipatan tickSpacing, worst-case ≈ 1 spacing. Makin kecil, makin cepat isi.
function fillTightnessPct(p: explore.TokenPool): number {
  return (Math.pow(1.0001, poolSpacing(p)) - 1) * 100;
}
// Ranking utk single-side fill: dahulukan likuiditas se-orde (tier log10 TVL) —
// biar tak nyangkut ke pool debu — lalu pilih spacing PALING HALUS (isi paling rapat).
function rankPoolsForFill(pools: explore.TokenPool[]): explore.TokenPool[] {
  const tier = (tvl: number) => (tvl > 0 ? Math.floor(Math.log10(tvl)) : -1);
  return [...pools].sort((a, b) => {
    const t = tier(b.tvlUsd) - tier(a.tvlUsd);
    if (t) return t;
    const s = poolSpacing(a) - poolSpacing(b); // spacing halus dulu
    if (s) return s;
    return b.tvlUsd - a.tvlUsd;
  });
}

function poolKeyboard(pools: explore.TokenPool[]) {
  return Markup.inlineKeyboard([
    ...pools.slice(0, POOL_PICK_MAX).map((p, i) => {
      const t = fillTightnessPct(p);
      const tight = `isi≤${t < 1 ? t.toFixed(1) : Math.round(t)}%`;
      return [
        Markup.button.callback(
          `${p.otherSymbol}/${p.baseSymbol} · ${p.protocol} · ${msg.feeLabel(p.fee)} · ${msg.usdCompact(p.tvlUsd)} · ${tight}`,
          `pick:${i}`,
        ),
      ];
    }),
    [Markup.button.callback('Batal', 'cancel')],
  ]);
}

/**
 * Fallback discovery: gateway Uniswap down → pakai factory v3 on-chain (aman,
 * tetap bisa buka posisi). Petakan PoolOption v3 → TokenPool (TVL≈baseReserve USD).
 */
async function discoverAllPoolsFallback(token: string, cc: ChainCtx): Promise<explore.TokenPool[]> {
  const [raw, eu, otherSymbol] = await Promise.all([
    discoverAllPools(token, cc).then((ps) => ps.filter((p) => p.baseReserve > 0n)),
    getEthUsd(cc.wethAddress, cc).catch(() => null),
    new ethers.Contract(token, ERC20_ABI, cc.provider).symbol().catch(() => '?') as Promise<string>,
  ]);
  const mapped: explore.TokenPool[] = raw.map((p) => {
    const amt = Number(ethers.formatUnits(p.baseReserve, p.baseDecimals));
    const tvlUsd = p.base === 'usdg' ? amt : eu !== null ? amt * eu : amt;
    return { protocol: 'v3', base: p.base, baseSymbol: p.baseSymbol, otherSymbol, fee: p.fee, tvlUsd };
  });
  mapped.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return mapped;
}

/** Langkah 1/4 — pilih pool (pasangan + fee tier). */
async function renderPoolStep(ctx: any, flow: AddFlow, edit: boolean) {
  const text = msg.msgPoolStep();
  const extra = { ...html, ...poolKeyboard(flow.pools) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 2/4 — pilih lebar rentang (%). */
async function renderRangeStep(ctx: any, flow: AddFlow, edit: boolean) {
  const rows = RANGE_OPTIONS.map((o) => [
    Markup.button.callback(`${o.pct}%  ·  ${o.label}`, `rng:${o.pct}`),
  ]);
  rows.push([
    Markup.button.callback('Kembali', 'back:pool'),
    Markup.button.callback('Batal', 'cancel'),
  ]);
  const text = msg.msgRangeStep(flow.fee!);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 3/4 — pilih nominal ETH. */
/** Base asset yang dipilih di wizard (weth/usdg/usdt). */
const wizardBase = (flow: AddFlow): BaseAsset => baseOf(getChain(flow.chain), flow.base ?? 'weth');

/** Konteks nominal base-aware: preset (dari /size per-aset), simbol, batas, contoh. */
function amountCtx(flow: AddFlow) {
  const base = wizardBase(flow);
  const stable = isStableBase(base.kind);
  return {
    symbol: base.symbol,
    presets: stable ? store.getSizes('stable') : store.getSizes('eth').filter((a) => a <= maxEth),
    cap: stable ? Infinity : maxEth, // batas ETH hanya berlaku utk base WETH
    capLabel: stable ? 'tanpa batas' : maxEthLabel,
    example: stable ? '50' : '0.02',
  };
}

async function renderAmountStep(ctx: any, flow: AddFlow, edit: boolean) {
  flow.awaitingAmount = false;
  const a = amountCtx(flow);
  const rows: any[] = [];
  for (let i = 0; i < a.presets.length; i += 2) {
    rows.push(a.presets.slice(i, i + 2).map((p) => Markup.button.callback(`${p} ${a.symbol}`, `amt:${p}`)));
  }
  rows.push([Markup.button.callback('Ketik nominal', 'amt:custom')]);
  // v4 lewati step rentang → "Kembali" ke pemilihan pool; v3 kembali ke rentang.
  const backTo = 'back:range'; // v3 & v4 sama-sama lewat step range
  rows.push([
    Markup.button.callback('Kembali', backTo),
    Markup.button.callback('Batal', 'cancel'),
  ]);
  // Saldo base (1 RPC, gagal → '?': jangan pernah memblokir langkah ini).
  const cc = getChain(flow.chain);
  const base = wizardBase(flow);
  const balLabel = await (base.wrappable
    ? cc.provider.getBalance(cc.wallet.address).then((b) => `${msg.cleanUnits(b, 18)} ${cc.nativeSymbol}`)
    : new ethers.Contract(base.address, ERC20_ABI, cc.provider)
        .balanceOf(cc.wallet.address)
        .then((b: bigint) => `${msg.cleanUnits(b, base.decimals)} ${base.symbol}`)
  ).catch(() => '?');
  const text = msg.msgAmountStep(a.symbol, a.capLabel, balLabel);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 4/4 — hitung & tampilkan rencana + konfirmasi. */
async function renderPlanStep(ctx: any, flow: AddFlow, edit: boolean) {
  if (flow.selected?.protocol === 'v4') return renderPlanStepV4(ctx, flow, edit);
  const cc = getChain(flow.chain);
  const base = baseOf(cc, flow.base ?? 'weth');
  // plan + estimasi biaya paralel (saling independen).
  const [planSettled, costSettled] = await Promise.allSettled([
    planAddSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc),
    estimateAddCost(cc, base, flow.ethAmount!),
  ]);
  if (planSettled.status === 'rejected') throw planSettled.reason;
  const plan = planSettled.value;
  flow.plan = plan;
  let cost: Awaited<ReturnType<typeof estimateAddCost>> | null = null;
  if (costSettled.status === 'fulfilled') cost = costSettled.value;
  else console.log('[estimateAddCost] gagal:', String(costSettled.reason).slice(0, 120));
  const depositUsd = (await baseToUsd(base.kind, Number(flow.ethAmount!), cc)) ?? undefined;
  const text = msg.msgPlanStep({
    screenDanger: flow.screenBahaya,
    screenFailed: flow.screenFailed,
    baseSymbol: plan.baseSymbol,
    symbol: plan.otherSymbol,
    fee: flow.fee!,
    depositAmount: flow.ethAmount!,
    depositUsd,
    pctHigh: plan.pctHigh,
    pctLow: plan.pctLow,
    currentPrice: String(plan.currentPrice),
    gasEth: cost?.gasEth ?? '?',
    needLabel: cost?.needLabel ?? '?',
    balanceLabel: cost?.balanceLabel ?? '?',
    shortLabel: cost?.shortLabel ?? null,
    costFailed: cost === null,
    dryRun: config.safety.dryRun,
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🟢 Konfirmasi', 'addok')],
      [
        Markup.button.callback('Ubah Nominal', 'back:amount'),
        Markup.button.callback('Batal', 'cancel'),
      ],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

// Petakan lebar rentang (persen PENURUNAN harga token) → jumlah tick-spacing utk
// posisi v4 single-sided. Ujung terjauh = harga turun tepat X% → faktor 1-X/100 →
// widthTicks = |ln(1-X/100)|/ln(1.0001). Sama dgn widthInTicks v3 (konsisten).
// Dibulatkan KELUAR (ceil) supaya rentang minimal menutup X% yang diminta.
function rangePctToSpacings(pct: number, tickSpacing: number): number {
  const frac = Math.min(Math.max(pct, 0.1), 95) / 100;
  const widthTicks = Math.abs(Math.log(1 - frac)) / Math.log(1.0001);
  return Math.max(1, Math.ceil(widthTicks / tickSpacing));
}

/** Nominal base v4 dalam wei sesuai desimal base (ETH 18-dec / USDG 6-dec). */
const v4AmountWei = (flow: AddFlow): bigint =>
  ethers.parseUnits(flow.ethAmount!, wizardBase(flow).decimals);

/** Langkah 4/4 versi v4 — dry-run staticCall utk validasi + preview rentang. */
async function renderPlanStepV4(ctx: any, flow: AddFlow, edit: boolean) {
  const cc = getChain(flow.chain);
  const pool = flow.selected!;
  const pk = pool.poolKey!;
  const amountWei = v4AmountWei(flow);
  const widthSpacings = rangePctToSpacings(flow.rangePct!, pk.tickSpacing);
  // Dry-run selalu (walau mode live) → staticCall memvalidasi mint sebelum konfirmasi.
  const sim = await openPositionV4(cc, pk, pool.baseIsCurrency0!, amountWei, { widthSpacings, dryRun: true });
  const val = await valuePositionV4(cc, pk, sim.tickLower, sim.tickUpper, sim.liquidity);
  const depositUsd = (await baseToUsd(wizardBase(flow).kind, Number(flow.ethAmount!), cc)) ?? undefined;
  const text = msg.msgPlanStepV4({
    screenDanger: flow.screenBahaya,
    screenFailed: flow.screenFailed,
    baseSymbol: pool.baseSymbol,
    symbol: pool.otherSymbol,
    fee: pool.fee,
    tvlUsd: pool.tvlUsd,
    depositAmount: flow.ethAmount!,
    depositUsd,
    rangePctHigh: val.rangePctHigh,
    rangePctLow: val.rangePctLow,
    dryRun: config.safety.dryRun,
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🟢 Konfirmasi', 'addok')],
      [
        Markup.button.callback('Ubah Nominal', 'back:amount'),
        Markup.button.callback('Batal', 'cancel'),
      ],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/**
 * Lanjutan /add setelah chain diketahui: screening → pool → wizard.
 * `prog` = bubble progress yang di-edit (kurangi spam chat).
 */
async function continueAddlp(
  ctx: any,
  token: string,
  chainKey: string,
  prog?: { message_id: number } | null,
  pre?: { bahaya: boolean; failed: boolean }, // screening sudah dilakukan hub → jangan ulang
) {
  const cc = getChain(chainKey);

  // 1+2) Screening & pencarian pool saling independen → jalankan PARALEL
  // (dulu serial: 4 HTTP + ~18 RPC, lalu GraphQL — worst case ~30 dtk sebelum kartu 1/4).
  // Urutan tampilan dipertahankan: kartu SCREEN dulu, baru kartu 1/4.
  prog = await editProgress(
    ctx,
    prog,
    msg.msgProgress(pre ? 'mencari pool…' : `menyaring token & mencari pool di ${cc.label}…`),
  );
  const [screened, found] = await Promise.allSettled([
    pre ? Promise.resolve(null) : screenToken(token, cc),
    explore.poolsForToken(cc, token),
  ]);

  let screenBahaya = pre?.bahaya ?? false;
  let screenFailed = pre?.failed ?? false;
  if (!pre) {
    if (screened.status === 'fulfilled' && screened.value) {
      screenBahaya = screened.value.verdict === 'BAHAYA';
      await ctx.reply(formatScreen(screened.value), html); // kartu screen = pesan terpisah
    } else {
      screenFailed = true; // gagal verifikasi → peringatan dibawa ke preview rencana
      await ctx.reply(msg.msgScreeningFailed(), html);
    }
  }

  let pools: explore.TokenPool[];
  if (found.status === 'fulfilled') {
    pools = found.value;
  } else {
    console.log('[poolsForToken] gateway gagal, fallback v3 on-chain:', String(found.reason).slice(0, 120));
    pools = await discoverAllPoolsFallback(token, cc).catch(() => []);
  }
  // Fee tier non-standar diterima gateway tapi ditolak loadPool → dead-end 3 tap.
  pools = pools.filter((p) => p.protocol === 'v4' || VALID_FEES.includes(p.fee));
  if (pools.length === 0) {
    await editProgress(ctx, prog, msg.msgNoPools());
    return;
  }
  // Bias ke spacing halus (isi rapat) di antara pool likuiditas se-orde.
  pools = rankPoolsForFill(pools);

  // 3) Mulai wizard — reuse bubble progress jadi step pilih pool.
  const flow: AddFlow = { token, chain: chainKey, screenBahaya, screenFailed, pools, startedAt: Date.now() };
  flows.set(ctx.from.id, flow);
  await editProgress(ctx, prog, msg.msgPoolStep(), { ...html, ...poolKeyboard(pools) });
}

// Simpan token yang menunggu pilihan chain.

bot.command('add', async (ctx) => {
  resetFlows(ctx.from!.id); // alur baru = buang sisa alur lama (anti-hijack ketikan)
  const [, token] = ctx.message.text.trim().split(/\s+/);
  if (!token) return ctx.reply(msg.msgAddlpUsage(), html);
  if (!ethers.isAddress(token)) return ctx.reply(msg.msgInvalidAddress(), html);

  // 0) Deteksi chain — 1 bubble progress (di-edit di langkah berikutnya).
  const prog = await ctx.reply(msg.msgProgress('mendeteksi chain…'), html);
  const found = await detectChains(token);
  if (found.length === 0) {
    return editProgress(
      ctx,
      prog,
      msg.msgError(
        'chain',
        `Token tidak ditemukan di chain mana pun (${Object.values(CHAINS)
          .map((c) => c.label)
          .join('/')}).`,
      ),
    );
  }
  if (found.length === 1) return continueAddlp(ctx, token, found[0].key, prog);

  // Token ada di beberapa chain → ganti progress jadi pemilih chain.
  // Token dibawa DI callback (bukan Map global): dulu `/add A` lalu `/add B`
  // membuat tombol kartu A memproses token B.
  await editProgress(ctx, prog, msg.msgChainPick(), {
    ...html,
    ...Markup.inlineKeyboard([
      ...found.map((c) => [Markup.button.callback(c.label, `chn:${c.key}:${token}`)]),
      [Markup.button.callback('Batal', 'cancel')],
    ]),
  });
});

bot.action(/^chn:(\w+):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const token = ctx.match[2];
  await ctx.answerCbQuery();
  // Lanjut screening; reuse pesan chain-pick sebagai progress.
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  await continueAddlp(ctx, token, ctx.match[1], prog);
});

// --- Navigasi wizard (maju & mundur) ---
const getFlow = (ctx: any): AddFlow | undefined => flows.get(ctx.from!.id);

bot.action(/^pick:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  const sel = flow.pools[Number(ctx.match[1])];
  if (!sel) return ctx.answerCbQuery('Pilihan tak valid, ulangi /add.');
  // v4: dukung base ETH-native & USDG. WETH-wrapped (bukan native) di-skip —
  // wallet pegang ETH native (bukan WETH), jadi tak bisa mendanai.
  if (sel.protocol === 'v4') {
    const pk = sel.poolKey!;
    const baseCur = sel.baseIsCurrency0 ? pk.currency0 : pk.currency1;
    if (sel.base === 'weth' && baseCur !== ethers.ZeroAddress) {
      await ctx.answerCbQuery();
      return ctx.reply(msg.msgV4BaseUnsupported(), html);
    }
  }
  flow.selected = sel;
  flow.base = sel.base;
  flow.fee = sel.fee;
  flow.plan = undefined;
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
  await ctx.answerCbQuery();
  // v3 & v4 sama-sama pilih range dulu (v4: % dipetakan ke lebar tick).
  await renderRangeStep(ctx, flow, true);
});

bot.action(/^rng:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  flow.rangePct = Number(ctx.match[1]);
  flow.ethAmount = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

bot.action(/^amt:(.+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined || flow.rangePct === undefined)
    return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  const a = amountCtx(flow);
  const v = ctx.match[1];
  if (v === 'custom') {
    flow.awaitingAmount = true;
    await ctx.answerCbQuery();
    await ctx.editMessageText(msg.msgAmountCustom(a.symbol, a.capLabel, a.example), html);
    return;
  }
  const num = Number(v);
  if (!(num > 0) || num > a.cap) return ctx.answerCbQuery('Nominal tidak valid.');
  flow.ethAmount = v;
  await ctx.answerCbQuery('Menghitung preview…');
  try {
    await renderPlanStep(ctx, flow, true);
  } catch (err) {
    await ctx.reply(msg.msgError('plan', (err as Error).message), html);
  }
});

bot.action('back:pool', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  flow.selected = undefined;
  flow.base = undefined;
  flow.fee = undefined;
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderPoolStep(ctx, flow, true);
});

bot.action('back:range', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  flow.rangePct = undefined;
  flow.ethAmount = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderRangeStep(ctx, flow, true);
});

bot.action('back:amount', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  flow.ethAmount = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

bot.action('addok', async (ctx) => {
  const flow = getFlow(ctx);
  // --- Jalur v4 (buka posisi single-sided ETH di pool v4) ---
  if (flow?.selected?.protocol === 'v4') {
    if (!flow.ethAmount || flow.rangePct === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
    const { selected, ethAmount, chain, rangePct } = flow;
    flows.delete(ctx.from!.id); // idempotency: double-tap tak buka dobel
    await ctx.answerCbQuery('Diproses…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    try {
      await ctx.editMessageText(msg.msgOpeningLp(), html);
      const cc = getChain(chain);
      const pk = selected.poolKey!;
      const base = baseOf(cc, selected.base); // 'weth'→ETH-native / 'usdg'→USDG
      const amountWei = ethers.parseUnits(ethAmount, base.decimals);
      const widthSpacings = rangePctToSpacings(rangePct, pk.tickSpacing);
      const r = await openPositionV4(cc, pk, selected.baseIsCurrency0!, amountWei, { widthSpacings, dryRun: false });
      if (r.tokenId) {
        v4store.trackV4({
          tokenId: r.tokenId,
          chain: cc.key,
          currency0: pk.currency0,
          currency1: pk.currency1,
          fee: pk.fee,
          tickSpacing: pk.tickSpacing,
          hooks: pk.hooks,
          base: selected.base === 'usdg' ? 'USDG' : 'ETH',
          baseIsCurrency0: r.baseIsCurrency0,
          entryBaseWei: amountWei.toString(),
        });
      }
      await ctx.editMessageText(
        msg.msgV4Added({
          tokenId: r.tokenId,
          sizeEth: `${ethAmount} ${base.symbol}`,
          rangeLabel: `single-sided ${base.symbol} · rentang ~${rangePct}%`,
          txHash: r.txHash,
          dryRun: false,
        }),
        html,
      );
    } catch (err) {
      await ctx.reply(msg.msgError('add v4', (err as Error).message), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  if (!flow?.plan || flow.fee === undefined || !flow.ethAmount || flow.rangePct === undefined)
    return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  // Idempotency: hapus flow SEBELUM eksekusi (sinkron, sebelum await pertama) →
  // double-tap tombol Konfirmasi tak bisa membuka posisi dobel (dobel ETH).
  // Gagal open → flow sudah hilang, user ulangi /add (aman).
  flows.delete(ctx.from!.id);
  await ctx.answerCbQuery('Diproses…');
  if (config.safety.dryRun) {
    await ctx.editMessageText(msg.msgDryRunAddDone(), html);
    return;
  }
  store.beginMoneyOp();
  try {
    await ctx.editMessageText(msg.msgOpeningLp(), html);
    // Rencana di kartu PREVIEW dihitung saat kartu dirender. Kalau tombol ditekan
    // jauh kemudian, tick & harga sudah basi → mint revert (gas hangus) atau posisi
    // mendarat di rentang yang tak relevan. Hitung ulang tepat sebelum kirim tx.
    // (Jalur v4 sudah melakukan ini; ini menyamakan v3.)
    const ccAdd = getChain(flow.chain);
    const plan = await planAddSingleSided(
      flow.token,
      flow.fee,
      flow.ethAmount,
      flow.rangePct,
      baseOf(ccAdd, flow.base ?? 'weth'),
      ccAdd,
    );
    const { tokenId, notes } = await executeAdd(plan, flow.token, flow.fee, ccAdd);
    store.add({
      tokenId,
      chain: flow.chain,
      ca: flow.token,
      fee: flow.fee,
      symbol: plan.otherSymbol,
      baseKind: plan.baseKind,
      initialWethWei: plan.baseAmountWei.toString(), // jumlah base (unit base) saat buka
      nominalEth: flow.ethAmount,
      rangeLowPct: plan.pctLow,
      rangeHighPct: plan.pctHigh,
      entryPrice: plan.currentPrice, // harga token saat buka → basis alert anjlok
      openedAt: Date.now(),
      status: 'ACTIVE',
      lastInRange: false,
    });
    // Ringkas OPENED di bubble yang sama, lalu kartu posisi live.
    await ctx.editMessageText(msg.msgLpOpened(tokenId, notes), html);
    const rec = store.get(tokenId);
    if (rec) {
      try {
        await renderPositionCard(ctx, rec, false);
      } catch (e) {
        await ctx.reply(msg.msgPositionReadFail(tokenId, (e as Error).message), html);
      }
    }
  } catch (err) {
    await ctx.reply(msg.msgError('add', (err as Error).message), html);
  } finally {
    store.endMoneyOp();
  }
});

/** Konfirmasi tutup posisi (kartu). Eksekusi: remove + collect + cash-out ETH via Relay. */
async function renderStopConfirm(ctx: any, tokenId: string, edit: boolean) {
  const rec = store.get(tokenId);
  const cc = getChain(rec?.chain);
  const d = await getPositionDetail(tokenId, cc);
  const pnlText = await positionPnlText(rec, d, cc);
  const feeF = Number(ethers.formatUnits(d.feesBaseWei, d.baseDecimals));
  const feeUsd = await baseToUsd(d.baseKind, feeF, cc);
  const feeText =
    feeUsd !== null ? msg.usdPlain(feeUsd) : `${msg.cleanUnits(d.feesBaseWei, d.baseDecimals)} ${d.baseSymbol}`;
  const age = rec ? msg.fmtAge(Date.now() - rec.openedAt) : '—';
  const text = msg.msgStopConfirm({
    tokenId,
    symbol: d.otherSymbol,
    fee: d.fee,
    age,
    pnlText,
    feeText,
    baseAmt: msg.cleanUnits(d.baseAmountWei, d.baseDecimals),
    baseSymbol: d.baseSymbol,
    otherAmt: msg.cleanUnits(d.otherAmountWei, d.otherDecimals),
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⛔ Tutup Posisi', `close:${tokenId}`)],
      [
        Markup.button.callback('Kembali', `back:card:${tokenId}`),
        Markup.button.callback('Batal', 'cancel'),
      ],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Kirim kartu posisi aktif (build parallel, send sequential) + header opsional. */
async function replyActiveCards(ctx: any, header: string | null) {
  const active = store.active();
  if (active.length === 0) return ctx.reply(msg.msgNoActiveToStop(), html);
  if (header) await ctx.reply(header, html);
  const cards = await mapLimit(active, POS_CARD_CONCURRENCY, async (rec) => {
    try {
      return await buildPositionCard(rec);
    } catch (e) {
      return {
        text: msg.msgPositionReadFail(rec.tokenId, (e as Error).message),
        extra: html as Record<string, unknown>,
      };
    }
  });
  for (const c of cards) await ctx.reply(c.text, c.extra);
}

async function cmdStop(ctx: any) {
  await replyActiveCards(ctx, msg.msgStopPick());
}
bot.command('stop', cmdStop);

// /closeall — darurat: tutup semua posisi. Konfirmasi per posisi (mekanisme = /stop).
async function cmdCloseAll(ctx: any) {
  // Kartu /positions memperlihatkan posisi v4, jadi tombol "Tutup Semua" yang hanya
  // menampilkan v3 = user mengira sudah bersih padahal v4 masih terbuka.
  const cc = getChain();
  const v4 = v4Supported(cc) ? await listPositionsV4(cc).catch(() => []) : [];
  const v3 = store.active();
  if (v3.length + v4.length === 0) return ctx.reply(msg.msgNoActiveToStop(), html);
  if (v3.length) await replyActiveCards(ctx, msg.msgCloseAllPick(v3.length, v4.length));
  else await ctx.reply(msg.msgCloseAllPick(0, v4.length), html);
  const ethUsd = v4.length ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : null;
  for (const p of v4) {
    const c = buildV4Card(p, ethUsd);
    await ctx.reply(c.text, c.extra);
  }
}
bot.command('closeall', cmdCloseAll);

// ---------- /bridge — cross-chain Robinhood ⇄ Stable via Relay ----------
// topup: Robinhood(ETH/USDG) → USDT@Stable. withdraw: USDT@Stable → Robinhood(ETH/USDG).
type FundDir = 'topup' | 'withdraw';
type FundFlow = { dir: FundDir; asset: 'eth' | 'usdg'; awaitingAmount: boolean; quote?: BridgeQuote; startedAt: number };
const fundFlows = new Map<number, FundFlow>();
const fundInFlight = new Set<number>(); // cegah double-tap Konfirmasi bridge
const QUOTE_TTL_MS = 120_000; // umur maksimum quote bridge sebelum wajib diulang

/** Origin ctx untuk arah bridge (withdraw = Stable, topup = Robinhood). */
const fundOrigin = (dir: FundDir): ChainCtx => (dir === 'withdraw' ? CHAINS.stable : getChain());

async function fundBalanceLabel(dir: FundDir, asset: 'eth' | 'usdg'): Promise<string> {
  try {
    if (dir === 'topup') {
      const o = getChain();
      if (asset === 'eth') {
        const b = await o.provider.getBalance(o.wallet.address);
        return `Saldo ${Number(ethers.formatEther(b)).toFixed(4)} ETH`;
      }
      const uc = new ethers.Contract(o.usdgAddress!, ERC20_ABI, o.provider);
      return `Saldo ${Number(ethers.formatUnits(await uc.balanceOf(o.wallet.address), 6)).toFixed(2)} USDG`;
    }
    const s = CHAINS.stable!;
    const uc = new ethers.Contract(s.usdtAddress!, ERC20_ABI, s.provider);
    return `Saldo ${Number(ethers.formatUnits(await uc.balanceOf(s.wallet.address), 6)).toFixed(2)} USDT`;
  } catch {
    return '';
  }
}

// Tiap langkah /bridge = renderer sendiri + tombol "Kembali" ke langkah sebelumnya.
/**
 * Arah + aset dalam SATU langkah: hanya 2×2 kombinasi, muat di satu papan tombol.
 * callback_data lama (`fundasset:<dir>:<asset>`) dipertahankan → handler tak berubah.
 */
function fundStep(ctx: any, edit: boolean) {
  const origin = getChain();
  const rows = [[Markup.button.callback('⬆️ ETH → USDT', 'fundasset:topup:eth')]];
  if (origin.usdgAddress) rows.push([Markup.button.callback('⬆️ USDG → USDT', 'fundasset:topup:usdg')]);
  rows.push([Markup.button.callback('⬇️ USDT → ETH', 'fundasset:withdraw:eth')]);
  if (origin.usdgAddress) rows.push([Markup.button.callback('⬇️ USDT → USDG', 'fundasset:withdraw:usdg')]);
  rows.push([Markup.button.callback('Batal', 'cancel')]);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  return edit ? ctx.editMessageText(msg.msgFundStart(), extra) : ctx.reply(msg.msgFundStart(), extra);
}
async function fundAmountPrompt(ctx: any, flow: FundFlow, edit: boolean) {
  flow.awaitingAmount = true;
  // Simbol yang diketik: topup = aset sumber; withdraw = USDT (yang dikirim dari Stable).
  const inSym = flow.dir === 'topup' ? (flow.asset === 'eth' ? 'ETH' : 'USDG') : 'USDT';
  const extra = { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('Kembali', 'fundback:asset')]]) };
  const text = msg.msgFundAmountPrompt(inSym, await fundBalanceLabel(flow.dir, flow.asset));
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

function cmdBridge(ctx: any) {
  resetFlows(ctx.from.id);
  if (!CHAINS.stable) return ctx.reply(msg.msgFundNoStable(), html);
  return fundStep(ctx, false);
}
bot.command('bridge', cmdBridge);

bot.action(/^fundasset:(topup|withdraw):(eth|usdg)$/, async (ctx) => {
  const dir = ctx.match[1] as FundDir;
  const asset = ctx.match[2] as 'eth' | 'usdg';
  const flow: FundFlow = { dir, asset, awaitingAmount: true, startedAt: Date.now() };
  fundFlows.set(ctx.from!.id, flow);
  await ctx.answerCbQuery();
  await fundAmountPrompt(ctx, flow, true);
});

// Tombol Kembali /bridge. Kartu lama (callback funddir:) tetap dijawab ramah.
bot.action(/^funddir:/, (ctx) => ctx.answerCbQuery('Kartu lama — ulangi /bridge.'));
bot.action(['fundback:dir', 'fundback:asset'], async (ctx) => {
  await ctx.answerCbQuery();
  await fundStep(ctx, true);
});
bot.action('fundback:amount', async (ctx) => {
  const flow = fundFlows.get(ctx.from!.id);
  if (!flow) return ctx.answerCbQuery('Kedaluwarsa, ulangi /bridge.');
  await ctx.answerCbQuery();
  await fundAmountPrompt(ctx, flow, true);
});

bot.action('fundok', async (ctx) => {
  const uid = ctx.from!.id;
  const fflow = fundFlows.get(uid);
  if (!fflow?.quote) return ctx.answerCbQuery('Kedaluwarsa, ulangi /bridge.');
  // Calldata bridge berumur pendek: angka di kartu bisa jauh berbeda dari eksekusi.
  if (Date.now() - fflow.startedAt > QUOTE_TTL_MS) {
    fundFlows.delete(uid);
    return ctx.answerCbQuery('Quote kedaluwarsa, ulangi /bridge.');
  }
  if (fundInFlight.has(uid)) return ctx.answerCbQuery('Sedang diproses…');
  fundInFlight.add(uid);
  store.beginMoneyOp();
  const { quote, dir } = fflow;
  fundFlows.delete(uid); // idempotency: hapus sebelum eksekusi
  try {
    await ctx.answerCbQuery('Diproses…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgFundDone([], quote!.outLabel, true), html);
      return;
    }
    await ctx.editMessageText(msg.msgProgress('mengirim bridge via Relay…'), html);
    const { txHashes } = await executeBridge(quote!, fundOrigin(dir));
    await ctx.editMessageText(msg.msgFundDone(txHashes, quote!.outLabel, false), html);
  } catch (e) {
    await ctx.reply(msg.msgError('fund', (e as Error).message), html);
  } finally {
    fundInFlight.delete(uid);
    store.endMoneyOp();
  }
});

// ---------- /swap — swap token arbitrer (beli/jual base↔token, RUTE TERBAIK) ----------
// Base per chain: Robinhood = ETH/USDG (user pilih) · Stable = USDT. Beli: base→token
// (swapExactInBest). Jual: token→base (swapTokenTo{Eth,Usdg}Robust yang teruji).
type TSwapFlow = {
  chainKey: string;
  buy: boolean;
  base?: BaseAsset;
  token?: string;
  tokenSym?: string;
  tokenDec?: number;
  awaitingToken?: boolean;
  awaitingAmount?: boolean;
  awaitingCA?: boolean;          // /buy: menunggu user tempel CA
  chainOptions?: string[];       // /buy: chain kandidat (token ada di >1 chain didukung)
  screenText?: string;           // /buy: kartu Detail+Safety (cache → Kembali tak re-scan)
  screenBahaya?: boolean;        // /buy: verdict screening = BAHAYA
  previewBack?: string;          // action tombol Kembali di kartu Preview/Konfirmasi
  sellList?: SellHolding[];      // /sell: daftar token yg dipegang (index → tombol)
  sellMultiChain?: boolean;      // /sell: holdings tersebar >1 chain → tampilkan label chain
  fromHub?: boolean;             // masuk dari kartu hub CA → tombol Kembali menuju hub
  tokenBalWei?: bigint;          // /sell: saldo token terpilih (raw) untuk hitung %
  tokenBalNum?: number;          // /sell: saldo token terpilih (angka) untuk label
  amountWei?: bigint;
  amountInLabel?: string;
  outLabel?: string;
  route?: string;
  startedAt: number;
};
const tswapFlows = new Map<number, TSwapFlow>();
const tswapInFlight = new Set<number>();

/** Chain yang mendukung swap token (punya router+quoter): Robinhood + Stable (bila aktif). */
const swapTokenChains = (): ChainCtx[] =>
  Object.values(CHAINS).filter((c) => c.key === 'robinhood' || c.key === 'stable');

// /buy = alur CA-dulu · /sell = alur holdings-dulu (di bawah). Antar-chain: /bridge.
// Backend quote (tswapQuoteConfirm) + eksekusi (tswapok) dipakai bersama keduanya.

// ── /buy = alur CA-dulu ─────────────────────────────────────────────────────
// /buy <CA> → Deteksi Chain → Detail+Safety → Pilih Aset → Pilih Size →
//   Preview Order → Konfirmasi → Hasil. Backend quote+eksekusi dipakai bersama /sell.
function buyAskCA(ctx: any, edit: boolean) {
  const extra = { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('Batal', 'cancel')]]) };
  const text = msg.msgBuyAskCA(config.safety.dryRun);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Chain kandidat = tempat token ADA ∩ chain yg didukung swap (robinhood/stable).
async function buyDetectChains(ca: string): Promise<ChainCtx[]> {
  const swapKeys = new Set(swapTokenChains().map((c) => c.key));
  return (await detectChains(ca)).filter((c) => swapKeys.has(c.key));
}

// Langkah 1: pilih chain (hanya bila token ada di >1 chain didukung).
function buyChainStep(ctx: any, flow: TSwapFlow, keys: string[], edit: boolean) {
  flow.chainOptions = keys;
  const rows = keys.map((k) => [Markup.button.callback(CHAINS[k]!.label, `buychain:${k}`)]);
  rows.push([Markup.button.callback('Kembali', 'buyback:ca'), Markup.button.callback('Batal', 'cancel')]);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgChainPick();
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Langkah 2: Detail + Safety. Screening di-cache di flow → tombol Kembali tak re-scan.
async function buySafetyStep(ctx: any, flow: TSwapFlow, prog: { message_id: number } | null, edit: boolean) {
  const cc = CHAINS[flow.chainKey]!;
  if (flow.tokenDec === undefined) {
    // symbol + decimals WAJIB (dipakai est-out & eksekusi). Menebak 18 bisa salah
    // 10^9 untuk token 9-dec — dan angka itu dasar keputusan beli. Gagal = batal.
    try {
      const t = new ethers.Contract(flow.token!, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], cc.provider);
      const [sym, dec] = await Promise.all([t.symbol().catch(() => flow.tokenSym ?? '?'), t.decimals()]);
      flow.tokenSym = String(sym);
      flow.tokenDec = Number(dec);
    } catch {
      tswapFlows.delete(ctx.from.id);
      return editProgress(ctx, prog, msg.msgError('beli', 'Gagal baca decimals token — batal (angka bisa salah 10^12).'));
    }
  }
  if (flow.screenText === undefined) {
    prog = await editProgress(ctx, prog, msg.msgProgress(`menyaring token di ${cc.label}…`));
    try {
      const s = await screenToken(flow.token!, cc);
      flow.token = ethers.getAddress(flow.token!);
      flow.tokenSym = s.symbol && s.symbol !== '???' ? s.symbol : flow.tokenSym;
      flow.screenBahaya = s.verdict === 'BAHAYA';
      flow.screenText = formatScreen(s);
    } catch {
      flow.screenBahaya = false;
      flow.screenText = msg.msgScreeningFailed();
    }
  }
  const back = (flow.chainOptions?.length ?? 0) > 1 ? 'buyback:chain' : 'buyback:ca';
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🟢 Lanjut', 'buy:go')],
      [Markup.button.callback('Kembali', back), Markup.button.callback('Batal', 'cancel')],
    ]),
  };
  const text = `${flow.screenText}\n\n${msg.msgBuySafetyHint(flow.tokenSym ?? '?')}`;
  if (prog) return editProgress(ctx, prog, text, extra);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Langkah 3: pilih aset bayar (ETH/USDG). Stable → auto USDT, langsung ke size.
function buyBaseStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  const cc = CHAINS[flow.chainKey]!;
  const bases = basesFor(cc);
  if (bases.length <= 1) {
    flow.base = bases[0];
    return buySizeStep(ctx, flow, edit);
  }
  const row = bases.map((b) => Markup.button.callback(b.symbol, `buybase:${b.kind}`));
  const back = flow.fromHub ? 'hub:back' : 'buyback:safety';
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([row, [Markup.button.callback('Kembali', back), Markup.button.callback('Batal', 'cancel')]]),
  };
  const text = msg.msgTSwapBase(cc.label, true);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Langkah 4: pilih size (preset /size aset terpilih + ketik nominal). Preview back → size.
async function buySizeStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  flow.awaitingAmount = true;
  flow.previewBack = 'buyback:size'; // Kembali dari Preview → balik ke size
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  let balLine = '';
  try {
    if (base.wrappable) {
      const b = await cc.provider.getBalance(cc.wallet.address);
      balLine = msg.note(`saldo: ${Number(ethers.formatEther(b)).toFixed(5)} ETH`);
    } else {
      const bc = new ethers.Contract(base.address, ERC20_ABI, cc.provider);
      const b: bigint = await bc.balanceOf(cc.wallet.address);
      balLine = msg.note(`saldo: ${Number(ethers.formatUnits(b, base.decimals)).toFixed(2)} ${base.symbol}`);
    }
  } catch {
    /* saldo opsional */
  }
  const kind: SizeKind = isStableBase(base.kind) ? 'stable' : 'eth';
  const presets = store.getSizes(kind);
  const rows: any[] = [];
  for (let i = 0; i < presets.length; i += 2) {
    rows.push(presets.slice(i, i + 2).map((p) => Markup.button.callback(`${p} ${base.symbol}`, `tsamt:${p}`)));
  }
  const multiBase = basesFor(cc).length > 1;
  const backSize = multiBase ? 'buyback:base' : flow.fromHub ? 'hub:back' : 'buyback:safety';
  rows.push([Markup.button.callback('Kembali', backSize), Markup.button.callback('Batal', 'cancel')]);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgTSwapAmountPrompt(true, base.symbol, balLine);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Mulai alur beli dari CA: deteksi chain → (pilih chain bila banyak) → safety.
/** Posisi LP aktif (v3 + v4) untuk sebuah CA di chain tertentu. */
async function lpForToken(ca: string, cc: ChainCtx): Promise<{ v3: store.PosRecord[]; v4: string[] }> {
  const low = ca.toLowerCase();
  const v3 = store.active().filter((r) => (r.chain ?? 'robinhood') === cc.key && r.ca?.toLowerCase() === low);
  // v4store menyimpan currency0/currency1, BUKAN ca — cocokkan ke dua-duanya.
  const v4 = v4store
    .allV4()
    .filter(
      (r) =>
        r.chain === cc.key && (r.currency0.toLowerCase() === low || r.currency1.toLowerCase() === low),
    )
    .map((r) => r.tokenId);
  return { v3, v4 };
}

/**
 * Render HUB TOKEN. Satu screening + satu baca saldo melayani 4 aksi.
 * Tombol keluar (Tutup LP / Jual) hanya dirender bila memang ada yang bisa dikeluarkan —
 * tombol mati = tap sia-sia + afordans palsu.
 */
async function renderTokenHub(
  ctx: any,
  ca: string,
  chainKey: string,
  prog: { message_id: number } | null,
) {
  const cc = getChain(chainKey);
  prog = await editProgress(ctx, prog, msg.msgProgress(`menyaring token di ${cc.label}…`));

  // Identitas token: symbol+decimals WAJIB (dipakai semua alur turunan). Gagal = batal,
  // jangan tebak 18 (PRD §8.9).
  let sym = '?';
  let dec = 18;
  try {
    const t = new ethers.Contract(ca, ERC20_ABI, cc.provider);
    const [sm, dc] = await Promise.all([t.symbol().catch(() => '?'), t.decimals()]);
    sym = String(sm);
    dec = Number(dc);
  } catch {
    return editProgress(ctx, prog, msg.msgError('token', 'Gagal baca decimals token — batal (angka bisa salah 10^12).'));
  }

  const [screened, balRes] = await Promise.allSettled([
    screenToken(ca, cc),
    new ethers.Contract(ca, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address) as Promise<bigint>,
  ]);
  const sc = screened.status === 'fulfilled' ? screened.value : null;
  if (sc?.symbol && sc.symbol !== '???') sym = sc.symbol;
  const bal = balRes.status === 'fulfilled' ? balRes.value : 0n;
  const balNum = Number(ethers.formatUnits(bal, dec));
  const { v3, v4 } = await lpForToken(ca, cc);

  const priceUsd = sc?.priceUsd ?? null;
  const note =
    sc && sc.liquidityUsd != null
      ? `likuiditas ${msg.usdCompact(sc.liquidityUsd)}${sc.pairAgeHours != null ? ` · pool ${Math.round(sc.pairAgeHours)} jam` : ''}`
      : undefined;
  const text = msg.msgTokenHub({
    symbol: sym,
    chainLabel: cc.label,
    ca,
    verdict: sc?.verdict ?? null,
    verdictNote: note,
    priceUsd,
    balanceLabel: bal > 0n ? `${msg.cleanUnits(bal, dec)} ${sym}` : undefined,
    balanceUsd: bal > 0n && priceUsd ? balNum * Number(priceUsd) : null,
    lpCount: v3.length + v4.length,
    lpIds: [...v3.map((r) => r.tokenId), ...v4],
    dryRun: config.safety.dryRun,
  });

  // Beli/jual hanya di chain yang punya rute swap bot (Robinhood/Stable).
  const swappable = swapTokenChains().some((c) => c.key === cc.key);
  const enter = [Markup.button.callback('➕ Buka LP', `ca:add:${ca}`)];
  if (swappable) enter.push(Markup.button.callback('📈 Beli', `ca:buy:${ca}`));
  const exit: ReturnType<typeof Markup.button.callback>[] = [];
  if (v3.length + v4.length > 0) exit.push(Markup.button.callback('⛔ Tutup LP', `ca:close:${ca}`));
  if (swappable && bal > 0n) exit.push(Markup.button.callback('📉 Jual', `ca:sell:${ca}`));
  const kb = Markup.inlineKeyboard([enter, ...(exit.length ? [exit] : []), [Markup.button.callback('Batal', 'cancel')]]);

  hubs.set(ctx.from.id, {
    ca,
    chainKey: cc.key,
    text,
    kb,
    sym,
    dec,
    screenText: sc ? formatScreen(sc) : msg.msgScreeningFailed(),
    bahaya: sc?.verdict === 'BAHAYA',
    failed: !sc,
  });
  return editProgress(ctx, prog, text, { ...html, ...kb });
}

/**
 * Router 4 tombol hub → alur yang SUDAH ADA. Tak ada jalur uang baru:
 * screening dioper (tak di-scan ulang), semua konfirmasi & guard tetap milik alur asal.
 */
bot.action(/^ca:(add|buy|close|sell):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const [, what, ca] = ctx.match as unknown as [string, 'add' | 'buy' | 'close' | 'sell', string];
  const h = hubs.get(ctx.from!.id);
  if (!h || h.ca.toLowerCase() !== ca.toLowerCase()) return ctx.answerCbQuery('Kedaluwarsa, tempel CA lagi.');
  const cc = getChain(h.chainKey);
  await ctx.answerCbQuery();
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;

  if (what === 'add') {
    // Wizard /add penuh; screening dari hub dioper → kartu SCREEN tak dikirim dua kali.
    return continueAddlp(ctx, ca, h.chainKey, prog, { bahaya: h.bahaya, failed: h.failed });
  }

  if (what === 'buy') {
    // Kartu SAFETY dilewati (verdikt sudah tampil di hub) → langsung pilih base/nominal.
    tswapFlows.set(ctx.from!.id, {
      chainKey: h.chainKey,
      buy: true,
      token: ethers.getAddress(ca),
      tokenSym: h.sym,
      tokenDec: h.dec,
      screenText: h.screenText,
      screenBahaya: h.bahaya,
      fromHub: true,
      startedAt: Date.now(),
    });
    return buyBaseStep(ctx, tswapFlows.get(ctx.from!.id)!, true);
  }

  if (what === 'sell') {
    const bal: bigint = await new ethers.Contract(ca, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .catch(() => 0n);
    if (bal <= 0n) return ctx.editMessageText(msg.msgError('jual', 'Saldo token ini 0 — tak ada yang bisa dijual.'), html);
    const flow: TSwapFlow = {
      chainKey: h.chainKey,
      buy: false,
      token: ethers.getAddress(ca),
      tokenSym: h.sym,
      tokenDec: h.dec,
      tokenBalWei: bal,
      tokenBalNum: Number(ethers.formatUnits(bal, h.dec)),
      screenText: h.screenText,
      screenBahaya: h.bahaya,
      fromHub: true,
      startedAt: Date.now(),
    };
    tswapFlows.set(ctx.from!.id, flow);
    return sellAmountStep(ctx, flow, true);
  }

  // close: 1 posisi → langsung konfirmasi; >1 → kartu per posisi (pilih sendiri).
  const { v3, v4 } = await lpForToken(ca, cc);
  if (v3.length === 1 && v4.length === 0) return renderStopConfirm(ctx, v3[0].tokenId, true);
  if (v3.length === 0 && v4.length === 1) {
    return ctx.editMessageText(msg.msgV4CloseConfirm(v4[0]), {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⛔ Tutup Posisi v4', `closev4go:${v4[0]}`)],
        [Markup.button.callback('Kembali', 'hub:back'), Markup.button.callback('Batal', 'cancel')],
      ]),
    });
  }
  if (v3.length + v4.length === 0) {
    return ctx.editMessageText(msg.msgError('tutup', 'Tak ada posisi LP aktif untuk token ini.'), html);
  }
  await ctx.editMessageText(msg.msgCloseAllPick(v3.length, v4.length), html);
  for (const rec of v3) {
    const c = await buildPositionCard(rec).catch(() => null);
    if (c) await ctx.reply(c.text, c.extra);
  }
  if (v4.length) {
    const list = await listPositionsV4(cc).catch(() => []);
    const ethUsd = await getEthUsd(cc.wethAddress, cc).catch(() => null);
    for (const id of v4) {
      const p = list.find((x) => x.tokenId === id);
      if (p) {
        const c = buildV4Card(p, ethUsd);
        await ctx.reply(c.text, c.extra);
      }
    }
  }
});

/** Pintu masuk hub dari CA telanjang: deteksi chain dulu (pemilih bila >1). */
async function startTokenHub(ctx: any, ca: string) {
  resetFlows(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('mendeteksi chain…'), html);
  const found = await detectChains(ca);
  if (found.length === 0) {
    return editProgress(
      ctx,
      prog,
      msg.msgError('token', `Token tak ditemukan di chain mana pun (${Object.values(CHAINS).map((c) => c.label).join('/')}).`),
    );
  }
  if (found.length === 1) return renderTokenHub(ctx, ca, found[0].key, { message_id: prog.message_id });
  return editProgress(ctx, prog, msg.msgChainPick(), {
    ...html,
    ...Markup.inlineKeyboard([
      ...found.map((c) => [Markup.button.callback(c.label, `hubchn:${c.key}:${ca}`)]),
      [Markup.button.callback('Batal', 'cancel')],
    ]),
  });
}

bot.action(/^hubchn:(\w+):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  await renderTokenHub(ctx, ctx.match[2], ctx.match[1], prog);
});

/** Kembali ke hub dari alur mana pun — render ulang dari memori (0 RPC). */
bot.action('hub:back', async (ctx) => {
  const h = hubs.get(ctx.from!.id);
  if (!h) return ctx.answerCbQuery('Kedaluwarsa, tempel CA lagi.');
  flows.delete(ctx.from!.id);
  tswapFlows.delete(ctx.from!.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText(h.text, { ...html, ...h.kb }).catch(() => {});
});

async function buyStartFromCA(ctx: any, ca: string, prog: { message_id: number } | null) {
  flows.delete(ctx.from.id); // sisa wizard /add jangan menelan ketikan nominal beli
  fundFlows.delete(ctx.from.id);
  if (!ethers.isAddress(ca)) {
    if (prog) return editProgress(ctx, prog, msg.msgInvalidAddress());
    return ctx.reply(msg.msgInvalidAddress(), html);
  }
  prog = await editProgress(ctx, prog, msg.msgProgress('mendeteksi chain…'));
  const found = await buyDetectChains(ca);
  if (found.length === 0) {
    return editProgress(ctx, prog, msg.msgError('beli', 'Token tak ditemukan di chain yang didukung /buy (Robinhood/Stable).'));
  }
  const flow: TSwapFlow = { chainKey: found[0].key, buy: true, token: ethers.getAddress(ca), startedAt: Date.now() };
  tswapFlows.set(ctx.from.id, flow);
  if (found.length > 1) {
    flow.chainOptions = found.map((c) => c.key);
    return buyChainStep(ctx, flow, flow.chainOptions, true);
  }
  return buySafetyStep(ctx, flow, prog, true);
}

async function cmdBuy(ctx: any) {
  resetFlows(ctx.from.id);
  const ca = ((ctx.message?.text as string) || '').trim().split(/\s+/)[1];
  if (!ca) {
    tswapFlows.set(ctx.from.id, { chainKey: 'robinhood', buy: true, awaitingCA: true, startedAt: Date.now() });
    return buyAskCA(ctx, false);
  }
  const prog = await ctx.reply(msg.msgProgress('mendeteksi chain…'), html);
  return buyStartFromCA(ctx, ca, { message_id: prog.message_id });
}
bot.command('buy', cmdBuy);

bot.action(/^buychain:(\w+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  if (!CHAINS[ctx.match[1]]) return ctx.answerCbQuery('Chain tak tersedia.');
  flow.chainKey = ctx.match[1];
  flow.screenText = undefined; // ganti chain → screening ulang
  await ctx.answerCbQuery();
  await buySafetyStep(ctx, flow, null, true);
});

bot.action('buy:go', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  await ctx.answerCbQuery();
  await buyBaseStep(ctx, flow, true);
});

bot.action(/^buybase:(weth|usdg|usdt)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  flow.base = baseOf(CHAINS[flow.chainKey]!, ctx.match[1] as BaseKind);
  await ctx.answerCbQuery();
  await buySizeStep(ctx, flow, true);
});

// Tombol Kembali /buy.
bot.action('buyback:ca', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  flow.awaitingCA = true;
  flow.screenText = undefined;
  await ctx.answerCbQuery();
  await buyAskCA(ctx, true);
});
bot.action('buyback:chain', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.chainOptions?.length) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  await ctx.answerCbQuery();
  await buyChainStep(ctx, flow, flow.chainOptions, true);
});
bot.action('buyback:safety', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  await ctx.answerCbQuery();
  await buySafetyStep(ctx, flow, null, true);
});
bot.action('buyback:base', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  await ctx.answerCbQuery();
  await buyBaseStep(ctx, flow, true);
});
bot.action('buyback:size', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.base || !flow.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  await ctx.answerCbQuery();
  await buySizeStep(ctx, flow, true);
});

// Prompt ketik alamat token — Kembali ke base (chain multi-base) atau ke chain (base tunggal).
// ── /sell = alur holdings-dulu ───────────────────────────────────────────────
// /sell → daftar token dipegang → pilih token → %/jumlah → Preview → Konfirmasi →
//   Hasil. Base TERIMA dipilih OTOMATIS (nilai USD terbaik: ETH vs USDG/USDT).
type SellHolding = {
  ca: string;
  symbol: string;
  dec: number;
  balWei: bigint;
  amountNum: number;
  usd: number | null;
  chainKey?: string; // chain tempat token dipegang (dipakai jalur eksekusi jual)
};

async function bsFetch(url: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Token ERC20 (bukan base) dgn saldo > 0 di wallet. Blockscout dulu; fallback on-chain.
async function sellHoldings(cc: ChainCtx): Promise<SellHolding[]> {
  const skip = new Set<string>([cc.wethAddress.toLowerCase()]);
  if (cc.usdgAddress) skip.add(cc.usdgAddress.toLowerCase());
  if (cc.usdtAddress) skip.add(cc.usdtAddress.toLowerCase());
  // Token yang PERNAH kita sentuh (beli/LP) — dianggap sah walau tanpa harga pasar.
  const known = new Set<string>();
  for (const t of journal.recentTokens(80)) if (t.ca) known.add(t.ca.toLowerCase());
  for (const p of store.active()) if (p.ca) known.add(p.ca.toLowerCase());
  const out: SellHolding[] = [];
  if (cc.blockscout) {
    const data = await bsFetch(`${cc.blockscout}/addresses/${cc.wallet.address}/token-balances`);
    for (const it of Array.isArray(data) ? data : []) {
      const tk = it?.token;
      const ca = tk?.address_hash || tk?.address;
      if (!tk || !ca || (tk.type && tk.type !== 'ERC-20')) continue;
      const cal = String(ca).toLowerCase();
      if (skip.has(cal)) continue;
      let balWei: bigint;
      try { balWei = BigInt(it.value ?? '0'); } catch { continue; }
      if (balWei <= 0n) continue;
      const rate = Number(tk.exchange_rate ?? 0);
      // Anti-spam airdrop: hanya token BERNILAI (punya exchange_rate) ATAU yang pernah kita trade.
      if (!(rate > 0) && !known.has(cal)) continue;
      // Blockscout kadang tak mengisi decimals; menebak 18 membuat jumlah jual salah.
      let dec: number;
      if (tk.decimals != null) dec = Number(tk.decimals);
      else {
        const d = await new ethers.Contract(ca, ERC20_ABI, cc.provider)
          .decimals()
          .catch(() => null);
        if (d === null) continue; // tak bisa dipastikan → jangan tawarkan untuk dijual
        dec = Number(d);
      }
      const amountNum = Number(ethers.formatUnits(balWei, dec));
      out.push({ ca: ethers.getAddress(ca), symbol: String(tk.symbol || '?'), dec, balWei, amountNum, usd: rate ? amountNum * rate : null });
    }
    out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    return out.slice(0, SELL_HOLDINGS_CAP);
  }
  // Fallback (chain tanpa Blockscout, mis. Stable): kandidat dari jurnal + posisi aktif.
  const cand = new Map<string, string>();
  for (const t of journal.recentTokens(40)) if (t.ca) cand.set(t.ca.toLowerCase(), t.symbol);
  for (const p of store.active()) if (p.ca) cand.set(p.ca.toLowerCase(), p.symbol);
  for (const [ca, sym] of [...cand].slice(0, HOLDINGS_CAND_MAX)) {
    if (skip.has(ca)) continue;
    try {
      const erc = new ethers.Contract(ca, ERC20_ABI, cc.provider);
      const balWei: bigint = await erc.balanceOf(cc.wallet.address);
      if (balWei <= 0n) continue;
      const dec = Number(await erc.decimals().catch(() => 18));
      out.push({ ca: ethers.getAddress(ca), symbol: sym, dec, balWei, amountNum: Number(ethers.formatUnits(balWei, dec)), usd: null });
    } catch {
      /* skip token bermasalah */
    }
  }
  return out.slice(0, SELL_HOLDINGS_CAP);
}

const fmt4 = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
function sellListKb(list: SellHolding[], showChain = false) {
  const rows = list.map((h, i) => [Markup.button.callback(
    `${h.symbol} · ${fmt4(h.amountNum)}${h.usd ? ` · $${h.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : ''}` +
      (showChain && h.chainKey ? ` @${CHAINS[h.chainKey]?.label ?? h.chainKey}` : ''),
    `sellpick:${i}`,
  )]);
  rows.push([Markup.button.callback('Batal', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}

// Langkah 2: pilih % / jumlah.
function sellAmountStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  flow.awaitingAmount = true;
  flow.previewBack = 'sellback:amount'; // Kembali dari Preview → step %/jumlah
  // Masuk dari hub = tak ada daftar holdings untuk dituju; pulangkan ke kartu token.
  const back = flow.sellList ? 'sellback:list' : flow.fromHub ? 'hub:back' : 'cancel';
  const rows = [
    [25, 50, 75, 100].map((p) => Markup.button.callback(`${p}%`, `sellpct:${p}`)),
    [Markup.button.callback('Ketik jumlah', 'sellpct:custom')],
    [Markup.button.callback('Kembali', back), Markup.button.callback('Batal', 'cancel')],
  ];
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgSellAmount(flow.tokenSym!, `${fmt4(flow.tokenBalNum!)} ${flow.tokenSym}`);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Auto-pilih base TERIMA terbaik (nilai USD tertinggi antar ETH/USDG/USDT) + kartu Preview.
async function sellPreview(ctx: any, flow: TSwapFlow, amountWei: bigint, amtLabel: string) {
  const cc = CHAINS[flow.chainKey]!;
  const prog = await ctx.reply(msg.msgProgress('cari rute jual terbaik…'), html);
  const ethUsd = await getEthUsd(cc.wethAddress, cc).catch(() => null);
  const quotes = (
    await Promise.all(
      basesFor(cc).map(async (base) => {
        const q = await previewSwapOut(flow.token!, base.address, amountWei, cc).catch(() => null);
        return q && q.out > 0n ? { base, out: q.out } : null;
      }),
    )
  ).filter((x): x is { base: BaseAsset; out: bigint } => x !== null);
  let best: { base: BaseAsset; usd: number } | null = null;
  if (ethUsd === null) {
    // Tanpa kurs, membandingkan 0.004 (ETH) vs 12 (USDG) sebagai angka polos selalu
    // memenangkan stablecoin. Default PRD §9 = ETH.
    const pick = quotes.find((q) => q.base.wrappable) ?? quotes[0] ?? null;
    if (pick) best = { base: pick.base, usd: 0 };
  } else {
    for (const q of quotes) {
      const outNum = Number(ethers.formatUnits(q.out, q.base.decimals));
      const usd = isStableBase(q.base.kind) ? outNum : outNum * ethUsd;
      if (!best || usd > best.usd) best = { base: q.base, usd };
    }
  }
  if (!best) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(ctx, prog, msg.msgError('jual', 'Tak ada rute jual (likuiditas tipis) untuk token ini.'));
  }
  flow.base = best.base;
  await tswapQuoteConfirm(ctx, flow, cc, flow.token!, best.base.address, amountWei, amtLabel, { message_id: prog.message_id });
}

async function cmdSell(ctx: any) {
  resetFlows(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('membaca holdings…'), html);
  // /buy menerima beberapa chain, jadi /sell harus melihat semuanya — kalau tidak,
  // token yang dibeli di chain Stable tak punya jalan keluar lewat bot.
  const chains = swapTokenChains();
  const lists = await Promise.all(
    chains.map(async (c) => (await sellHoldings(c).catch(() => [])).map((h) => ({ ...h, chainKey: c.key }))),
  );
  const list = lists
    .flat()
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, SELL_HOLDINGS_CAP);
  if (list.length === 0) return editProgress(ctx, prog, msg.msgSellNoHoldings());
  const multiChain = new Set(list.map((h) => h.chainKey)).size > 1;
  const flow: TSwapFlow = { chainKey: list[0].chainKey!, buy: false, sellList: list, startedAt: Date.now(), sellMultiChain: multiChain };
  tswapFlows.set(ctx.from.id, flow);
  return editProgress(ctx, prog, msg.msgSellList(list.length), { ...html, ...sellListKb(list, multiChain) });
}
bot.command('sell', cmdSell);

bot.action(/^sellpick:(\d+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.sellList) return ctx.answerCbQuery('Kedaluwarsa, ulangi /sell.');
  const h = flow.sellList[Number(ctx.match[1])];
  if (h?.chainKey) flow.chainKey = h.chainKey; // eksekusi WAJIB di chain token itu
  if (!h) return ctx.answerCbQuery('Pilihan tak valid.');
  flow.token = h.ca;
  flow.tokenSym = h.symbol;
  flow.tokenDec = h.dec;
  flow.tokenBalWei = h.balWei;
  flow.tokenBalNum = h.amountNum;
  await ctx.answerCbQuery();
  await sellAmountStep(ctx, flow, true);
});

bot.action(/^sellpct:(\d+|custom)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token || flow.tokenBalWei === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /sell.');
  if (ctx.match[1] === 'custom') {
    await ctx.answerCbQuery();
    return ctx.editMessageText(msg.msgSellTypeAmount(flow.tokenSym!), {
      ...html,
      ...Markup.inlineKeyboard([[Markup.button.callback('Kembali', 'sellback:amount')]]),
    });
  }
  const pct = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  const amountWei = pct >= 100 ? flow.tokenBalWei : (flow.tokenBalWei * BigInt(pct)) / 100n;
  const amtLabel = `${fmt4((flow.tokenBalNum! * pct) / 100)} ${flow.tokenSym} (${pct}%)`;
  await sellPreview(ctx, flow, amountWei, amtLabel);
});

// Tombol Kembali /sell.
bot.action('sellback:list', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.sellList) return ctx.answerCbQuery('Kedaluwarsa, ulangi /sell.');
  flow.awaitingAmount = false;
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgSellList(flow.sellList.length), {
    ...html,
    ...sellListKb(flow.sellList, !!flow.sellMultiChain),
  });
});
bot.action('sellback:amount', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /sell.');
  await ctx.answerCbQuery();
  await sellAmountStep(ctx, flow, true);
});

/** Quote rute terbaik + kartu konfirmasi. Dipakai jalur ketik & tombol preset. */
async function tswapQuoteConfirm(
  ctx: any,
  tflow: TSwapFlow,
  cc: ChainCtx,
  fromAddr: string,
  toAddr: string,
  amountWei: bigint,
  amountInLabel: string,
  prog0?: { message_id: number },
) {
  const base = tflow.base!;
  const prog = prog0 ?? (await ctx.reply(msg.msgProgress('minta quote rute terbaik…'), html));
  // MAX_ETH_PER_TX dijanjikan README tapi dulu hanya ditegakkan di wizard /add —
  // preset & ketik-nominal /buy lolos begitu saja. Base stablecoin tetap tanpa batas
  // (konsisten dengan amountCtx).
  if (base.wrappable && Number(ethers.formatEther(amountWei)) > maxEth) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(
      ctx,
      prog,
      msg.msgError('swap', `Di atas batas ${maxEthLabel}/tx — turunkan nominal.`),
    );
  }
  const q = await previewSwapOut(fromAddr, toAddr, amountWei, cc);
  if (!q) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(ctx, prog, msg.msgError('swap', 'Tak ada rute (pool/likuiditas tipis). Coba jumlah/token lain.'));
  }
  const outDec = tflow.buy ? tflow.tokenDec! : base.decimals;
  const outSym = tflow.buy ? tflow.tokenSym! : base.symbol;
  const estOutLabel = `${Number(ethers.formatUnits(q.out, outDec)).toLocaleString('en-US', { maximumFractionDigits: outDec >= 18 ? 6 : 2 })} ${outSym}`;
  tflow.amountWei = amountWei;
  tflow.amountInLabel = amountInLabel;
  tflow.outLabel = estOutLabel;
  tflow.route = q.route;
  tflow.awaitingAmount = false;

  // Saldo yang DIPERTARUHKAN ikut di kartu. Untuk beli dengan base wrappable,
  // yang membiayai adalah ETH native (jalur eksekusi mem-wrap), bukan saldo WETH —
  // memakai saldo WETH di sini melahirkan false-green.
  let balanceLabel: string | undefined;
  let shortLabel: string | null = null;
  try {
    if (tflow.buy) {
      const bal: bigint = base.wrappable
        ? await cc.provider.getBalance(cc.wallet.address)
        : await new ethers.Contract(base.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
      const sym = base.wrappable ? cc.nativeSymbol : base.symbol;
      balanceLabel = `${msg.cleanUnits(bal, base.decimals)} ${sym}`;
      if (bal < amountWei) shortLabel = `${msg.cleanUnits(amountWei - bal, base.decimals)} ${sym}`;
    } else {
      balanceLabel = `${msg.cleanUnits(tflow.tokenBalWei ?? 0n, tflow.tokenDec ?? 18)} ${tflow.tokenSym}`;
    }
  } catch {
    /* saldo tak terbaca → baris saldo disembunyikan, jangan blokir */
  }
  const kb = shortLabel
    ? [[Markup.button.callback('Kembali', tflow.previewBack ?? 'buyback:size'), Markup.button.callback('Batal', 'cancel')]]
    : [
        [Markup.button.callback(`🟢 Konfirmasi · ${amountInLabel}`, 'tswapok')],
        [Markup.button.callback('Kembali', tflow.previewBack ?? 'buyback:size'), Markup.button.callback('Batal', 'cancel')],
      ];
  return editProgress(
    ctx,
    prog,
    msg.msgTSwapConfirm({
      buy: tflow.buy,
      chainLabel: cc.label,
      tokenSym: tflow.tokenSym!,
      amountInLabel,
      estOutLabel,
      route: q.route,
      dryRun: config.safety.dryRun,
      danger: tflow.screenBahaya,
      screenFailed: !tflow.screenBahaya && /GAGAL/.test(tflow.screenText ?? ''),
      balanceLabel,
      shortLabel,
    }),
    { ...html, ...Markup.inlineKeyboard(kb) },
  );
}

// Tombol preset nominal di /buy → langsung quote+konfirmasi (base→token).
bot.action(/^tsamt:(.+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.base || !flow.token || !flow.buy) return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy.');
  const num = Number(ctx.match[1]);
  if (!(num > 0)) return ctx.answerCbQuery('Nominal tak valid.');
  await ctx.answerCbQuery();
  const base = flow.base;
  const amountWei = base.wrappable ? ethers.parseEther(String(num)) : ethers.parseUnits(String(num), base.decimals);
  await tswapQuoteConfirm(ctx, flow, CHAINS[flow.chainKey]!, base.address, flow.token, amountWei, `${num} ${base.symbol}`);
});

bot.action('tswapok', async (ctx) => {
  const uid = ctx.from!.id;
  const flow = tswapFlows.get(uid);
  if (!flow || flow.amountWei === undefined || !flow.base || !flow.token) {
    return ctx.answerCbQuery('Kedaluwarsa, ulangi /buy atau /sell.');
  }
  if (tswapInFlight.has(uid)) return ctx.answerCbQuery('Sedang diproses…');
  tswapInFlight.add(uid);
  store.beginMoneyOp();
  const { chainKey, buy, base, token, tokenSym, tokenDec, amountWei, amountInLabel } = flow;
  tswapFlows.delete(uid); // idempotency: hapus SEBELUM eksekusi (double-tap tak swap dobel)
  const cc = CHAINS[chainKey]!;
  await ctx.answerCbQuery('Diproses…');
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(
        msg.msgTSwapDone({ buy, tokenSym: tokenSym!, amountInLabel: amountInLabel!, outLabel: flow.outLabel ?? '(estimasi)', dryRun: true }),
        html,
      );
      return;
    }
    await ctx.editMessageText(msg.msgProgress('menukar via rute terbaik…'), html);
    let outLabel: string;
    let route: string;
    if (buy) {
      // base → token. Base ETH: wrap seperlunya dulu (Uniswap butuh WETH).
      if (base!.wrappable) {
        const have: bigint = await cc.weth.balanceOf(cc.wallet.address);
        if (have < amountWei) {
          const wtx = await cc.weth.deposit({ value: amountWei - have });
          await wtx.wait();
        }
      }
      const r = await swapExactInBest(base!.address, token!, amountWei, cc, 5);
      outLabel = `${Number(ethers.formatUnits(r.outWei, tokenDec!)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${tokenSym}`;
      route = r.route;
    } else if (base!.wrappable) {
      const r = await swapTokenToEthRobust(token!, amountWei, cc);
      outLabel = `${Number(ethers.formatEther(r.outEthWei)).toFixed(6)} ETH`;
      route = r.route;
    } else {
      const r = await swapTokenToUsdgRobust(token!, amountWei, base!.address, cc);
      outLabel = `${Number(ethers.formatUnits(r.outWei, base!.decimals)).toFixed(2)} ${base!.symbol}`;
      route = r.route;
    }
    await ctx.editMessageText(
      msg.msgTSwapDone({ buy, tokenSym: tokenSym!, amountInLabel: amountInLabel!, outLabel, route, dryRun: false }),
      html,
    );
  } catch (e) {
    await ctx.reply(msg.msgError('swap', (e as Error).message), html);
  } finally {
    tswapInFlight.delete(uid);
    store.endMoneyOp();
  }
});

bot.action(/^stop:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await renderStopConfirm(ctx, ctx.match[1], true);
  } catch (e) {
    if (isGoneErr(e)) {
      finalizeClose(ctx.match[1], { reason: 'gone' });
      await ctx.editMessageText(msg.msgAlreadyClosed(ctx.match[1]), html);
    } else {
      // Gagal BACA detail (timeout RPC / quoter revert) tak berarti posisi tak bisa
      // ditutup — executeRemove tak butuh satu pun angka itu. Tetap beri jalan keluar.
      await ctx.reply(msg.msgError('stop', (e as Error).message), {
        ...html,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⛔ Tutup Paksa', `close:${ctx.match[1]}`)],
          [Markup.button.callback('Batal', 'cancel')],
        ]),
      });
    }
  }
});

// tokenId yang sedang ditutup — cegah double-tap "Tutup Posisi" (tx kedua revert
// di burn & buang gas). Sinkron: has→add sebelum await pertama = atomik thd loop.
// Di store agar monitor ikut melihatnya (jangan jurnalkan yang sedang ditutup).
// Nilai = epoch mulai: kunci kedaluwarsa 10 menit supaya tx yang menggantung
// tak mengunci posisi selamanya (dulu satu-satunya jalan keluar = restart).
const closingInFlight = store.closing;
const CLOSING_LOCK_MS = 10 * 60_000;
const closeLocked = (tokenId: string): boolean => {
  const t = closingInFlight.get(tokenId);
  return t !== undefined && Date.now() - t < CLOSING_LOCK_MS;
};

/** Kirim profit card PNG (momen kunci). Presentasi murni — dibungkus penuh,
 *  kegagalan render/kirim TAK boleh mengganggu close yang sudah sukses. */
async function sendProfitCard(
  ctx: any,
  tokenId: string,
  rec: store.PosRecord | undefined,
  baseOutWei: bigint,
): Promise<void> {
  if (!rec) return;
  const stable = isStableBase(rec.baseKind ?? 'weth');
  const dec = stable ? 6 : 18;
  const baseSym = baseSymbolOf(rec.baseKind);
  const baseIn = Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
  const baseOut = Number(ethers.formatUnits(baseOutWei, dec));
  const pnl = baseOut - baseIn;
  const pnlPct = baseIn > 0 ? (pnl / baseIn) * 100 : 0;
  const positive = pnl >= 0;
  let usd: number | null = null;
  if (stable) usd = pnl;
  else {
    const cc = getChain(rec.chain);
    const eu = await getEthUsd(cc.wethAddress, cc);
    usd = eu !== null ? pnl * eu : null;
  }
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: dec >= 18 ? 5 : 2 });
  const buf = renderProfitCard({
    pair: `${baseSym} / ${rec.symbol}`,
    positive,
    pnlBig: usd !== null ? msg.usdSigned(usd) : `${positive ? '+' : ''}${pnl.toFixed(dec >= 18 ? 5 : 2)} ${baseSym}`,
    pnlPct: msg.fmtPct(pnlPct),
    stats: [
      { label: 'deposit', value: `${fmt(baseIn)} ${baseSym}` },
      { label: 'received', value: `${fmt(baseOut)} ${baseSym}` },
      { label: 'held', value: msg.fmtAge(Date.now() - rec.openedAt) },
    ],
    footerLeft: `#${tokenId} · ${new Date().toISOString().slice(0, 10)}`,
  });
  await ctx.replyWithPhoto(Input.fromBuffer(buf, 'philips.png'));
}

bot.action(/^close:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  if (closeLocked(tokenId)) return ctx.answerCbQuery('Sedang diproses…');
  closingInFlight.set(tokenId, Date.now());
  const closingRec = store.get(tokenId); // tangkap SEBELUM finalizeClose menghapus
  try {
    await ctx.answerCbQuery('Diproses…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgDryRunClose(tokenId), html);
      return;
    }
    const baseSym = isStableBase(closingRec?.baseKind ?? 'weth') ? baseSymbolOf(closingRec?.baseKind) : 'ETH';
    await ctx.editMessageText(msg.msgClosing(baseSym), html);
    const summary = await stopAndCashOut(tokenId, getChain(closingRec?.chain));
    // resultEthWei = 0 adalah PLACEHOLDER backfill di jurnal (dikecualikan dari PnL).
    // Hasil yang benar-benar tak terukur harus undefined, bukan 0.
    finalizeClose(tokenId, {
      ...(summary.baseOutWei > 0n ? { resultEthWei: summary.baseOutWei } : {}),
      reason: 'cashed',
      keep: summary.leftover,
    });
    await ctx.reply(summary.text, html);
    await sendProfitCard(ctx, tokenId, closingRec, summary.baseOutWei).catch((e) =>
      console.log('[profit-card] gagal:', (e as Error).message.slice(0, 120)),
    );
  } catch (err) {
    if (isGoneErr(err)) {
      finalizeClose(tokenId, { reason: 'gone' });
      await ctx.reply(msg.msgAlreadyClosed(tokenId), html);
    } else {
      await ctx.reply(msg.msgError('close', (err as Error).message), html);
    }
  } finally {
    closingInFlight.delete(tokenId);
  }
});

/** Remove + collect, lalu swap seluruh aset hasil LP ke ETH (token via Relay, WETH di-unwrap). */
async function stopAndCashOut(
  tokenId: string,
  cc: ChainCtx = getChain(),
): Promise<{ text: string; baseOutWei: bigint; leftover: boolean }> {
  const { positionManager: pm, weth: wethC, wallet: w } = cc;
  const p = await pm.positions(tokenId);
  // Pool tanpa base yang kita kenal (mis. TOKENA/TOKENB hasil impor): tak ada rute
  // cash-out dua sisi. Fallback ke WETH akan membakar posisi lalu salah hitung
  // (unwrap WETH milik operasi lain) dan meninggalkan satu sisi token selamanya.
  // Gagal SEBELUM burn — dana tetap utuh di posisi.
  const base = detectBase(cc, p.token0, p.token1);
  if (!base) {
    throw new Error(
      'Pool ini bukan pasangan WETH/USDG/USDT — bot tak bisa cash-out dua sisi. Tutup manual di app.uniswap.org.',
    );
  }
  const otherAddr = base.address.toLowerCase() === p.token0.toLowerCase() ? p.token1 : p.token0;
  const otherC = new ethers.Contract(otherAddr, ERC20_ABI, w);
  const baseC = base.wrappable ? wethC : new ethers.Contract(base.address, ERC20_ABI, w);
  const baseBefore: bigint = await baseC.balanceOf(w.address);

  const notes: string[] = [];
  notes.push(...(await executeRemove(tokenId, cc)).notes);
  await sleep(1500); // beri waktu collect settle sebelum baca saldo

  const txHashes: string[] = [];
  // ① Swap SELURUH saldo token sisi non-base → base, ulang sampai habis (bukan
  //    sekali/delta). Menutup celah: token sisa dari close lama, RPC telat, no-op.
  // NFT sudah di-burn di atas: mulai sini TAK BOLEH melempar, kalau tidak user
  // hanya melihat ERROR mentah & tak tahu posisinya sudah ditarik (PnL pun hilang).
  let sw: { baseOut: bigint; txHashes: string[]; leftover: boolean } = {
    baseOut: 0n,
    txHashes: [],
    leftover: true, // default konservatif: anggap masih ada sisa → monitor retry
  };
  try {
    sw = await sweepTokenToBase(otherAddr, otherC, base, cc, notes);
  } catch (e) {
    notes.push(`Cash-out gagal: ${(e as Error).message.slice(0, 120)} — token ditahan, monitor retry.`);
  }
  txHashes.push(...sw.txHashes);

  let baseOutWei: bigint;
  if (base.wrappable) {
    // ② WETH: unwrap SELURUH WETH (pokok + hasil swap) → ETH native.
    let unwrappedWeth = 0n;
    const wethBal: bigint = await wethC.balanceOf(w.address).catch(() => 0n);
    if (wethBal > 0n) {
      try {
        const tx = await wethC.withdraw(wethBal);
        const rc = await tx.wait();
        if (rc) txHashes.push(rc.hash);
        unwrappedWeth = wethBal;
        notes.push(`Unwrap ${msg.fmtEth(wethBal)} WETH → ETH`);
      } catch {
        notes.push('Unwrap WETH gagal — WETH tetap di wallet.');
      }
    }
    baseOutWei = unwrappedWeth + sw.baseOut;
  } else {
    // ② USDG: tetap sbg stablecoin (tak di-unwrap). Total bersih = kenaikan saldo.
    const baseAfter: bigint = await baseC.balanceOf(w.address).catch(() => baseBefore);
    baseOutWei = baseAfter > baseBefore ? baseAfter - baseBefore : sw.baseOut;
    notes.push(`Terima ${ethers.formatUnits(baseOutWei, base.decimals)} ${base.symbol} (tetap sbg stablecoin)`);
  }

  if (sw.leftover) {
    notes.push('⚠️ Masih ada sisa token — akan di-retry otomatis oleh monitor.');
  }

  const ethOut = base.wrappable
    ? `${msg.fmtEth(baseOutWei)} ETH`
    : `${ethers.formatUnits(baseOutWei, base.decimals)} ${base.symbol}`;
  console.log(`[cashout] #${tokenId}:`, notes.join(' | ')); // rekam ke journal
  const text = msg.msgCashOut({ tokenId, notes, ethOut, txHashes });
  // leftover = token benar-benar masih tersisa di wallet setelah semua percobaan.
  return { text, baseOutWei, leftover: sw.leftover };
}

// ── Tutup posisi Uniswap v4 (baca-saja untuk lihat; close didukung) ──
// Refresh satu kartu v4 (menggantikan tombol ➕ yang dihapus).
bot.action(/^posv4:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cc = getChain();
  try {
    const list = await listPositionsV4(cc);
    const p = list.find((x) => x.tokenId === ctx.match[1]);
    if (!p) return ctx.editMessageText(msg.msgAlreadyClosed(ctx.match[1]), html);
    const c = buildV4Card(p, await getEthUsd(cc.wethAddress, cc).catch(() => null));
    await ctx.editMessageText(c.text, c.extra);
  } catch (e) {
    if (!/not modified/i.test((e as Error).message)) {
      await ctx.reply(msg.msgError('posisi v4', (e as Error).message), html);
    }
  }
});

bot.action(/^closev4:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgV4CloseConfirm(tokenId), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⛔ Tutup Posisi v4', `closev4go:${tokenId}`)], // aksi uang: baris sendiri
      [Markup.button.callback('Batal', 'cancel')],
    ]),
  });
});

bot.action(/^closev4go:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  const key = `v4:${tokenId}`;
  if (closeLocked(key)) return ctx.answerCbQuery('Sedang diproses…');
  closingInFlight.set(key, Date.now());
  const cc = getChain();
  const tracked = v4store.getV4(tokenId); // tangkap SEBELUM removeV4
  const beforeWei = await cc.provider.getBalance(cc.wallet.address).catch(() => null);
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Diproses…');
    await ctx.editMessageText(msg.msgProgress('menutup posisi v4…'), html).catch(() => {});
    const r = await closePositionV4(tokenId, cc, { dryRun: config.safety.dryRun });
    if (!r.dryRun) {
      // Jurnalkan sebelum berhenti melacak — tanpa ini /history & /pnl buta pada v4,
      // dan sisa token v4 tak pernah jadi kandidat sweep (ca hanya ada di jurnal).
      if (r.base === 'ETH' || r.base === 'USDG') {
        const afterWei =
          r.base === 'ETH' ? await cc.provider.getBalance(cc.wallet.address).catch(() => null) : null;
        // ponytail: hasil ETH = delta saldo native (ikut memotong gas → PnL konservatif).
        // Ledger presisi baru perlu kalau v4 jadi jalur utama.
        const measured =
          beforeWei !== null && afterWei !== null && afterWei > beforeWei ? afterWei - beforeWei : undefined;
        journal.recordClose(
          {
            tokenId,
            symbol: `${r.sym0}/${r.sym1}`,
            ca: r.other,
            chain: cc.key,
            baseKind: r.base === 'USDG' ? 'usdg' : 'weth',
            openedAt: tracked?.openedAt ?? Date.now(),
            initialWethWei: tracked?.entryBaseWei ?? '0',
          },
          { resultEthWei: measured, reason: 'cashed' },
        );
      }
      v4store.removeV4(tokenId); // berhenti dilacak setelah tertutup
    }
    await ctx.reply(
      msg.msgV4Closed({
        tokenId,
        base: r.base,
        cashedOut: r.cashedOut,
        leftover: !!r.leftover,
        txHash: r.txHash,
        dryRun: !!r.dryRun,
      }),
      html,
    );
  } catch (e) {
    await ctx.reply(msg.msgError('close v4', (e as Error).message), html);
  } finally {
    closingInFlight.delete(key);
    store.endMoneyOp();
  }
});

// Batal berlaku untuk semua alur (wizard /add maupun konfirmasi tutup).
bot.action('cancel', async (ctx) => {
  resetFlows(ctx.from!.id);
  await ctx.answerCbQuery('Dibatalkan');
  await ctx.editMessageText(msg.msgCancelled(), html);
});

// Penangkap ketikan nominal (didaftarkan TERAKHIR agar tak menelan command).
// ---------- /size — preset nominal per-aset (ETH & Stablecoin) ----------
// CRUD tombol dulu memakai Map state + 5 handler; satu baris ketikan cukup dan
// menutup bug "ketikanku ditelan editor preset".
type SizeKind = store.SizeKind; // 'eth' | 'stable'

function cmdSize(ctx: any) {
  const args = String(ctx.message?.text ?? '').trim().split(/\s+/).slice(1);
  const kind: SizeKind = args[0] === '$' || args[0]?.toLowerCase() === 'stable' ? 'stable' : 'eth';
  const nums = args.map(Number).filter((n) => n > 0);
  if (nums.length) store.setSizes(kind, nums);
  return ctx.reply(
    msg.msgSizeList(kind === 'eth' ? 'ETH' : 'Stablecoin', kind === 'eth' ? 'ETH' : '$', store.getSizes(kind)),
    html,
  );
}
bot.command('size', cmdSize);

bot.on(message('text'), async (ctx) => {
  const raw = (ctx.message.text || '').trim();

  // /bridge menunggu ketikan jumlah → minta quote Relay → kartu konfirmasi.
  const fflow = fundFlows.get(ctx.from.id);
  if (fflow?.awaitingAmount && isStaleFlow(fflow.startedAt)) {
    fundFlows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  if (fflow?.awaitingAmount) {
    const rh = getChain();
    const stable = CHAINS.stable;
    if (!stable?.usdtAddress) return ctx.reply(msg.msgFundNoStable(), html);
    const usdg = rh.usdgAddress;
    // Rakit parameter bridge per arah.
    let originCtx: ChainCtx, originCurrency: string, amountWei: bigint, destChainId: number, destCurrency: string, label: string;
    if (fflow.dir === 'topup') {
      originCtx = rh;
      originCurrency = fflow.asset === 'eth' ? NATIVE : usdg!;
      const w = parseAmt(raw, fflow.asset === 'eth' ? 18 : 6);
      if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
      amountWei = w;
      destChainId = stable.chainId;
      destCurrency = stable.usdtAddress;
      label = `${fflow.asset === 'eth' ? 'ETH' : 'USDG'}→USDT`;
    } else {
      originCtx = stable;
      originCurrency = stable.usdtAddress;
      const w = parseAmt(raw, 6);
      if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
      amountWei = w;
      destChainId = rh.chainId;
      destCurrency = fflow.asset === 'eth' ? NATIVE : usdg!;
      label = `USDT→${fflow.asset === 'eth' ? 'ETH' : 'USDG'}`;
    }
    // Cek saldo cukup di chain asal (best-effort).
    try {
      if (fflow.dir === 'topup' && fflow.asset === 'eth') {
        const bal = await rh.provider.getBalance(rh.wallet.address);
        if (amountWei + ethers.parseEther('0.0005') > bal)
          return ctx.reply(msg.msgError('fund', `Saldo ETH kurang (ada ${ethers.formatEther(bal)}).`), html);
      } else {
        const tokenAddr = fflow.dir === 'topup' ? usdg! : stable.usdtAddress;
        const uc = new ethers.Contract(tokenAddr, ERC20_ABI, originCtx.provider);
        const bal: bigint = await uc.balanceOf(originCtx.wallet.address);
        if (amountWei > bal)
          return ctx.reply(msg.msgError('fund', `Saldo kurang (ada ${ethers.formatUnits(bal, 6)}).`), html);
      }
    } catch {
      /* cek saldo best-effort */
    }
    const prog = await ctx.reply(msg.msgProgress('minta quote Relay…'), html);
    try {
      const quote = await getBridgeQuote({
        originCtx,
        originCurrency,
        amountWei,
        destChainId,
        destCurrency,
        recipient: originCtx.wallet.address,
      });
      fflow.quote = quote;
      fflow.startedAt = Date.now(); // umur QUOTE, bukan umur alur
      fflow.awaitingAmount = false;
      await editProgress(ctx, prog, msg.msgFundConfirm(quote, config.safety.dryRun), {
        ...html,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟢 Konfirmasi', 'fundok')],
          [Markup.button.callback('Kembali', 'fundback:amount'), Markup.button.callback('Batal', 'cancel')],
        ]),
      });
    } catch (e) {
      fundFlows.delete(ctx.from.id);
      await editProgress(ctx, prog, msg.msgError('fund', `${label}: ${(e as Error).message}`));
    }
    return;
  }

  // /buy /sell token: menunggu alamat kontrak, lalu jumlah → quote rute terbaik → konfirmasi.
  const tflow = tswapFlows.get(ctx.from.id);
  if (tflow && (tflow.awaitingCA || tflow.awaitingToken || tflow.awaitingAmount) && isStaleFlow(tflow.startedAt)) {
    tswapFlows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  if (tflow?.awaitingCA) {
    // /buy alur CA-dulu: user tempel CA → deteksi chain → safety.
    tflow.awaitingCA = false;
    const prog = await ctx.reply(msg.msgProgress('mendeteksi chain…'), html);
    return buyStartFromCA(ctx, raw.trim(), { message_id: prog.message_id });
  }
  if (tflow?.awaitingAmount && tflow.sellList) {
    // /sell alur holdings: user ketik jumlah token (absolut) atau "semua".
    const bal = tflow.tokenBalWei ?? 0n;
    let amountWei: bigint;
    if (/^(semua|all|max)$/i.test(raw)) {
      amountWei = bal;
    } else {
      const w = parseAmt(raw, tflow.tokenDec!);
      if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
      amountWei = w;
    }
    if (amountWei <= 0n || amountWei > bal) {
      return ctx.reply(msg.msgError('jual', `Jumlah melebihi saldo (${fmt4(tflow.tokenBalNum ?? 0)} ${tflow.tokenSym}).`), html);
    }
    const amtLabel = `${fmt4(Number(ethers.formatUnits(amountWei, tflow.tokenDec!)))} ${tflow.tokenSym}`;
    return sellPreview(ctx, tflow, amountWei, amtLabel);
  }
  if (tflow?.awaitingAmount) {
    const cc = CHAINS[tflow.chainKey]!;
    const base = tflow.base!;
    try {
      let amountWei: bigint;
      let amountInLabel: string;
      let fromAddr: string;
      let toAddr: string;
      if (tflow.buy) {
        const w = parseAmt(raw, base.decimals);
        if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
        amountWei = w;
        amountInLabel = `${raw} ${base.symbol}`;
        fromAddr = base.address;
        toAddr = tflow.token!;
      } else {
        const tc = new ethers.Contract(tflow.token!, ['function balanceOf(address) view returns (uint256)'], cc.provider);
        const balTok: bigint = await tc.balanceOf(cc.wallet.address);
        if (/^(semua|all|max)$/i.test(raw)) {
          amountWei = balTok;
        } else {
          const w = parseAmt(raw, tflow.tokenDec!);
          if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
          amountWei = w;
        }
        if (amountWei <= 0n || amountWei > balTok) {
          return ctx.reply(msg.msgError('swap', `Saldo token kurang (ada ${ethers.formatUnits(balTok, tflow.tokenDec!)}).`), html);
        }
        amountInLabel = `${Number(ethers.formatUnits(amountWei, tflow.tokenDec!)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${tflow.tokenSym}`;
        fromAddr = tflow.token!;
        toAddr = base.address;
      }
      return tswapQuoteConfirm(ctx, tflow, cc, fromAddr, toAddr, amountWei, amountInLabel);
    } catch (e) {
      tswapFlows.delete(ctx.from.id);
      return ctx.reply(msg.msgError('swap', (e as Error).message), html);
    }
  }

  // Wizard /add menunggu ketikan nominal.
  const flow = getFlow(ctx);
  if (flow?.awaitingAmount && isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  if (flow?.awaitingAmount && flow.rangePct !== undefined) {
    const a = amountCtx(flow);
    const dec = baseOf(getChain(flow.chain), flow.base ?? 'weth').decimals;
    const w = parseAmt(raw, dec);
    if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
    const num = Number(ethers.formatUnits(w, dec));
    if (num > a.cap) return ctx.reply(msg.msgOverLimit(a.capLabel), html);
    flow.awaitingAmount = false;
    flow.ethAmount = ethers.formatUnits(w, dec); // sudah dinormalisasi (desimal dipotong)
    try {
      await renderPlanStep(ctx, flow, false);
    } catch (err) {
      await ctx.reply(msg.msgError('plan', (err as Error).message), html);
    }
    return;
  }

  // CA telanjang (tanpa command) → HUB TOKEN. Ini dicek SETELAH semua alur yang
  // sedang menunggu ketikan, supaya tempel CA di tengah wizard tak membajaknya.
  // (cast: isAddress adalah type-guard — tanpa ini TS menyempitkan `raw` jadi never di bawah)
  const isCa = ethers.isAddress(raw) as boolean;
  if (isCa) return startTokenHub(ctx, ethers.getAddress(raw));

  // Bukan command (command sudah ditangani handler lain) → unknown.
  // Abaikan string kosong / pure number di luar konteks.
  if (!raw || raw.startsWith('/')) {
    // Command tak dikenal (telegraf tidak match): /foo
    if (raw.startsWith('/')) {
      const cmd = raw.split(/\s+/)[0];
      return ctx.reply(msg.msgUnknown(cmd), html);
    }
    return;
  }
  return ctx.reply(msg.msgUnknown(raw), html);
});

bot.catch((err, ctx) => {
  // Tombol berputar sampai timeout kalau error terjadi sebelum answerCbQuery.
  if (ctx.callbackQuery) ctx.answerCbQuery('Gagal — lihat pesan.').catch(() => {});
  console.error('Bot error:', err);
  ctx.reply?.(msg.msgError('bot', (err as Error).message), html).catch(() => {});
});

/** Daftar command menu Telegram (tombol "/" / Menu). */
const BOT_COMMANDS = [
  // '/start' sengaja TIDAK didaftarkan: Telegram mengirimnya sendiri saat chat dibuka
  // & tombol Start ditekan. Kartunya = penanda bot hidup + hasil sinkron on-chain;
  // daftar perintah ada di /help.
  { command: 'help', description: 'Menu, mode bot & daftar perintah' },
  { command: 'status', description: 'Koneksi jaringan & saldo dompet' },
  { command: 'positions', description: 'Posisi LP yang aktif (live)' },
  { command: 'explore', description: 'Top pool by APR (ETH/USDG) — sinkron Uniswap' },
  { command: 'history', description: 'Riwayat trade tertutup (jurnal)' },
  { command: 'pnl', description: 'Rekap PnL seumur hidup' },
  { command: 'add', description: 'Tambah LP: /add <CA>' },
  { command: 'stop', description: 'Tutup posisi LP' },
  { command: 'closeall', description: 'Darurat: tutup semua posisi (konfirmasi per posisi)' },
  { command: 'buy', description: 'Beli token (rute terbaik)' },
  { command: 'sell', description: 'Jual token (rute terbaik)' },
  { command: 'bridge', description: 'Antar-chain → USDT @Stable' },
  { command: 'size', description: 'Preset nominal (ETH & Stablecoin)' },
] as const;

/**
 * Pasang menu command di scope yang dipakai chat private.
 * - default + all_private_chats + chat owner
 * - language_code id/en (klien ID/EN kadang tidak fallback ke default)
 * - setChatMenuButton → commands (bukan web-app kosong)
 */
async function registerBotCommands() {
  const scopes: Array<Record<string, unknown>> = [
    { type: 'default' },
    { type: 'all_private_chats' },
    { type: 'chat', chat_id: config.telegram.allowedUserId },
  ];
  const cmds = [...BOT_COMMANDS];

  // Loop deleteMyCommands dulu mengirim 9 panggilan sia-sia (scope-nya di-set ulang
  // beberapa baris di bawah) dan memakai language_code 'in' yang bukan kode sah.
  for (const scope of scopes) {
    try {
      await bot.telegram.setMyCommands(cmds, { scope: scope as any });
    } catch (e) {
      console.error('[setMyCommands]', scope.type, (e as Error).message);
    }
    for (const lang of ['id', 'en']) {
      try {
        await bot.telegram.setMyCommands(cmds, {
          scope: scope as any,
          language_code: lang,
        });
      } catch (e) {
        console.error('[setMyCommands]', scope.type, lang, (e as Error).message);
      }
    }
  }

  try {
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
  } catch (e) {
    console.error('[setChatMenuButton] default', (e as Error).message);
  }
  try {
    await bot.telegram.setChatMenuButton({
      chatId: config.telegram.allowedUserId,
      menuButton: { type: 'commands' },
    });
  } catch (e) {
    console.error('[setChatMenuButton] chat', (e as Error).message);
  }

  try {
    const list = await bot.telegram.getMyCommands();
    console.log(
      'Menu commands:',
      list.map((c) => c.command).join(', ') || '(kosong!)',
    );
  } catch (e) {
    console.error('[getMyCommands]', (e as Error).message);
  }
}

// --- Nyalakan ---
// launch() gagal (mis. 409 conflict saat deploy overlap / jaringan) → RETRY dgn
// backoff, bukan langsung exit. 409 = instance lama masih polling; tunggu ia lepas.
// Menyerah setelah maxTries → exit(1), systemd auto-restart.
function launchWithRetry(attempt = 1, maxTries = 6) {
  bot.launch().then(
    async () => {
      console.log(
        'PHILIPS online | wallet:',
        wallet.address,
        '| mode:',
        msg.modeLabel(config.safety.dryRun),
      );
      // Setelah launch — pastikan menu "/" terisi (bukan fire-and-forget buta).
      await registerBotCommands();
    },
    (err) => {
      const is409 =
        (err as any)?.response?.error_code === 409 ||
        /409|conflict|terminated by other getUpdates/i.test(String((err as Error)?.message ?? err));
      console.error(
        `Launch gagal (percobaan ${attempt}/${maxTries})${is409 ? ' [409 — instance lain masih polling]' : ''}:`,
        err,
      );
      if (attempt >= maxTries) {
        process.exit(1);
        return;
      }
      setTimeout(() => launchWithRetry(attempt + 1, maxTries), is409 ? 5000 : 2000);
    },
  );
}
launchWithRetry();
startMonitor(bot); // auto-monitor posisi aktif

// --- Auto-recovery: error tak tertangani → log + notif + restart via systemd ---
async function notifyCrash(kind: string, err: unknown) {
  try {
    await bot.telegram.sendMessage(
      config.telegram.allowedUserId,
      msg.msgCrash(kind, String((err as Error)?.message ?? err)),
      html,
    );
  } catch {
    /* abaikan */
  }
}
process.on('uncaughtException', async (err) => {
  console.error('uncaughtException:', err);
  await notifyCrash('uncaughtException', err);
  process.exit(1); // systemd Restart=always menghidupkan lagi
});
process.on('unhandledRejection', (err) => {
  // Jangan matikan proses untuk rejection lepas — cukup log (aman utk polling).
  console.error('unhandledRejection:', err);
});

// Shutdown bersih: stop polling lalu KELUAR (sebelumnya menggantung sampai SIGKILL).
const shutdown = (sig: string) => {
  try {
    bot.stop(sig);
  } catch {
    /* abaikan */
  }
  setTimeout(() => process.exit(0), 1500).unref();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
