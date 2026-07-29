import { Markup, Input } from 'telegraf';
import {
  bot,
  html,
  maxEth,
  maxEthLabel,
  sleep,
  isGoneErr,
  isStaleFlow,
  parseAmt,
  mapLimit,
  editProgress,
  resetFlows,
  registerFlowReset,
  POS_CARD_CONCURRENCY,
  registeredCommands,
} from './core.js';
import { renderProfitCard } from './card.js';
import { message } from 'telegraf/filters';
import { ethers } from 'ethers';
import { config } from './config.js';
import { provider, ERC20_ABI } from './chain.js';
import * as walletStore from './walletStore.js';
import {
  planAddSingleSided,
  planAddTokenSide,
  ADD_GAS_UNITS,
  VALID_FEES,
  executeAdd,
  executeRemove,
  collectFeesOnly,
  removeLiquidityPct,
  getPositionDetail,
  discoverAllPools,
  listPositions,
  type AddPlan,
  type PositionDetail,
} from './uniswap.js';
import { listPositionsV4, v4Supported, closePositionV4, openPositionV4, getPoolKeyV4, resolvePoolKeyV4, valuePositionV4, type V4Position } from './uniswapV4.js';
import * as v4store from './v4store.js';
import { screenToken, formatScreen, getEthUsd } from './screening.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust, NATIVE } from './relay.js';
import { startMonitor } from './monitor.js';
import * as store from './store.js';
import * as journal from './journal.js';
import * as msg from './messages.js';
import * as explore from './explore.js';
import { awaitingSecret, handleSecret } from './commands/wallet.js';
import { cmdHistory, cmdPnl } from './commands/journalCmds.js';
import './commands/feesAndRemove.js';
import './commands/alerts.js';
import {
  CHAINS,
  getChain,
  rebuildChains,
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

/**
 * PHILIPS LP Bot — otak utama.
 * Command aktif: /start /help /status /positions /history /pnl /explore /add /stop
 * /closeall /buy /sell /size
 * Screening token berjalan otomatis di dalam /add.
 */





/**
 * Ketikan nominal → wei, atau null bila tak masuk akal. `Number(raw) > 0` saja
 * meloloskan '1e-9' / desimal berlebih yang lalu membuat parseUnits melempar DI LUAR
 * try (kartu ERROR mentah). Desimal berlebih DIPOTONG (tak pernah membesarkan nominal).
 */
// Berapa kali maksimum ulangi swap saat cash-out sampai token benar-benar habis.
const MAX_CLOSE_SWEEP = 4;
/** Max token hold ditampilkan di /status (setelah filter saldo > 0). */
const SELL_HOLDINGS_CAP = 12; // maks token di daftar /sell
/** Max kandidat CA dicek balance (jurnal + posisi). */
const HOLDINGS_CAND_MAX = 20;
/** Concurrency saat membangun kartu posisi. */

/** Jalankan fn pada items dengan batas concurrency (jaga rate RPC). */


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
  tokenDec?: number; // desimal token (sisi token)
  strategy?: 'base' | 'token'; // sisi setoran: base (beli saat turun) | token (jual saat naik, Tahap 6)
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
/**
 * HUB TOKEN — tempel CA telanjang → satu kartu identitas + 4 aksi.
 * Teks & keyboard disimpan supaya tombol "Kembali" dari alur mana pun bisa
 * merender ulang TANPA screening ulang (0 RPC).
 */
type Hub = { ca: string; chainKey: string; text: string; kb: any; sym: string; dec: number; screenText: string; bahaya: boolean; reasons: string[]; failed: boolean };
const hubs = new Map<number, Hub>();

// Semua state per-user didaftarkan ke pembersih pusat. Handler teks memilih
// tujuan berdasarkan prioritas statis, jadi sisa alur lama bisa menelan ketikan
// nominal alur baru (mis. sisa /buy menangkap nominal wizard /add_lp).
registerFlowReset((uid) => {
  flows.delete(uid);
  tswapFlows.delete(uid);
  hubs.delete(uid);
});
// Sesi wizard/swap kedaluwarsa: bila user tinggalkan lalu ketik angka lain jauh
// kemudian, jangan sampai termakan flow basi. 15 menit.

// Pilihan lebar rentang (%) + label risiko.
const RANGE_OPTIONS = [
  { pct: 10, label: 'Konservatif' },
  { pct: 30, label: 'Moderat' },
  { pct: 50, label: 'Agresif' },
  { pct: 70, label: 'Sangat Agresif' },
];


/** Edit pesan progress existing, atau kirim baru bila gagal/tidak ada. */
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

// --- Penjaga: perintah yang menggerakkan dana butuh dompet terhubung ---
// Perintah baca (/status /positions /pools /token_info /help) sengaja dibiarkan
// lewat: memantau tanpa dompet itu sah, dan kartunya sendiri sudah menandai
// "belum terhubung".
const NEEDS_WALLET = /^\/(add_lp|add|remove_lp|stop|closeall|claim_fees|buy|sell)\b/;
bot.use((ctx: any, next: any) => {
  const t = ctx.message?.text ?? '';
  if (NEEDS_WALLET.test(t) && !walletStore.isConnected()) return ctx.reply(msg.msgNeedWallet(), html);
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
    [Markup.button.callback('💧 Buka LP', 'howto:add'), Markup.button.callback('📊 Top Pool', 'explore')],
    [Markup.button.callback('💰 Uang', 'status'), Markup.button.callback('📋 Posisi', 'positions')],
    [Markup.button.callback('📖 How it Works', 'howitworks')],
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
      walletShort: msg.shortAddr(cc.wallet.address),
    }),
    { ...html, ...startKeyboard() },
  );
});
bot.action('howitworks', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgHowItWorks(), html);
});
bot.action('howto:add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgAddHowTo(), html);
});

// Keyboard inline aksi cepat pada kartu /help (di samping reply-keyboard persisten).
// Grid 2 kolom (thumb-friendly, perbaikan.md §1.3); aksi uang di baris sendiri.
const helpKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💰 Status & Uang', 'status'), Markup.button.callback('📋 LP Aktif', 'positions')],
    [Markup.button.callback('🧾 PnL & Jurnal', 'pnl'), Markup.button.callback('📊 Top Pool', 'explore')],
    [Markup.button.callback('⛔ Emergency Close All', 'closeall_confirm')],
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
      wallet: getChain().wallet.address,
      chains,
      usdg,
      totalUsd,
      holdingsCount,
      lpUsd,
      lpFailed,
      realizedEth: journal.lifetimeStats().netEth,
      // Blockscout API base ('.../api/v2') = explorer web-nya tanpa suffix itu.
      explorerUrl: getChain().blockscout?.replace(/\/api\/v2\/?$/, '') ?? null,
    });
    const extra = {
      ...html,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh Data', 'refresh:status'),
          Markup.button.callback('📋 Detail Posisi', 'positions'),
        ],
        [Markup.button.callback('🧾 Rekapitulasi PnL', 'pnl')],
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
  const range = `${msg.fmtPct(pcts[0])} ⇄ ${msg.fmtPct(pcts[1])}`;
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
    side: rec.side,
    converted: !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below'),
  });
  // Tautan explorer menunjuk NFT posisinya (Blockscout: /token/<pm>/instance/<id>),
  // bukan sekadar alamat dompet — itu yang benar-benar dimaksud "lihat posisi ini".
  const explorer = cc.blockscout?.replace(/\/api\/v2\/?$/, '') ?? null;
  const rowTop = [
    Markup.button.callback('📄 Full Details', `detail:${rec.tokenId}`),
    Markup.button.callback('🔄 Refresh', `back:card:${rec.tokenId}`),
  ];
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      explorer
        ? [Markup.button.url('🔗 View on Explorer', `${explorer}/token/${cc.pmAddress}/instance/${rec.tokenId}`)]
        : [],
      rowTop,
      [
        Markup.button.callback('💵 Harvest Fees', `claim:${rec.tokenId}`),
        Markup.button.callback('🗑️ Withdraw', `rm:${rec.tokenId}`),
      ],
      [Markup.button.callback('❌ Close Position', `stop:${rec.tokenId}`)], // aksi uang: baris sendiri
      [Markup.button.callback('⬅️ Back to Positions', 'positions')],
    ].filter((r) => r.length)),
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
  strategy?: string | null;
  rangeLabel?: string | null;
  feesLabel?: string | null;
  feesUsdLabel?: string | null;
  converted?: boolean;
  convertedInto?: string | null;
  feesBase?: number; // fee belum diklaim dalam base, utk total di footer
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
        // tickLower/Upper dalam istilah TICK; dalam istilah HARGA TOKEN urutannya
        // bisa terbalik (tergantung sisi base di pool) → urutkan menaik dulu.
        strategy:
          rec.side === 'token'
            ? `Sisi ${rec.symbol} (jual saat naik)`
            : `Sisi ${d.baseSymbol} (beli saat turun)`,
        // Terkonversi penuh = harga menembus SELURUH rentang ke arah tujuan:
        // sisi base menunggu harga TURUN (selesai saat 'below'), sisi token
        // menunggu harga NAIK (selesai saat 'above').
        converted: !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below'),
        convertedInto: rec.side === 'token' ? d.baseSymbol : rec.symbol,
        rangeLabel: (() => {
          const a = Number(d.priceLower), b = Number(d.priceUpper);
          const [lo, hi] = a <= b ? [d.priceLower, d.priceUpper] : [d.priceUpper, d.priceLower];
          return `${lo} — ${hi} ${d.baseSymbol} per ${rec.symbol}`;
        })(),
        feesLabel: `${Number(ethers.formatUnits(d.feesBaseWei, dec)).toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`,
        // Fee dalam USD (design memakai satuan dolar). Harga tak terbaca → null,
        // dan kartu jatuh ke satuan base; JANGAN tampilkan $0.00 palsu.
        feesUsdLabel: await baseToUsd(d.baseKind, Number(ethers.formatUnits(d.feesBaseWei, dec)), cc)
          .then((v) => (v === null ? null : `+${msg.usdPlain(v)}`))
          .catch(() => null),
        feesBase: Number(ethers.formatUnits(d.feesBaseWei, dec)),
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
    totalFeesLabel: (() => {
      // Fee total hanya bisa dijumlah bila semua posisi memakai base yang sama;
      // sekarang base tunggal (WETH), tapi tetap jaga-jaga: lewati bila tak ada data.
      const vals = rows.map((r) => r.feesBase).filter((v): v is number => typeof v === 'number');
      return vals.length ? `≈ ${vals.reduce((a, b) => a + b, 0).toFixed(5)} WETH` : null;
    })(),
    rows,
  });

  // Maks 6 tombol id (posisi ke-7+ tetap tercantum di daftar & bisa lewat /stop).
  // Label = "#id Details": #id selalu unik, jadi dua posisi pada token yang sama
  // tak pernah menghasilkan tombol kembar yang tak bisa dibedakan.
  const top = rows.slice(0, 6);
  const idBtns = top.map((r) => Markup.button.callback(`🔍 #${r.id} Details`, `pos_detail_${r.id}`));
  // Satu tombol per baris, sesuai design.
  const kbRows: ReturnType<typeof Markup.button.callback>[][] = idBtns.map((b) => [b]);
  kbRows.push([
    Markup.button.callback('🔄 Refresh', 'positions_refresh'),
    Markup.button.callback('🚫 Close All', 'closeall_confirm'),
  ]);
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
/** Langkah 1 /add_lp tanpa CA — pair dari pool ber-APR teratas + opsi cari sendiri. */
async function pairPicker(ctx: any) {
  const prog = await ctx.reply(msg.msgProgress('memuat pool teratas…'), html);
  const pools = await explore.fetchTopPools(getChain(), 5).catch(() => []);
  const withCa = pools.filter((p) => p.otherAddr);
  const rows = withCa.map((p) => [
    Markup.button.callback(`${p.pair} · ${msg.feeLabel(p.feeTier)}`, `x:${p.otherAddr}`),
  ]);
  rows.push([Markup.button.callback('🔍 Cari Pair Sendiri', 'pair:custom')]);
  rows.push([Markup.button.callback('Batal', 'cancel')]);
  await editProgress(ctx, prog, msg.msgPairPicker(withCa.length), { ...html, ...Markup.inlineKeyboard(rows) });
}

bot.action('pair:custom', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgPairCustom(), html);
});

bot.command('pools', cmdExplore);

// /token_info <CA> — audit keamanan token. Jalurnya sama persis dengan menempel
// CA di chat (openHub), jadi tak ada logika audit kedua yang bisa menyimpang.
bot.command('token_info', async (ctx: any) => {
  const ca = (ctx.message?.text || '').split(/\s+/)[1];
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca))
    return ctx.reply(msg.msgTokenInfoUsage(), html);
  return startTokenHub(ctx, ca);
});
bot.command('explore', cmdExplore); // alias lama
// Tombol '📊 Explore Pool' di kartu /help.
bot.action('explore', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdExplore(ctx);
});

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
const POOL_PICK_MAX = 3; // TOP 3 by TVL — sisanya tak ditawarkan

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
// Urutan pool: TVL TERBESAR dulu, titik. Spacing hanya jadi pemutus saat TVL sama.
//
// Sebelumnya urutannya memakai tier log10 TVL lalu spacing terhalus, sehingga pool
// ber-TVL lebih kecil bisa naik ke atas selama masih se-orde. Sekarang murni TVL:
// yang tampil benar-benar tiga terdalam. Konsekuensinya, pool teratas bisa punya
// spacing kasar (isi single-side lebih lambat) — karena itu angka 'isi≤x%' tetap
// dicetak di tombolnya supaya kompromi itu kelihatan sebelum ditekan.
function rankPoolsForFill(pools: explore.TokenPool[]): explore.TokenPool[] {
  return [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd || poolSpacing(a) - poolSpacing(b));
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
  const text = msg.msgPoolStep(`${flow.pools[0]?.otherSymbol ?? '?'} · ${getChain(flow.chain).label}`);
  const extra = { ...html, ...poolKeyboard(flow.pools) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 2/5 — pilih sisi setoran (strategi). */
async function renderStrategyStep(ctx: any, flow: AddFlow, edit: boolean) {
  const sel = flow.selected;
  const base = wizardBase(flow);
  const text = msg.msgStrategyStep(
    sel ? `${sel.baseSymbol}/${sel.otherSymbol}` : '?',
    base.symbol,
    sel?.otherSymbol ?? 'token',
    flow.plan?.currentPrice ? String(flow.plan.currentPrice) : null,
  );
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`🟢 Sisi ${base.symbol} — beli saat harga turun`, 'strat:base')],
      [Markup.button.callback(`🔵 Sisi ${sel?.otherSymbol ?? 'Token'} — jual saat harga naik`, 'strat:token')],
      [Markup.button.callback('Kembali', 'back:pool'), Markup.button.callback('Batal', 'cancel')],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 4/5 — pilih lebar rentang (%). */
async function renderRangeStep(ctx: any, flow: AddFlow, edit: boolean) {
  const up = flow.strategy === 'token';
  const rows = RANGE_OPTIONS.map((o) => [
    Markup.button.callback(`${up ? '📈 +' : '📉 -'}${o.pct}%  ·  ${o.label}`, `rng:${o.pct}`),
  ]);
  rows.push([
    Markup.button.callback('Kembali', 'back:amount'),
    Markup.button.callback('Batal', 'cancel'),
  ]);
  const sel = flow.selected;
  const text = msg.msgRangeStep(
    flow.fee!,
    sel ? `${sel.baseSymbol}/${sel.otherSymbol} (${msg.feeLabel(sel.fee)} · ${sel.protocol})` : undefined,
    flow.strategy === 'token',
  );
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
  // Sisi token: satuannya token itu sendiri — batas MAX_ETH_PER_TX tak berlaku
  // (batas itu menjaga ETH yang keluar, sementara sisi token tak menyetor ETH).
  if (flow.strategy === 'token') {
    return {
      symbol: flow.selected?.otherSymbol ?? 'TOKEN',
      cap: Infinity,
      capLabel: 'sebanyak saldomu',
      example: '1000',
    };
  }
  return {
    symbol: base.symbol,
    cap: stable ? Infinity : maxEth, // batas ETH hanya berlaku utk base WETH
    capLabel: stable ? 'tanpa batas' : maxEthLabel,
    example: stable ? '50' : '0.02',
  };
}

async function renderAmountStep(ctx: any, flow: AddFlow, edit: boolean) {
  // Tanpa bubble preset: nominal SELALU diketik di chat.
  flow.awaitingAmount = true;
  const a = amountCtx(flow);
  const rows: any[] = [];
  // v4 lewati step rentang → "Kembali" ke pemilihan pool; v3 kembali ke rentang.
  const backTo = 'back:strategy';
  rows.push([
    Markup.button.callback('Kembali', backTo),
    Markup.button.callback('Batal', 'cancel'),
  ]);
  // Saldo base (1 RPC, gagal → '?': jangan pernah memblokir langkah ini).
  const cc = getChain(flow.chain);
  const base = wizardBase(flow);
  if (flow.strategy === 'token') {
    const dec = flow.tokenDec ?? 18;
    const bal = await new ethers.Contract(flow.token, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .then((b: bigint) => `${msg.cleanUnits(b, dec)} ${a.symbol}`)
      .catch(() => '?');
    const textT = msg.msgAmountStep(a.symbol, a.capLabel, bal);
    const extraT = { ...html, ...Markup.inlineKeyboard(rows) };
    await (edit ? ctx.editMessageText(textT, extraT) : ctx.reply(textT, extraT));
    return;
  }
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
  const tokenSide = flow.strategy === 'token';
  const [planSettled, costSettled] = await Promise.allSettled([
    tokenSide
      ? planAddTokenSide(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc)
      : planAddSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc),
    // Sisi token tak menyetor base: yang perlu dicek cuma gas, bukan saldo base.
    estimateAddCost(cc, base, tokenSide ? '0' : flow.ethAmount!),
  ]);
  if (planSettled.status === 'rejected') throw planSettled.reason;
  const plan = planSettled.value;
  flow.plan = plan;
  let cost: Awaited<ReturnType<typeof estimateAddCost>> | null = null;
  if (costSettled.status === 'fulfilled') cost = costSettled.value;
  else console.log('[estimateAddCost] gagal:', String(costSettled.reason).slice(0, 120));
  const depositUsd = tokenSide ? undefined : (await baseToUsd(base.kind, Number(flow.ethAmount!), cc)) ?? undefined;
  const text = msg.msgPlanStep({
    side: plan.side,
    depositSymbol: tokenSide ? plan.otherSymbol : plan.baseSymbol,
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
    priceLower: plan.priceLower,
    priceUpper: plan.priceUpper,
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
  pre?: { bahaya: boolean; failed: boolean; reasons?: string[] }, // screening sudah dilakukan hub → jangan ulang
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
  let bahayaReasons: string[] = pre?.reasons ?? [];
  if (!pre) {
    if (screened.status === 'fulfilled' && screened.value) {
      screenBahaya = screened.value.verdict === 'BAHAYA';
      bahayaReasons = screened.value.flags.filter((f) => f.level === 'BAHAYA').map((f) => f.msg);
      await ctx.reply(formatScreen(screened.value, { ca: token, chainLabel: cc.label }), html); // kartu screen = pesan terpisah
    } else {
      screenFailed = true; // gagal verifikasi → peringatan dibawa ke preview rencana
      await ctx.reply(msg.msgScreeningFailed(), html);
    }
  }

  // Item 20 — token ber-vonis BAHAYA: LP diblokir, bukan sekadar diperingatkan.
  // Peringatan di langkah 4 gampang dilewati satu tap; di sini alurnya berhenti.
  if (screenBahaya) {
    await editProgress(ctx, prog, msg.msgHighRiskBlocked(bahayaReasons));
    return;
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
  // poolKey v4 gateway divalidasi ke on-chain (urutan currency & ETH-native sering
  // salah). Tak terinisialisasi → pool dibuang, bukan dibiarkan revert di langkah 4.
  pools = (
    await Promise.all(
      pools.map(async (p) => {
        if (p.protocol !== 'v4' || !p.poolKey) return p;
        const fixed = await resolvePoolKeyV4(cc, p.poolKey, p.baseIsCurrency0!).catch(() => null);
        return fixed ? { ...p, poolKey: fixed.poolKey, baseIsCurrency0: fixed.baseIsCurrency0 } : null;
      }),
    )
  ).filter((p): p is explore.TokenPool => p !== null);
  if (pools.length === 0) {
    await editProgress(ctx, prog, msg.msgNoPools());
    return;
  }
  // Bias ke spacing halus (isi rapat) di antara pool likuiditas se-orde.
  pools = rankPoolsForFill(pools);

  // 3) Mulai wizard — reuse bubble progress jadi step pilih pool.
  const flow: AddFlow = { token, chain: chainKey, screenBahaya, screenFailed, pools, startedAt: Date.now() };
  flows.set(ctx.from.id, flow);
  await editProgress(ctx, prog, msg.msgPoolStep(`${pools[0]?.otherSymbol ?? '?'} · ${cc.label}`), {
    ...html,
    ...poolKeyboard(pools),
  });
}

// Simpan token yang menunggu pilihan chain.

bot.command(['add_lp', 'add'], async (ctx: any) => {
  resetFlows(ctx.from!.id); // alur baru = buang sisa alur lama (anti-hijack ketikan)
  const [, token] = ctx.message.text.trim().split(/\s+/);
  // Tanpa CA → langkah 1 naskah: pilih pair dari pool teratas, atau cari sendiri.
  if (!token) return pairPicker(ctx);
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
  flow.strategy = undefined;
  // Urutan naskah: pair → strategi → nominal → rentang → konfirmasi.
  await renderStrategyStep(ctx, flow, true);
});

bot.action(/^strat:(base|token)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add_lp.');
  if (flow.selected?.protocol === 'v4' && ctx.match[1] === 'token') {
    return ctx.answerCbQuery('Sisi token belum didukung di pool v4 — pilih pool v3.');
  }
  flow.strategy = ctx.match[1] as 'base' | 'token';
  if (flow.strategy === 'token' && flow.tokenDec === undefined) {
    const cc = getChain(flow.chain);
    flow.tokenDec = Number(
      await new ethers.Contract(flow.token, ERC20_ABI, cc.provider).decimals().catch(() => 18),
    );
  }
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

bot.action('back:strategy', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add_lp.');
  flow.strategy = undefined;
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderStrategyStep(ctx, flow, true);
});

bot.action(/^rng:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add.');
  flow.rangePct = Number(ctx.match[1]);
  flow.plan = undefined;
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
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add_lp.');
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderRangeStep(ctx, flow, true);
});

bot.action('back:amount', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.strategy === undefined) return ctx.answerCbQuery('Kedaluwarsa, ulangi /add_lp.');
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
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
      // Sisi token tak menyetor base sama sekali (baseAmountWei = 0). Modal awal
      // dicatat sebagai SETARA base pada harga saat buka — tanpa itu PnL tak punya
      // titik nol dan posisi selamanya tampil "—".
      initialWethWei: (plan.side === 'token'
        ? ethers.parseUnits(
            (Number(flow.ethAmount) * Number(plan.currentPrice)).toFixed(plan.baseDecimals),
            plan.baseDecimals,
          )
        : plan.baseAmountWei
      ).toString(),
      nominalEth: plan.side === 'token' ? undefined : flow.ethAmount,
      nominalToken: plan.side === 'token' ? flow.ethAmount : undefined,
      side: plan.side,
      rangeLowPct: plan.pctLow,
      rangeHighPct: plan.pctHigh,
      entryPrice: plan.currentPrice, // harga token saat buka → basis alert anjlok
      openedAt: Date.now(),
      status: 'ACTIVE',
      lastInRange: false,
    });
    // Ringkas OPENED di bubble yang sama, lalu kartu posisi live.
    await ctx.editMessageText(msg.msgLpOpened(tokenId, notes, `${plan.baseSymbol}/${plan.otherSymbol}`, `${plan.priceLower} — ${plan.priceUpper}`), html);
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

/** Chain yang mendukung swap token (punya router+quoter) — kini hanya Robinhood. */
const swapTokenChains = (): ChainCtx[] =>
  Object.values(CHAINS);

// /buy = alur CA-dulu · /sell = alur holdings-dulu (di bawah).
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
      flow.screenText = formatScreen(s, { ca: flow.token!, chainLabel: cc.label });
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
  // Tanpa bubble preset: nominal SELALU diketik di chat (flow.awaitingAmount).
  const rows: any[] = [];
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
  // Kartu yang TAMPIL = kartu DETAIL TOKEN hasil screening (bukan lagi msgTokenHub):
  // satu kartu, bukan dua yang isinya tumpang-tindih.
  const text = sc
    ? formatScreen(sc, {
        ca,
        chainLabel: cc.label,
        heldLabel: bal > 0n ? `${msg.cleanUnits(bal, dec)} ${sym}` : null,
        lpCount: v3.length + v4.length,
      })
    : msg.msgScreeningFailed();

  // Tombol KELUAR muncul hanya bila ada yang bisa dikeluarkan: Close LP saat ada
  // posisi, Sell Token saat saldo > 0. Tak ada = cuma jalur masuk yang tampil.
  // Buy/Sell Token juga butuh chain dengan rute swap bot.
  const swappable = swapTokenChains().some((c) => c.key === cc.key);
  const hasLp = v3.length + v4.length > 0;

  const rowLp = [Markup.button.callback('💧 Add LP', `ca:add:${ca}`)];
  if (hasLp) rowLp.push(Markup.button.callback('📤 Close LP', `ca:close:${ca}`));

  const rowTok: ReturnType<typeof Markup.button.callback>[] = [];
  if (swappable) {
    rowTok.push(Markup.button.callback('💱 Buy Token', `ca:buy:${ca}`));
    if (bal > 0n) rowTok.push(Markup.button.callback('📉 Sell Token', `ca:sell:${ca}`));
  }

  const kb = Markup.inlineKeyboard([
    rowLp,
    ...(rowTok.length ? [rowTok] : []),
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]);

  hubs.set(ctx.from.id, {
    ca,
    chainKey: cc.key,
    text,
    kb,
    sym,
    dec,
    screenText: text,
    bahaya: sc?.verdict === 'BAHAYA',
    reasons: (sc?.flags ?? []).filter((f) => f.level === 'BAHAYA').map((f) => f.msg),
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
    return continueAddlp(ctx, ca, h.chainKey, prog, { bahaya: h.bahaya, failed: h.failed, reasons: h.reasons });
  }

  // Guard tetap ada walau tombolnya kondisional: hub disimpan di memori, jadi tombol
  // dari kartu lama masih bisa ditekan setelah keadaan berubah.
  if ((what === 'buy' || what === 'sell') && !swapTokenChains().some((c) => c.key === h.chainKey)) {
    return ctx.editMessageText(
      msg.msgError(what === 'buy' ? 'beli' : 'jual', `${cc.label} belum punya rute swap bot — hanya Add LP / Close LP di chain ini.`),
      html,
    );
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
  const buf = await renderProfitCard({
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
  // sendDocument, BUKAN sendPhoto: Telegram me-render ulang foto jadi JPEG
  // (terukur 1130 KB -> 185 KB) dan artefaknya paling terlihat pada teks tajam
  // di latar gelap — persis isi kartu ini. Sebagai dokumen, PNG-nya utuh (HD).
  await ctx.replyWithDocument(Input.fromBuffer(buf, `philips-${tokenId}.png`));
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
    await ctx.reply(summary.text, {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Lihat Posisi Lain', 'positions')],
        [Markup.button.callback('💧 Buka LP Baru', 'howto:add')],
      ]),
    });
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

// Rahasia dompet yang salah kirim ke chat. Dicek PALING AWAL, sebelum handler
// alur mana pun, supaya kunci tak pernah singgah di flow/log. Pesannya juga
// dihapus — menyuruh user menghapus sendiri berarti kuncinya nongkrong di chat
// sampai dia sempat. Deteksi: private key hex 64 karakter, atau 12/24 kata BIP-39.
// Seed dicek dengan validator BIP-39 asli (checksum + wordlist), BUKAN pola
// "12 kata huruf kecil": kalimat biasa 12 kata akan lolos pola itu dan pesan
// user yang tak bersalah ikut terhapus.
const PRIVKEY_RE = /^(0x)?[a-fA-F0-9]{64}$/;
function looksLikeSecret(t: string): boolean {
  const one = t.replace(/\s+/g, ' ').trim();
  if (PRIVKEY_RE.test(one.replace(/\s/g, ''))) return true;
  const n = one.split(' ').length;
  if (n !== 12 && n !== 15 && n !== 18 && n !== 21 && n !== 24) return false;
  try {
    return ethers.Mnemonic.isValidMnemonic(one.toLowerCase());
  } catch {
    return false;
  }
}

bot.on(message('text'), async (ctx) => {
  const raw = (ctx.message.text || '').trim();

  // Alur /connect yang sedang menunggu: kunci di sini memang diminta.
  if (awaitingSecret.has(ctx.from.id)) return handleSecret(ctx, raw);

  // Item 19 — rahasia dompet di luar alur /connect: abaikan, hapus, peringatkan.
  if (looksLikeSecret(raw)) {
    await ctx.deleteMessage().catch(() => {}); // butuh hak admin di grup; di chat pribadi selalu boleh
    return ctx.reply(msg.msgSecretLeakWarning(), html);
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
  if (flow?.awaitingAmount && flow.strategy !== undefined) {
    const a = amountCtx(flow);
    const dec =
      flow.strategy === 'token'
        ? (flow.tokenDec ?? 18)
        : baseOf(getChain(flow.chain), flow.base ?? 'weth').decimals;
    const w = parseAmt(raw, dec);
    if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
    const num = Number(ethers.formatUnits(w, dec));
    if (num > a.cap) return ctx.reply(msg.msgOverLimit(a.capLabel), html);
    flow.awaitingAmount = false;
    flow.ethAmount = ethers.formatUnits(w, dec); // sudah dinormalisasi (desimal dipotong)
    await renderRangeStep(ctx, flow, false);
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

/**
 * Daftar command menu Telegram (tombol "/" / Menu).
 * ISINYA HARUS = semua bot.command() yang terdaftar — diperiksa saat boot oleh
 * assertMenuComplete() di bawah, supaya perintah baru tak pernah lagi hidup
 * diam-diam tanpa muncul di menu.
 */
const BOT_COMMANDS = [
  // Mulai & bantuan
  { command: 'start', description: 'Kartu sambutan & status bot' },
  { command: 'help', description: 'Menu, mode bot & daftar perintah' },
  // Pantau
  { command: 'status', description: 'Koneksi jaringan & saldo dompet' },
  { command: 'positions', description: 'Posisi LP yang aktif (live)' },
  { command: 'history', description: 'Riwayat trade tertutup (jurnal)' },
  { command: 'pnl', description: 'Rekap PnL seumur hidup' },
  // Riset
  { command: 'pools', description: 'Top pool by APR (ETH/USDG) — sinkron Uniswap' },
  { command: 'explore', description: 'Alias lama /pools' },
  { command: 'token_info', description: 'Audit keamanan token: /token_info <CA>' },
  // LP
  { command: 'add_lp', description: 'Buka LP single-side (pilih pair atau /add_lp <CA>)' },
  { command: 'add', description: 'Alias lama /add_lp' },
  { command: 'claim_fees', description: 'Panen fee tanpa menutup posisi' },
  { command: 'remove_lp', description: 'Tarik likuiditas 25/50/75/100%' },
  { command: 'stop', description: 'Tutup posisi LP' },
  { command: 'closeall', description: 'Darurat: tutup semua posisi (konfirmasi per posisi)' },
  // Swap
  { command: 'buy', description: 'Beli token (rute terbaik)' },
  { command: 'sell', description: 'Jual token (rute terbaik)' },
  // Dompet & setelan
  { command: 'connect', description: 'Hubungkan dompet Robinhood' },
  { command: 'settings', description: 'Dompet & preferensi transaksi' },
  { command: 'disconnect', description: 'Putuskan dompet & hapus kunci' },
  { command: 'alerts', description: 'Setelan notifikasi (range, anjlok, rugi)' },
] as const;

/** Menu vs command terdaftar. Selisihnya dilaporkan ke log, tidak mematikan bot. */
function assertMenuComplete(): void {
  const inMenu = new Set(BOT_COMMANDS.map((c) => c.command));
  const missing = [...registeredCommands].filter((c) => !inMenu.has(c as never));
  const stale = [...inMenu].filter((c) => !registeredCommands.has(c));
  if (missing.length) console.error('[menu] command hidup tapi TIDAK ada di menu:', missing.join(', '));
  if (stale.length) console.error('[menu] ada di menu tapi TIDAK terdaftar:', stale.join(', '));
  if (!missing.length && !stale.length) console.log(`[menu] ${inMenu.size} command — menu & handler cocok`);
}

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
  assertMenuComplete();
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
  // onLaunch dipanggil saat polling MULAI. Promise-nya baru selesai saat bot
  // BERHENTI (Telegraf v4) — dulu "online" & pemasangan menu tersangkut di sana,
  // jadi menu "/" baru terkirim saat proses mati dan selalu tertinggal satu versi.
  bot
    .launch(() => {
      console.log(
        'PHILIPS online | wallet:',
        walletStore.address() ?? '(belum terhubung)',
        '| mode:',
        msg.modeLabel(config.safety.dryRun),
      );
      registerBotCommands().catch((e) => console.error('[menu]', (e as Error).message));
    })
    .then(
      () => console.log('PHILIPS berhenti'),
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
