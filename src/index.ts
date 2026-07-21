import { Telegraf, Markup, Input } from 'telegraf';
import { renderProfitCard } from './card.js';
import { message } from 'telegraf/filters';
import { ethers } from 'ethers';
import { config } from './config.js';
import { provider, wallet, positionManager, weth, ERC20_ABI } from './chain.js';
import {
  planAddSingleSided,
  executeAdd,
  executeRemove,
  getPositionDetail,
  discoverPools,
  discoverPoolsCached,
  discoverAllPools,
  listPositions,
  type AddPlan,
  type PoolOption,
  type PositionDetail,
} from './uniswap.js';
import { listPositionsV4, v4Supported, closePositionV4, openPositionV4, getPoolKeyV4 } from './uniswapV4.js';
import { screenToken, formatScreen, getEthUsd } from './screening.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust } from './relay.js';
import { swapEthToUsdg, swapUsdgToEth, type SwapDir } from './swap.js';
import { startMonitor } from './monitor.js';
import * as store from './store.js';
import * as journal from './journal.js';
import * as msg from './messages.js';
import { MENU_KEYBOARD, resolveMenu } from './menu.js';
import {
  CHAINS,
  getChain,
  detectChains,
  baseOf,
  detectBase,
  type ChainCtx,
  type BaseKind,
  type BaseAsset,
} from './chains.js';

const WETH_ADDRESS = config.uniswap.weth;

// Posisi sudah di-burn/tak ada di chain (NFT hilang).
const isGoneErr = (e: unknown) => /invalid token id/i.test(String((e as Error)?.message ?? e));

/**
 * PHILIPS LP Bot — otak utama.
 * Command aktif: /start /help /status /positions /history /add /stop /setsize
 * Screening token berjalan otomatis di dalam /add.
 */

const bot = new Telegraf(config.telegram.botToken);
// Batas ETH/tx: nilai <= 0 atau kosong berarti TANPA batas.
const rawMax = Number(config.safety.maxEthPerTx);
const maxEth = rawMax > 0 ? rawMax : Infinity;

// Estimasi unit gas buka LP (wrap + approve + mint) — untuk hitung biaya di preview.
const EST_ADD_GAS = 700_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Berapa kali maksimum ulangi swap saat cash-out sampai token benar-benar habis.
const MAX_CLOSE_SWEEP = 4;
/** Max token hold ditampilkan di /status (setelah filter saldo > 0). */
const HOLDINGS_CAP = 5;
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

export type Holding = { symbol: string; amount: string; usd: number | null };

/**
 * Token tersimpan di wallet untuk /status.
 * Cepat: balance-only (tanpa discover pool / harga USD) → cap top HOLDINGS_CAP.
 * usd diisi null (tampilan /status tak butuh valuasi live; hemat RPC).
 */
async function walletHoldings(cc: ChainCtx = getChain()): Promise<Holding[]> {
  const cand = new Map<string, string>(); // ca(lower) -> symbol
  for (const t of journal.recentTokens(40)) if (t.ca) cand.set(t.ca.toLowerCase(), t.symbol);
  for (const p of store.active()) if (p.ca) cand.set(p.ca.toLowerCase(), p.symbol);
  if (cand.size === 0) return [];

  // Batasi kandidat: posisi aktif dulu, lalu sisa dari jurnal.
  const entries = [...cand.entries()];
  const activeCas = new Set(store.active().map((p) => p.ca?.toLowerCase()).filter(Boolean) as string[]);
  entries.sort((a, b) => Number(activeCas.has(b[0])) - Number(activeCas.has(a[0])));
  const limited = entries.slice(0, HOLDINGS_CAND_MAX);

  type Row = { symbol: string; amountNum: number; amount: string };
  const rows = (
    await Promise.all(
      limited.map(async ([ca, sym]): Promise<Row | null> => {
        try {
          const erc = new ethers.Contract(ca, ERC20_ABI, cc.provider);
          // balance dulu; decimals/symbol hanya jika saldo > 0
          const bal: bigint = await erc.balanceOf(cc.wallet.address);
          if (bal === 0n) return null;
          const [decR, symR] = await Promise.allSettled([erc.decimals(), erc.symbol()]);
          const dec = decR.status === 'fulfilled' ? Number(decR.value) : 18;
          const symbol = symR.status === 'fulfilled' ? String(symR.value) : sym;
          const amountNum = Number(ethers.formatUnits(bal, dec));
          return {
            symbol,
            amountNum,
            amount: amountNum.toLocaleString('en-US', { maximumFractionDigits: 4 }),
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean) as Row[];

  // Tanpa USD: urut jumlah mentah (approx); cap.
  rows.sort((a, b) => b.amountNum - a.amountNum);
  return rows.slice(0, HOLDINGS_CAP).map((r) => ({
    symbol: r.symbol,
    amount: r.amount,
    usd: null,
  }));
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
      if (base.kind === 'usdg') {
        const r = await swapTokenToUsdgRobust(otherAddr, bal, base.address, cc);
        baseOut += r.outWei;
        txHashes.push(...r.txHashes);
        notes.push(`Swap ${attempt}: token → USDG via ${r.route}`);
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
  const gasWei = gasPrice * EST_ADD_GAS;

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
  pools: PoolOption[];
  base?: BaseKind; // pasangan pool terpilih (weth | usdg)
  fee?: number;
  rangePct?: number;
  ethAmount?: string;
  awaitingAmount?: boolean; // menunggu user mengetik nominal
  plan?: AddPlan;
};
const flows = new Map<number, AddFlow>();
// Preset nominal ETH: tersimpan di data/settings.json, dikelola via /setsize.

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
  if (ctx.from?.id !== config.telegram.allowedUserId) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Tidak berhak.');
    return ctx.reply(msg.msgDenied(), html);
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
    const base = detectBase(cc, p.token0, p.token1) ?? baseOf(cc, 'weth');
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

bot.start(async (ctx) => {
  const { imported, gone } = await syncOnChainPositions().catch(() => ({ imported: 0, gone: 0 }));
  await ctx.reply(msg.msgStart(config.safety.dryRun), { ...html, reply_markup: MENU_KEYBOARD });
  if (imported || gone) await ctx.reply(msg.msgSyncResult(imported, gone), html).catch(() => {});
});
bot.command(['help', 'menu'], (ctx) =>
  ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, reply_markup: MENU_KEYBOARD }),
);

async function renderStatus(ctx: any, edit: boolean) {
  try {
    const network = await provider.getNetwork();
    // Saldo gas di SEMUA chain (paralel; chain yang gagal ditampilkan '?').
    const balances = await Promise.all(
      Object.values(CHAINS).map(async (c) => {
        try {
          const b = await c.provider.getBalance(c.wallet.address);
          return `${c.label} ${Number(ethers.formatEther(b)).toFixed(4)} ${c.nativeSymbol}`;
        } catch {
          return `${c.label} ?`;
        }
      }),
    );
    // Token yang tersimpan di wallet + nilai USD (best-effort; gagal → kosong).
    let holdings: Holding[] = [];
    try {
      holdings = await walletHoldings();
    } catch {
      /* abaikan — status tetap tampil tanpa holdings */
    }
    // Saldo USDG (base asset) di chain utama — best-effort; hanya tampil bila > 0.
    let usdg: string | undefined;
    try {
      const cc = getChain();
      if (cc.usdgAddress) {
        const uc = new ethers.Contract(cc.usdgAddress, ERC20_ABI, cc.provider);
        const b: bigint = await uc.balanceOf(cc.wallet.address);
        const amt = Number(ethers.formatUnits(b, 6));
        if (amt > 0) usdg = amt.toFixed(2);
      }
    } catch {
      /* abaikan — status tetap tampil tanpa USDG */
    }
    const text = msg.msgStatus({
      dryRun: config.safety.dryRun,
      chainId: network.chainId,
      gasEth: balances.join(' · '),
      positions: store.active().length,
      maxEthLabel,
      wallet: wallet.address,
      usdg,
      holdings,
    });
    const extra = {
      ...html,
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'refresh:status')]]),
    };
    await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
  } catch (err) {
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
  if (baseKind === 'usdg') return amountFloat; // USDG ≈ $1
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
    ? `${msg.usdSigned(usd)} (${msg.pctSigned(pct)})`
    : `${pnlF >= 0 ? '+' : ''}${pnlF.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol} (${msg.pctSigned(pct)})`;
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
        text: msg.msgPositionGone(rec.tokenId, rec.symbol, rec.baseKind === 'usdg' ? 'USDG' : 'WETH'),
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
  const invest = rec.imported ? '—' : (rec.nominalEth ?? msg.cleanEth(BigInt(rec.initialWethWei)));
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
        Markup.button.callback('Tutup', `stop:${rec.tokenId}`),
        Markup.button.callback('Detail', `detail:${rec.tokenId}`),
        Markup.button.callback('Refresh', `back:card:${rec.tokenId}`),
      ],
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

// /positions HANYA menampilkan posisi live (history ada di /history).
async function cmdPositions(ctx: any) {
  const active = store.active();
  const cc = getChain();
  // Posisi Uniswap v4 (baca-saja) — jangan gagalkan /positions bila error.
  const v4 = v4Supported(cc) ? await listPositionsV4(cc).catch(() => []) : [];

  if (active.length === 0 && v4.length === 0) {
    return ctx.reply(msg.msgNoPositions(), html);
  }
  // Header hanya jika >1 posisi v3 (1 kartu sudah self-explanatory).
  if (active.length > 1) {
    await ctx.reply(msg.msgPositionsHeader(active.length), html);
  }
  // v3: build RPC parallel (bounded), kirim ke TG sequential (urutan stabil).
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
  for (const c of cards) {
    await ctx.reply(c.text, c.extra);
  }
  // v4: kartu + tombol tutup (close v4 sudah didukung; add belum).
  for (const p of v4) {
    const feeLabel = p.dynamicFee ? 'dynamic' : `${(p.fee / 10000).toFixed(p.fee % 100 ? 2 : 0)}%`;
    await ctx
      .reply(
        msg.msgV4Position({
          tokenId: p.tokenId,
          pair: `${p.sym0} / ${p.sym1}`,
          feeLabel,
          rangeLabel: `tick ${p.tickLower} … ${p.tickUpper}`,
          liqLabel: p.liquidity.toString(),
          hasHooks: p.hasHooks,
        }),
        {
          ...html,
          ...Markup.inlineKeyboard([
            // Add single-sided ETH (pool base ETH saja) pakai preset nominal.
            ...(p.base === 'ETH'
              ? [store.getSizes().map((s) => Markup.button.callback(`➕ ${s} ETH`, `addv4:${p.tokenId}:${s}`))]
              : []),
            [Markup.button.callback('🔴 Tutup posisi v4', `closev4:${p.tokenId}`)],
          ]),
        },
      )
      .catch(() => {});
  }
}
bot.command('positions', cmdPositions);

// /history — riwayat trade tertutup, dari file jurnal khusus (tak muncul di /positions).
function cmdHistory(ctx: any) {
  const items = journal.read(20).map((e) => ({
    tokenId: e.tokenId,
    symbol: e.symbol,
    pnlPct: e.pnlPct,
    pnlEth: e.pnlEth,
    reason: e.reason,
    ca: e.ca,
    chain: e.chain,
    closedAt: e.closedAt,
  }));
  return ctx.reply(msg.msgJournal(items), html);
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
    }),
    html,
  );
}
bot.command('pnl', cmdPnl);

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
function poolKeyboard(pools: PoolOption[]) {
  return Markup.inlineKeyboard([
    ...pools.map((p) => [
      Markup.button.callback(
        `${p.baseSymbol} · ${msg.feeLabel(p.fee)} · ${Number(ethers.formatUnits(p.baseReserve, p.baseDecimals)).toFixed(2)} ${p.baseSymbol}`,
        `pick:${p.base}:${p.fee}`,
      ),
    ]),
    [Markup.button.callback('Batal', 'cancel')],
  ]);
}

/** Langkah 1/3 — pilih pool (pasangan + fee tier). */
async function renderPoolStep(ctx: any, flow: AddFlow, edit: boolean) {
  const text = msg.msgPoolStep();
  const extra = { ...html, ...poolKeyboard(flow.pools) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Step 2/4 — pilih lebar rentang (%). */
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
async function renderAmountStep(ctx: any, flow: AddFlow, edit: boolean) {
  flow.awaitingAmount = false;
  const presets = store.getSizes().filter((a) => a <= maxEth);
  const rows: any[] = [];
  for (let i = 0; i < presets.length; i += 2) {
    rows.push(presets.slice(i, i + 2).map((a) => Markup.button.callback(`${a} ETH`, `amt:${a}`)));
  }
  rows.push([Markup.button.callback('Ketik nominal', 'amt:custom')]);
  rows.push([
    Markup.button.callback('Kembali', 'back:range'),
    Markup.button.callback('Batal', 'cancel'),
  ]);
  const text = msg.msgAmountStep(maxEthLabel);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 4/4 — hitung & tampilkan rencana + konfirmasi. */
async function renderPlanStep(ctx: any, flow: AddFlow, edit: boolean) {
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
  const text = msg.msgPlanStep({
    screenDanger: flow.screenBahaya,
    screenFailed: flow.screenFailed,
    baseSymbol: plan.baseSymbol,
    symbol: plan.otherSymbol,
    fee: flow.fee!,
    depositAmount: flow.ethAmount!,
    pctHigh: plan.pctHigh,
    pctLow: plan.pctLow,
    currentPrice: String(plan.currentPrice),
    gasEth: cost?.gasEth ?? '?',
    needLabel: cost?.needLabel ?? '?',
    balanceLabel: cost?.balanceLabel ?? '?',
    shortLabel: cost?.shortLabel ?? null,
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
) {
  const cc = getChain(chainKey);

  // 1) Screening token (di chain terpilih).
  let screenBahaya = false;
  let screenFailed = false;
  prog = await editProgress(ctx, prog, msg.msgProgress(`menyaring token di ${cc.label}…`));
  try {
    const s = await screenToken(token, cc);
    screenBahaya = s.verdict === 'BAHAYA';
    // Kartu screen = pesan terpisah (isi panjang, perlu dibaca).
    await ctx.reply(formatScreen(s), html);
  } catch {
    screenFailed = true; // gagal verifikasi → peringatan dibawa ke preview rencana
    await ctx.reply(msg.msgScreeningFailed(), html);
  }

  // 2) Cari pool berlikuiditas di SEMUA base (WETH + USDG bila ada).
  prog = await editProgress(ctx, prog, msg.msgProgress('mencari pool (WETH & USDG)…'));
  let pools: PoolOption[];
  try {
    pools = (await discoverAllPools(token, cc)).filter((p) => p.baseReserve > 0n);
  } catch (err) {
    await editProgress(ctx, prog, msg.msgError('discover', (err as Error).message));
    return;
  }
  if (pools.length === 0) {
    await editProgress(ctx, prog, msg.msgNoPools());
    return;
  }
  // "Pool terbaik": urut kedalaman dalam USD (WETH×ethUsd, USDG≈$1) menurun.
  const eu = await getEthUsd(cc.wethAddress, cc);
  const usdDepth = (p: PoolOption) => {
    const amt = Number(ethers.formatUnits(p.baseReserve, p.baseDecimals));
    return p.base === 'usdg' ? amt : eu !== null ? amt * eu : amt;
  };
  pools.sort((a, b) => usdDepth(b) - usdDepth(a));

  // 3) Mulai wizard — reuse bubble progress jadi step pilih pool.
  const flow: AddFlow = { token, chain: chainKey, screenBahaya, screenFailed, pools };
  flows.set(ctx.from.id, flow);
  await editProgress(ctx, prog, msg.msgPoolStep(), { ...html, ...poolKeyboard(pools) });
}

// Simpan token yang menunggu pilihan chain.
const pendingChain = new Map<number, string>();

bot.command(['add', 'addlp'], async (ctx) => {
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
        'Token tidak ditemukan di chain mana pun (Robinhood/Ethereum/Base/BSC).',
      ),
    );
  }
  if (found.length === 1) return continueAddlp(ctx, token, found[0].key, prog);

  // Token ada di beberapa chain → ganti progress jadi pemilih chain.
  pendingChain.set(ctx.from.id, token);
  await editProgress(ctx, prog, msg.msgChainPick(), {
    ...html,
    ...Markup.inlineKeyboard([
      ...found.map((c) => [Markup.button.callback(c.label, `chn:${c.key}`)]),
      [Markup.button.callback('Batal', 'cancel')],
    ]),
  });
});

bot.action(/^chn:(\w+)$/, async (ctx) => {
  const token = pendingChain.get(ctx.from!.id);
  pendingChain.delete(ctx.from!.id);
  if (!token) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  await ctx.answerCbQuery();
  // Lanjut screening; reuse pesan chain-pick sebagai progress.
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  await continueAddlp(ctx, token, ctx.match[1], prog);
});

// --- Navigasi wizard (maju & mundur) ---
const getFlow = (ctx: any): AddFlow | undefined => flows.get(ctx.from!.id);

bot.action(/^pick:(weth|usdg):(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  flow.base = ctx.match[1] as BaseKind;
  flow.fee = Number(ctx.match[2]);
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
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
  const v = ctx.match[1];
  if (v === 'custom') {
    flow.awaitingAmount = true;
    await ctx.answerCbQuery();
    await ctx.editMessageText(msg.msgAmountCustom(maxEthLabel), html);
    return;
  }
  const num = Number(v);
  if (!(num > 0) || num > maxEth) return ctx.answerCbQuery('Nominal tidak valid.');
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
  if (!flow?.plan || flow.fee === undefined || !flow.ethAmount)
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
  try {
    await ctx.editMessageText(msg.msgOpeningLp(), html);
    const { tokenId, notes } = await executeAdd(flow.plan, flow.token, flow.fee, getChain(flow.chain));
    store.add({
      tokenId,
      chain: flow.chain,
      ca: flow.token,
      fee: flow.fee,
      symbol: flow.plan.otherSymbol,
      baseKind: flow.plan.baseKind,
      initialWethWei: flow.plan.baseAmountWei.toString(), // jumlah base (unit base) saat buka
      nominalEth: flow.ethAmount,
      rangeLowPct: flow.plan.pctLow,
      rangeHighPct: flow.plan.pctHigh,
      entryPrice: flow.plan.currentPrice, // harga token saat buka → basis alert anjlok
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
    await ctx.reply(msg.msgError('addlp', (err as Error).message), html);
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
bot.command(['stop', 'stoplp'], cmdStop);

// /closeall — darurat: tutup semua posisi. Konfirmasi per posisi (mekanisme = /stop).
async function cmdCloseAll(ctx: any) {
  const n = store.active().length;
  if (n === 0) return ctx.reply(msg.msgNoActiveToStop(), html);
  await replyActiveCards(ctx, msg.msgCloseAllPick(n));
}
bot.command('closeall', cmdCloseAll);

// ---------- Swap ETH ↔ USDG ----------
type SwapFlow = { dir: SwapDir; awaitingAmount: boolean; amountWei?: bigint };
const swapFlows = new Map<number, SwapFlow>();
const swapInFlight = new Set<number>(); // cegah double-tap Konfirmasi swap

/** Chain untuk swap (default = robinhood, satu-satunya yg punya USDG). */
const swapChain = (): ChainCtx => getChain();

async function cmdSwap(ctx: any) {
  const cc = swapChain();
  if (!cc.usdgAddress) return ctx.reply(msg.msgError('swap', `USDG tak tersedia di ${cc.label}.`), html);
  await ctx.reply(msg.msgSwapPick(config.safety.dryRun), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('ETH → USDG', 'swapdir:e2u'), Markup.button.callback('USDG → ETH', 'swapdir:u2e')],
      [Markup.button.callback('Batal', 'cancel')],
    ]),
  });
}
bot.command('swap', cmdSwap);

bot.action(/^swapdir:(e2u|u2e)$/, async (ctx) => {
  const dir = ctx.match[1] as SwapDir;
  await ctx.answerCbQuery();
  const cc = swapChain();
  let balanceLine = '';
  try {
    if (dir === 'e2u') {
      const b = await cc.provider.getBalance(cc.wallet.address);
      balanceLine = msg.note(`saldo: ${Number(ethers.formatEther(b)).toFixed(5)} ETH`);
    } else {
      const usdg = new ethers.Contract(cc.usdgAddress!, ERC20_ABI, cc.provider);
      const b: bigint = await usdg.balanceOf(cc.wallet.address);
      balanceLine = msg.note(`saldo: ${Number(ethers.formatUnits(b, 6)).toFixed(2)} USDG`);
    }
  } catch {
    /* saldo opsional — lanjut tanpa baris saldo */
  }
  swapFlows.set(ctx.from!.id, { dir, awaitingAmount: true });
  await ctx.reply(msg.msgSwapAmountPrompt(dir, balanceLine), html);
});

bot.action('swapok', async (ctx) => {
  const uid = ctx.from!.id;
  const sflow = swapFlows.get(uid);
  if (!sflow || sflow.amountWei === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /swap.');
  if (swapInFlight.has(uid)) return ctx.answerCbQuery('Sedang diproses…');
  const { dir, amountWei } = sflow;
  swapFlows.delete(uid); // idempotency: hapus SEBELUM eksekusi (double-tap tak swap dobel)
  swapInFlight.add(uid);
  await ctx.answerCbQuery('Diproses…');
  const inLabel =
    dir === 'e2u' ? `${ethers.formatEther(amountWei)} ETH` : `${ethers.formatUnits(amountWei, 6)} USDG`;
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(
        msg.msgSwapDone({ dir, amountInLabel: inLabel, outLabel: '(estimasi)', dryRun: true }),
        html,
      );
      return;
    }
    await ctx.editMessageText(msg.msgProgress('menukar…'), html);
    const cc = swapChain();
    const r = dir === 'e2u' ? await swapEthToUsdg(amountWei, cc) : await swapUsdgToEth(amountWei, cc);
    const outLabel =
      dir === 'e2u'
        ? `${Number(ethers.formatUnits(r.outWei, 6)).toFixed(2)} USDG`
        : `${Number(ethers.formatEther(r.outWei)).toFixed(6)} ETH`;
    await ctx.editMessageText(
      msg.msgSwapDone({ dir, amountInLabel: inLabel, outLabel, route: r.route, dryRun: false }),
      html,
    );
  } catch (e) {
    await ctx.reply(msg.msgError('swap', (e as Error).message), html);
  } finally {
    swapInFlight.delete(uid);
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
      await ctx.reply(msg.msgError('stop', (e as Error).message), html);
    }
  }
});

// tokenId yang sedang ditutup — cegah double-tap "Tutup Posisi" (tx kedua revert
// di burn & buang gas). Sinkron: has→add sebelum await pertama = atomik thd loop.
const closingInFlight = new Set<string>();

/** Kirim profit card PNG (momen kunci). Presentasi murni — dibungkus penuh,
 *  kegagalan render/kirim TAK boleh mengganggu close yang sudah sukses. */
async function sendProfitCard(
  ctx: any,
  tokenId: string,
  rec: store.PosRecord | undefined,
  baseOutWei: bigint,
): Promise<void> {
  if (!rec) return;
  const dec = rec.baseKind === 'usdg' ? 6 : 18;
  const baseSym = rec.baseKind === 'usdg' ? 'USDG' : 'WETH';
  const baseIn = Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
  const baseOut = Number(ethers.formatUnits(baseOutWei, dec));
  const pnl = baseOut - baseIn;
  const pnlPct = baseIn > 0 ? (pnl / baseIn) * 100 : 0;
  const positive = pnl >= 0;
  let usd: number | null = null;
  if (rec.baseKind === 'usdg') usd = pnl;
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
    pnlPct: msg.pctSigned(pnlPct),
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
  if (closingInFlight.has(tokenId)) return ctx.answerCbQuery('Sedang diproses…');
  closingInFlight.add(tokenId);
  const closingRec = store.get(tokenId); // tangkap SEBELUM finalizeClose menghapus
  try {
    await ctx.answerCbQuery('Diproses…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgDryRunClose(tokenId), html);
      return;
    }
    const baseSym = closingRec?.baseKind === 'usdg' ? 'USDG' : 'ETH';
    await ctx.editMessageText(msg.msgClosing(baseSym), html);
    const summary = await stopAndCashOut(tokenId, getChain(closingRec?.chain));
    finalizeClose(tokenId, { resultEthWei: summary.baseOutWei, reason: 'cashed', keep: summary.leftover });
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
  const base = detectBase(cc, p.token0, p.token1) ?? baseOf(cc, 'weth');
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
  const sw = await sweepTokenToBase(otherAddr, otherC, base, cc, notes);
  txHashes.push(...sw.txHashes);

  let baseOutWei: bigint;
  if (base.wrappable) {
    // ② WETH: unwrap SELURUH WETH (pokok + hasil swap) → ETH native.
    let unwrappedWeth = 0n;
    const wethBal: bigint = await wethC.balanceOf(w.address);
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
    const baseAfter: bigint = await baseC.balanceOf(w.address);
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
bot.action(/^closev4:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgV4CloseConfirm(tokenId), {
    ...html,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⛔ Ya, tutup v4', `closev4go:${tokenId}`),
        Markup.button.callback('Batal', 'cancel'),
      ],
    ]),
  });
});

bot.action(/^closev4go:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  const key = `v4:${tokenId}`;
  if (closingInFlight.has(key)) return ctx.answerCbQuery('Sedang diproses…');
  closingInFlight.add(key);
  try {
    await ctx.answerCbQuery('Diproses…');
    await ctx.editMessageText(msg.msgProgress('menutup posisi v4…'), html).catch(() => {});
    const r = await closePositionV4(tokenId, getChain(), { dryRun: config.safety.dryRun });
    if (r.dryRun) {
      await ctx.reply(`⚪ DRY-RUN — simulasi close v4 #${tokenId} VALID${r.base ? ` lalu cash-out semua ke ${r.base}` : ''}.`, html);
    } else {
      let line = `✅ Close v4 #${tokenId} berhasil.`;
      if (r.cashedOut) line += ` Cash-out → semua ${r.cashedOut}.`;
      else if (r.base && r.leftover) line += ` ⚠️ Cash-out ke ${r.base} tak dapat rute — ${r.sym0}/${r.sym1} tetap di wallet (bisa /swap manual).`;
      else line += ` Diterima ${r.sym0} + ${r.sym1}.`;
      await ctx.reply(`${line}\ntx: ${r.txHash}`, html);
    }
  } catch (e) {
    await ctx.reply(msg.msgError('close v4', (e as Error).message), html);
  } finally {
    closingInFlight.delete(key);
  }
});

// ── Tambah (add) likuiditas v4 single-sided ETH ke pool existing ──
bot.action(/^addv4:(\d+):([\d.]+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  const size = ctx.match[2];
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgV4AddConfirm(tokenId, size), {
    ...html,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⛔ Ya, tambah', `addv4go:${tokenId}:${size}`),
        Markup.button.callback('Batal', 'cancel'),
      ],
    ]),
  });
});

bot.action(/^addv4go:(\d+):([\d.]+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  const size = ctx.match[2];
  const key = `addv4:${tokenId}:${size}`;
  if (closingInFlight.has(key)) return ctx.answerCbQuery('Sedang diproses…');
  closingInFlight.add(key);
  try {
    await ctx.answerCbQuery('Diproses…');
    await ctx.editMessageText(msg.msgProgress('menambah likuiditas v4…'), html).catch(() => {});
    const cc = getChain();
    const { poolKey, baseIsCurrency0, base } = await getPoolKeyV4(cc, tokenId);
    if (base !== 'ETH') throw new Error('Add v4 saat ini hanya untuk pool base ETH.');
    const r = await openPositionV4(cc, poolKey, baseIsCurrency0, ethers.parseEther(size), { dryRun: config.safety.dryRun });
    if (r.dryRun) {
      await ctx.reply(`⚪ DRY-RUN — simulasi add ${size} ETH v4 VALID (range tick [${r.tickLower}, ${r.tickUpper}]).`, html);
    } else {
      await ctx.reply(`✅ Add ${size} ETH v4 berhasil — posisi baru di pool #${tokenId} (range [${r.tickLower}, ${r.tickUpper}]).\ntx: ${r.txHash}`, html);
    }
  } catch (e) {
    await ctx.reply(msg.msgError('add v4', (e as Error).message), html);
  } finally {
    closingInFlight.delete(key);
  }
});

// Batal berlaku untuk semua alur (wizard /add maupun konfirmasi tutup).
bot.action('cancel', async (ctx) => {
  flows.delete(ctx.from!.id);
  swapFlows.delete(ctx.from!.id);
  await ctx.answerCbQuery('Dibatalkan');
  await ctx.editMessageText(msg.msgCancelled(), html);
});

// Penangkap ketikan nominal (didaftarkan TERAKHIR agar tak menelan command).
// ---------- /setsize : kelola preset nominal ETH (tersimpan permanen) ----------
const sizeEdit = new Map<number, 'add' | number>(); // userId -> slot yang sedang diubah

function sizeKeyboard() {
  const rows = store.getSizes().map((s, i) => [
    Markup.button.callback(`✏️ ${s} ETH`, `size:edit:${i}`),
    Markup.button.callback('🗑 Hapus', `size:del:${i}`),
  ]);
  rows.push([Markup.button.callback('➕ Tambah preset', 'size:add')]);
  return Markup.inlineKeyboard(rows);
}

const sizeText = () => msg.msgSetSize();

bot.command('setsize', (ctx) => ctx.reply(sizeText(), { ...html, ...sizeKeyboard() }));

bot.action(/^size:edit:(\d+)$/, async (ctx) => {
  sizeEdit.set(ctx.from!.id, Number(ctx.match[1]));
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgSetSizePrompt('edit'), html);
});

bot.action('size:add', async (ctx) => {
  sizeEdit.set(ctx.from!.id, 'add');
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgSetSizePrompt('add'), html);
});

bot.action(/^size:del:(\d+)$/, async (ctx) => {
  const sizes = store.getSizes();
  const removed = sizes.splice(Number(ctx.match[1]), 1);
  store.setSizes(sizes);
  await ctx.answerCbQuery(removed.length ? `${removed[0]} ETH dihapus` : 'Sudah terhapus');
  try {
    await ctx.editMessageText(sizeText(), { ...html, ...sizeKeyboard() });
  } catch (e) {
    if (!/not modified/i.test((e as Error).message)) throw e;
  }
});

bot.on(message('text'), async (ctx) => {
  const raw = (ctx.message.text || '').trim();

  // Tombol menu (reply keyboard) mengirim label sebagai teks biasa — petakan ke aksinya.
  // Label emoji tak pernah bentrok dgn input nominal (angka), aman dicek paling awal.
  const menuCmd = resolveMenu(raw);
  if (menuCmd) {
    switch (menuCmd) {
      case '/status': return renderStatus(ctx, false);
      case '/positions': return cmdPositions(ctx);
      case '/pnl': return cmdPnl(ctx);
      case '/history': return cmdHistory(ctx);
      case '/stop': return cmdStop(ctx);
      case '/swap': return cmdSwap(ctx);
      case '/setsize': return ctx.reply(sizeText(), { ...html, ...sizeKeyboard() });
      case '/help': return ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, reply_markup: MENU_KEYBOARD });
      case '/add': return ctx.reply(msg.msgAddPrompt(), html);
    }
  }

  // Sedang mengubah/menambah preset nominal? Tangkap di sini.
  const pend = sizeEdit.get(ctx.from.id);
  if (pend !== undefined) {
    const num = Number(raw);
    if (!(num > 0)) return ctx.reply(msg.msgInvalidAmount(), html);
    const sizes = store.getSizes();
    if (pend === 'add') sizes.push(num);
    else sizes[pend] = num;
    store.setSizes(sizes);
    sizeEdit.delete(ctx.from.id);
    return ctx.reply(sizeText(), { ...html, ...sizeKeyboard() });
  }

  // Swap menunggu ketikan jumlah.
  const sflow = swapFlows.get(ctx.from.id);
  if (sflow?.awaitingAmount) {
    const num = Number(raw);
    if (!(num > 0)) return ctx.reply(msg.msgInvalidAmount(), html);
    const cc = swapChain();
    try {
      const ethUsd = await getEthUsd(cc.wethAddress, cc);
      let amountWei: bigint;
      let amountInLabel: string;
      let estOutLabel: string;
      if (sflow.dir === 'e2u') {
        if (num > maxEth) return ctx.reply(msg.msgOverLimit(maxEthLabel), html);
        amountWei = ethers.parseEther(raw);
        amountInLabel = `${raw} ETH`;
        estOutLabel = ethUsd !== null ? `${(num * ethUsd).toFixed(2)} USDG` : '? USDG (harga ETH tak terbaca)';
      } else {
        amountWei = ethers.parseUnits(raw, 6);
        amountInLabel = `${raw} USDG`;
        estOutLabel =
          ethUsd !== null && ethUsd > 0 ? `${(num / ethUsd).toFixed(6)} ETH` : '? ETH (harga ETH tak terbaca)';
      }
      sflow.amountWei = amountWei;
      sflow.awaitingAmount = false;
      return ctx.reply(
        msg.msgSwapConfirm({ dir: sflow.dir, amountInLabel, estOutLabel, dryRun: config.safety.dryRun }),
        {
          ...html,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🟢 Konfirmasi', 'swapok'), Markup.button.callback('Batal', 'cancel')],
          ]),
        },
      );
    } catch (e) {
      swapFlows.delete(ctx.from.id);
      return ctx.reply(msg.msgError('swap', (e as Error).message), html);
    }
  }

  // Wizard /add menunggu ketikan nominal.
  const flow = getFlow(ctx);
  if (flow?.awaitingAmount && flow.rangePct !== undefined) {
    const num = Number(raw);
    if (!(num > 0)) return ctx.reply(msg.msgInvalidAmount(), html);
    if (num > maxEth) return ctx.reply(msg.msgOverLimit(maxEthLabel), html);
    flow.awaitingAmount = false;
    flow.ethAmount = raw;
    try {
      await renderPlanStep(ctx, flow, false);
    } catch (err) {
      await ctx.reply(msg.msgError('plan', (err as Error).message), html);
    }
    return;
  }

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
  console.error('Bot error:', err);
  ctx.reply?.(msg.msgError('bot', (err as Error).message), html).catch(() => {});
});

/** Daftar command menu Telegram (tombol "/" / Menu). */
const BOT_COMMANDS = [
  { command: 'start', description: 'Menu & status singkat' },
  { command: 'help', description: 'Daftar perintah' },
  { command: 'status', description: 'Koneksi jaringan & saldo dompet' },
  { command: 'positions', description: 'Posisi LP yang aktif (live)' },
  { command: 'history', description: 'Riwayat trade tertutup (jurnal)' },
  { command: 'pnl', description: 'Rekap PnL seumur hidup' },
  { command: 'add', description: 'Tambah LP: /add <CA>' },
  { command: 'stop', description: 'Tutup posisi LP' },
  { command: 'closeall', description: 'Darurat: tutup semua posisi (konfirmasi per posisi)' },
  { command: 'swap', description: 'Tukar ETH ↔ USDG' },
  { command: 'setsize', description: 'Kelola preset nominal ETH' },
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

  for (const lang of ['id', 'en', 'in']) {
    for (const scope of scopes) {
      try {
        await bot.telegram.deleteMyCommands({
          scope: scope as any,
          language_code: lang,
        });
      } catch {
        /* ignore */
      }
    }
  }

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
