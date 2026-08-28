import { Markup, Input } from 'telegraf';
import {
  bot,
  html,
  capLabelFor,
  maxEth,
  maxStable,
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
import { config, EXIT_CONFIG } from './config.js';
import { provider, ERC20_ABI } from './chain.js';
import { retryOnce } from './retry.js';
import * as walletStore from './walletStore.js';
import {
  planAddSingleSided,
  planLadderSingleSided,
  ladderWeights,
  executeAddBatch,
  executeRemoveBatch,
  planAddTokenSide,
  ADD_GAS_UNITS,
  gasBuffer,
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
import { listPositionsV4, invalidateV4ListCache, v4Liquidity, v4PositionCount, v4Supported, closePositionV4, checkV4Status, v4NextTokenId, v4OwnedIdsInRange, v4ListDegraded, openPositionV4, planLadderV4, openLadderV4, closeLadderV4, V4_UNPROTECTED_NOTE, v4BaseSymbol, v4BaseDecimals, currentTickV4, getPoolKeyV4, resolvePoolKeyV4, poolHealthV4, valuePositionV4, type V4Position, type V4LadderLeg } from './uniswapV4.js';
import * as v4store from './v4store.js';
import * as pctPresets from './pctPresets.js';
import { screenToken, formatScreen, bustScreenCache, getEthUsd, getTokenEthPrice } from './screening.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust, NATIVE } from './relay.js';
import { startMonitor } from './monitor.js';
import * as store from './store.js';
import * as journal from './journal.js';
import * as msg from './messages.js';
import * as explore from './explore.js';
import * as krystal from './krystal.js';
import { awaitingSecret, handleSecret } from './commands/wallet.js';
import { cmdHistory, cmdPnl } from './commands/journalCmds.js';
import './commands/feesAndRemove.js';
import './commands/alerts.js';
import './commands/unwrap.js';
import './commands/send.js';
import { handlePctReply } from './commands/wallet.js';
import { handleBridgeAmount } from './commands/bridge.js';
import { handleSendAddress, handleSendAmount } from './commands/send.js';
import {
  CHAINS,
  getChain,
  rebuildChains,
  detectChains,
  baseOf,
  baseDecimalsOf,
  basesFor,
  detectBase,
  isStableBase,
  baseSymbolOf,
  type ChainCtx,
  type BaseKind,
  type BaseAsset,
  venueCtx,
  ctxOf,
  pairLabel,
} from './chains.js';
import { swapExactInBest, previewSwapOut } from './swapRoute.js';

// Posisi sudah di-burn/tak ada di chain (NFT hilang).

/**
 * PHILIPS LP Bot — otak utama.
 * Command aktif: /start /help /portfolio /positions /history /pnl /explore /add /stop
 * /buy /sell /unwrap
 * Screening token berjalan otomatis di dalam /add.
 */





/**
 * Ketikan nominal → wei, atau null bila tak masuk akal. `Number(raw) > 0` saja
 * meloloskan '1e-9' / desimal berlebih yang lalu membuat parseUnits melempar DI LUAR
 * try (kartu ERROR mentah). Desimal berlebih DIPOTONG (tak pernah membesarkan nominal).
 */
// Berapa kali maksimum ulangi swap saat cash-out sampai token benar-benar habis.
const MAX_CLOSE_SWEEP = 4;
/** Max token hold ditampilkan di /portfolio (setelah filter saldo > 0). */
const SELL_HOLDINGS_CAP = 12; // maks token di daftar /sell
/** Max kandidat CA dicek balance (jurnal + posisi). */
const HOLDINGS_CAND_MAX = 20;
/** Concurrency saat membangun kartu posisi. */

/** Jalankan fn pada items dengan batas concurrency (jaga rate RPC). */


/**
 * Swap SELURUH saldo token (bukan delta) ke ETH, ulang sampai saldo = 0.
 * Mengatasi: token sisa dari close sebelumnya, RPC telat update, Relay no-op,
 * dan swap parsial. Setiap iterasi menukar saldo penuh yang tersisa.
 *
 * DISENGAJA memakai saldo penuh, bukan hasil posisi ini saja (dikonfirmasi pemilik
 * 1 Agu 2026): "tutup posisi" berarti berakhir di ETH, bukan menyisakan bag. Efek
 * sampingnya — bag spot token yang sama ikut terjual — didokumentasikan di README.
 */
async function sweepTokenToBase(
  otherAddr: string,
  otherC: ethers.Contract,
  base: BaseAsset,
  cc: ChainCtx,
  notes: string[],
  keepFloor: bigint = 0n, // saldo token yang SUDAH ada sebelum close (bag spot) — JANGAN dijual
): Promise<{ baseOut: bigint; txHashes: string[]; leftover: boolean; leftoverWei: bigint }> {
  let baseOut = 0n;
  const txHashes: string[] = [];
  let prev = -1n;
  for (let attempt = 1; attempt <= MAX_CLOSE_SWEEP; attempt++) {
    const total: bigint = await otherC.balanceOf(cc.wallet.address);
    // Jual HANYA yang dihasilkan posisi ini (di atas bag yang sudah dipegang).
    const bal = total > keepFloor ? total - keepFloor : 0n;
    if (bal === 0n) break;
    if (bal === prev) {
      notes.push(`${bal} token units left and not decreasing — swap stopped (needs a manual sweep).`);
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
      notes.push(`Swap attempt ${attempt} failed: ${(e as Error).message.slice(0, 140)}`);
      // ORPHAN GUARD: error swap kadang PALSU — tx-nya (mis. nonce bentrok) diam-diam
      // TERKIRIM & mendarat beberapa blok kemudian (kasus LIGER #774283: token kejual
      // tapi bot ngira gagal → PnL salah). Jangan langsung nyerah: tunggu & cek apakah
      // token benar-benar KELUAR dari wallet. Kalau turun → swap sebenarnya jalan,
      // lanjut loop supaya sisa & hasil kebaca; kalau tidak → memang gagal, berhenti.
      let landed = false;
      for (let probe = 0; probe < 4; probe++) {
        await sleep(4000);
        const nowBal: bigint = await otherC.balanceOf(cc.wallet.address);
        const nowSell = nowBal > keepFloor ? nowBal - keepFloor : 0n;
        if (nowSell < bal) {
          landed = true;
          notes.push(`↳ but the token left the wallet — the swap actually landed (orphaned tx). Recounting.`);
          break;
        }
      }
      if (landed) continue; // token bergerak → ukur ulang di iterasi berikutnya
      break;
    }
    await sleep(1500); // beri waktu saldo settle di RPC sebelum verifikasi ulang
  }
  const finalTotal: bigint = await otherC.balanceOf(cc.wallet.address);
  const leftoverWei = finalTotal > keepFloor ? finalTotal - keepFloor : 0n;
  return { baseOut, txHashes, leftover: leftoverWei > 0n, leftoverWei };
}

/**
 * Pre-flight gas untuk ladder N leg: pastikan saldo native cukup buat gas
 * (+ deposit bila base native/wrappable). Gagal → pesan ramah "top up", bukan
 * revert 'insufficient funds' mentah. ~350k gas/leg + buffer 20%.
 */
async function ensureGasForLegs(cc: ChainCtx, legs: number, nativeValueWei: bigint): Promise<void> {
  const [feeData, nativeBal] = await Promise.all([cc.provider.getFeeData(), cc.provider.getBalance(cc.wallet.address)]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasWei = (BigInt(Math.max(1, legs)) * 350_000n * gasPrice * 12n) / 10n;
  const need = gasWei + nativeValueWei;
  if (nativeBal < need) {
    throw new Error(
      `Not enough ${cc.nativeSymbol} on ${cc.label} for gas: need ~${ethers.formatEther(need)} ` +
        `(${legs} legs${nativeValueWei > 0n ? ' + deposit' : ''}), have ${ethers.formatEther(nativeBal)}. ` +
        `Top up ${cc.nativeSymbol} for gas.`,
    );
  }
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
  shape?: 'spot' | 'bidask'; // bentuk ladder (sisi base); default spot = 1 leg (perilaku lama)
  legs?: number; // jumlah leg ladder (bidask); spot = 1
  ladderPlans?: AddPlan[]; // rencana per-leg v3 (dihitung di step plan, dipakai saat confirm)
  v4LadderLegs?: V4LadderLeg[]; // rencana per-leg v4 (batch modifyLiquidities)
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
  { pct: 10, label: 'Conservative' },
  { pct: 30, label: 'Moderate' },
  { pct: 50, label: 'Aggressive' },
  { pct: 70, label: 'Very Aggressive' },
  { pct: 90, label: 'Extreme' },
];

/** Pilihan jumlah leg ladder Bid-Ask. 8-10 = sweet spot free-tier; 69 butuh RPC
 *  berbayar (free-tier + VM 2-core → /positions & monitor berat). Auto-cap ke spacing. */


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

// --- answerCbQuery tak boleh menjatuhkan handler ---
// Callback query kedaluwarsa setelah ~15 detik. Kalau alur di belakang tombol
// lebih lama dari itu (cash-out, swap), balasan "Memuat…" gagal 400 dan
// melempar SEBELUM kerja intinya jalan. Sekadar toast — telan errornya.
bot.use((ctx: any, next: any) => {
  if (typeof ctx.answerCbQuery === 'function') {
    const orig = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = (...a: unknown[]) => orig(...a).catch(() => undefined);
  }
  return next();
});

// --- Penjaga: perintah yang menggerakkan dana butuh dompet terhubung ---
// Perintah baca (/status /positions /pools /help) sengaja dibiarkan
// lewat: memantau tanpa dompet itu sah, dan kartunya sendiri sudah menandai
// "belum terhubung".
const NEEDS_WALLET = /^\/(add_lp|stop|claim_fees|buy|sell|unwrap|bridge|send)\b/;
// Tombol yang BENAR-BENAR mengirim tx. Guard command saja tak cukup: alur bisa
// dimulai saat dompet terhubung lalu diputus, dan tombolnya masih bisa ditekan —
// yang muncul lalu bukan "hubungkan dompet" tapi error mentah dari VoidSigner.
const NEEDS_WALLET_CB = /^(addok|tswapok|close:|closev4go:|claim:|rmok:|unwrap:go|br:go|sndgo)/;
bot.use((ctx: any, next: any) => {
  const t = ctx.message?.text ?? '';
  const cb = ctx.callbackQuery?.data ?? '';
  if ((NEEDS_WALLET.test(t) || NEEDS_WALLET_CB.test(cb)) && !walletStore.isConnected()) {
    if (cb) ctx.answerCbQuery('Wallet not connected.').catch(() => {});
    return ctx.reply(msg.msgNeedWallet(), html);
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
// Tombol Add Liquidity dibuang atas permintaan: membuka LP dimulai dari menempel
// CA, jadi tombol itu cuma membuka kartu "cara memakai" — satu tap yang tak
// mengerjakan apa pun. Connect Wallet tetap ada karena ia memang bertindak.
const startKeyboard = () =>
  Markup.inlineKeyboard([
    ...(walletStore.isConnected() ? [] : [[Markup.button.callback('🔗 Connect Wallet', 'connect')]]),
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
// Tutup kartu alert. Hapus pesannya; bila Telegram menolak (pesan >48 jam),
// jatuh ke edit teks supaya tombolnya tetap hilang.
bot.action('dismiss', async (ctx) => {
  await ctx.answerCbQuery('Dismissed');
  await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup(undefined).catch(() => {}));
});

bot.action('howitworks', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgHowItWorks(), html);
});
bot.action('howto:add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgAddHowTo(), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'dismiss')],
    ]),
  });
});

// Keyboard inline aksi cepat pada kartu /help (di samping reply-keyboard persisten).
// Grid 2 kolom (thumb-friendly, perbaikan.md §1.3); aksi uang di baris sendiri.
const helpKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💰 Portfolio', 'portfolio'), Markup.button.callback('📊 Active LPs', 'positions')],
    [Markup.button.callback('🧾 PnL & Journal', 'pnl')],
    [Markup.button.callback('⛔ Emergency Close All', 'closeall_confirm')],
  ]);

bot.command('help', (ctx) =>
  ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, ...helpKeyboard() }),
);

// Tombol inline /help → jalankan command terkait (ctx.reply bekerja dari callback).
bot.action('portfolio', async (ctx) => {
  await ctx.answerCbQuery();
  return renderStatus(ctx, false);
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
          // Stablecoin base dibaca DI CHAIN-NYA SENDIRI: USDG milik Robinhood, USDT
          // milik BSC. Satu baris "USDG" berdiri sendiri dulu menyamarkan chain-nya.
          const stables: Array<{ symbol: string; amount: string; usd: number | null }> = [];
          for (const b of basesFor(c)) {
            if (!isStableBase(b.kind)) continue;
            try {
              const erc = new ethers.Contract(b.address, ERC20_ABI, c.provider);
              const raw: bigint = await erc.balanceOf(c.wallet.address);
              const amt = Number(ethers.formatUnits(raw, b.decimals));
              if (amt > 0) stables.push({ symbol: b.symbol, amount: amt.toFixed(2), usd: amt }); // ≈ $1
            } catch {
              /* stablecoin tak terbaca → lewati, jangan gagalkan kartu */
            }
          }
          try {
            const b = await c.provider.getBalance(c.wallet.address);
            const amt = Number(ethers.formatEther(b));
            // Harga native diambil dari wrapped-native CHAIN ITU SENDIRI: BNB dihargai
            // dengan WBNB, bukan dengan harga ETH. Tak terbaca → null ("$?"), tak dijumlah.
            const px = await getEthUsd(c.wethAddress, c).catch(() => null);
            const usd = px !== null ? amt * px : amt === 0 ? 0 : null;
            return { label: c.label, amount: amt.toFixed(4), symbol: c.nativeSymbol, usd, stables };
          } catch {
            return { label: c.label, amount: '?', symbol: c.nativeSymbol, usd: null, stables };
          }
        }),
      ),
    ]);
    // Nilai posisi LP aktif (v3 + v4). Gagal baca satu posisi tak boleh menggagalkan kartu;
    // jumlah yang gagal dilaporkan supaya total tak terbaca sebagai fakta.
    let lpUsd: number | null = null;
    let lpFailed = 0;
    try {
      const ccLp = getChain();
      const vals = await mapLimit(store.active(), POS_CARD_CONCURRENCY, async (rec) => {
        try {
          const rcc = ctxOf(rec);
          const d = await getPositionDetail(rec.tokenId, rcc);
          const v = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, d.baseDecimals));
          // Harga native dari CHAIN POSISI ITU: BNB dihargai WBNB, HYPE dihargai
          // WHYPE. Dulu semua dikali harga ETH chain utama → LP HyperEVM 30x lipat.
          return baseToUsd(d.baseKind, v, rcc);
        } catch {
          return undefined;
        }
      });
      const v4 = v4Supported(ccLp) ? await listPositionsV4(ccLp).catch(() => []) : [];
      const v4Vals = v4.map((p) => {
        if (p.valueBaseWei === null || !p.base) return undefined;
        const v = Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), v4BaseDecimals(ccLp, p.base)));
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
    const stablesUsd = chains.reduce(
      (s, c) => s + (c.stables ?? []).reduce((t, x) => t + (x.usd ?? 0), 0),
      0,
    );
    const totalUsd = ethUsd === null ? null : chains.reduce((s, c) => s + (c.usd ?? 0), 0) + stablesUsd;

    const text = msg.msgStatus({
      dryRun: config.safety.dryRun,
      positions: store.active().length,
      chains,
      totalUsd,
      lpUsd,
      lpFailed,
    });
    const extra = {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Data', 'refresh:status')],
        [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
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

bot.command('portfolio', (ctx) => renderStatus(ctx, false));
// Nama lama tetap hidup: yang sudah terbiasa mengetik /status tak menabrak dinding.
// Tak dipasang di menu — satu nama saja yang ditawarkan.
bot.command('status', (ctx) => renderStatus(ctx, false));

bot.action('refresh:status', async (ctx) => {
  await ctx.answerCbQuery('Refreshing…');
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
    return `value ${valLabel} · entry unknown`;
  }
  const initF = rec ? Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec)) : 0;
  const curF = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
  // PnL USD ala LP Agent: modal awal dinilai USD pada harga base SAAT ENTRY,
  // nilai sekarang pada harga base SEKARANG. Gerak harga base (ETH) ikut terhitung
  // — beda dari view ETH lama yang cuma mengalikan selisih WETH dg harga now.
  if (rec?.entryEthUsd && rec.entryEthUsd > 0) {
    const nowUsdPer = isStableBase(d.baseKind) ? 1 : await getEthUsd(cc.wethAddress, cc);
    if (nowUsdPer !== null) {
      const entryUsd = initF * rec.entryEthUsd;
      const curUsd = curF * nowUsdPer;
      const pnlUsd = curUsd - entryUsd;
      const pct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
      return `${msg.usdSigned(pnlUsd)} (${msg.fmtPct(pct)})`;
    }
  }
  // Fallback (posisi lama tanpa entryEthUsd): view ETH-denominated.
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
    d = await getPositionDetail(rec.tokenId, ctxOf(rec));
  } catch (e) {
    if (isGoneErr(e)) {
      finalizeClose(rec.tokenId, { reason: 'gone' });
      return {
        text: msg.msgPositionGone(rec.tokenId, rec.symbol, baseSymbolOf(rec.baseKind, ctxOf(rec))),
        extra: html,
      };
    }
    return { text: msg.msgPositionReadFail(rec.tokenId, (e as Error).message), extra: html };
  }
  const cc = ctxOf(rec);
  // Warm ethUsd cache sekali per chain (getEthUsd sudah TTL 60s).
  if (d.baseKind === 'weth') await getEthUsd(cc.wethAddress, cc);
  const pnlText = await positionPnlText(rec, d, cc);
  // Jarak batas range dari HARGA SEKARANG — "berapa jauh lagi ke tiap ujung dari
  // sini", jadi ikut bergerak saat token turun. Dulu dipatok ke entryPrice supaya
  // angkanya diam; akibatnya kartu memberi tahu keadaan saat POSISI DIBUKA, bukan
  // keadaan sekarang: token turun 26% dan barisnya tetap menulis -0.7% ⇄ -90.2%
  // padahal dari harga kini batasnya +34.7% ⇄ -86.8%. Batas absolutnya tetap diam
  // dan ditunjukkan baris mcap di bawah (dipatok ke entry). Sama seperti kartu v4.
  const range = (() => {
    const now = Number(d.currentPrice);
    if (now > 0) {
      const pf = (p: string) => (Number(p) / now - 1) * 100;
      const [a, b] = [pf(d.priceUpper), pf(d.priceLower)].sort((x, y) => y - x);
      return `${msg.fmtPct(a)} ⇄ ${msg.fmtPct(b)}`;
    }
    // Harga live tak terbaca → pakai tick (sumber yang sama, jalur berbeda).
    const sgn = d.baseIsToken0 ? -1 : 1;
    const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - d.currentTick)) - 1) * 100;
    const pcts = [pctOf(d.tickUpper), pctOf(d.tickLower)].sort((a, b) => b - a);
    return `${msg.fmtPct(pcts[0])} ⇄ ${msg.fmtPct(pcts[1])}`;
  })();
  // Rentang yang sama, dibaca sebagai kapitalisasi pasar. MC berskala LINIER
  // terhadap harga (suplai tetap), jadi MC di batas = MC sekarang × (harga batas
  // ÷ harga sekarang). Rasio itu tanpa satuan, jadi harga boleh tetap dalam base.
  const mcRange = await (async () => {
    const [hi, lo] = Number(d.priceUpper) >= Number(d.priceLower)
      ? [d.priceUpper, d.priceLower]
      : [d.priceLower, d.priceUpper];
    // Batas mcap DIPATOK ke ENTRY: mcEntry × (hargaBatas ÷ hargaEntry). Keduanya
    // nilai TERSIMPAN, jadi angka batas benar-benar diam. Dulu dipakai mcNow ÷ hargaNow
    // yang mencampur mcap DexScreener & harga on-chain (dua sumber, tak sinkron) →
    // batas ikut bergoyang tiap refresh walau tick posisi tetap.
    if (rec.entryMcap && rec.entryPrice && Number(rec.entryPrice) > 0) {
      const e = Number(rec.entryPrice);
      const at = (p: string) => explore.usdShort((rec.entryMcap! * Number(p)) / e);
      // "now" DITURUNKAN dari harga pool yang baru saja dibaca, bukan ditarik dari
      // DexScreener. Mcap berskala linier terhadap harga, jadi mcEntry × (hargaKini ÷
      // hargaEntry) memberi angka yang bergerak SEKETIKA tiap refresh — sementara
      // DexScreener di-cache 2 menit dan datang dari sumber lain, sehingga "now"
      // bisa tak sebaris dengan batas rentang, status IN RANGE, dan PnL di kartu
      // yang sama. Ini pula yang sudah dipakai kartu v4. Harga pool tak terbaca →
      // baru jatuh ke DexScreener.
      const nowPrice = Number(d.currentPrice);
      const derived = nowPrice > 0 ? (rec.entryMcap * nowPrice) / e : null;
      const shown = derived ?? (await explore.tokenMarketCap(cc, d.otherAddress).catch(() => null));
      const nowStr = shown !== null ? ` · now ${explore.usdShort(shown)}` : '';
      return `${at(hi)} ⇄ ${at(lo)}${nowStr}`;
    }
    const mcNow = await explore.tokenMarketCap(cc, d.otherAddress).catch(() => null);
    // Posisi lama tanpa entryMcap: jatuh ke perhitungan live (bergoyang, tapi ada acuan).
    const now = Number(d.currentPrice);
    if (mcNow === null || !(now > 0)) return undefined;
    const at = (p: string) => explore.usdShort((mcNow * Number(p)) / now);
    return `${at(hi)} ⇄ ${at(lo)} · now ${explore.usdShort(mcNow)}`;
  })();
  const invest = rec.imported
    ? '—'
    : (rec.nominalEth ?? msg.cleanUnits(BigInt(rec.initialWethWei), baseDecimalsOf(rec.chain, rec.baseKind)));
  // Ladder: total modal SEGRUP (jumlah semua leg) supaya kartu leg tak terlihat
  // seperti posisi tunggal kecil.
  const ladder = rec.groupId
    ? await (async () => {
        const legs = store.group(rec.groupId!);
        if (legs.length < 2) return undefined;
        const dec = baseDecimalsOf(rec.chain, rec.baseKind);
        const groupWei = legs.reduce((s, l) => s + BigInt(l.initialWethWei || '0'), 0n);
        // Ringkasan SELURUH ladder. Tanpa ini kartu memasang modal SEGRUP tepat di
        // atas PnL yang cuma milik SATU leg: "+4.5%" terbaca terhadap 175 USDT
        // (≈$7.9) padahal untungnya $0.22 — dua baris bersebelahan dengan penyebut
        // berbeda. Sekarang kedua cakupan disebut terang-terangan.
        const seen = await mapLimit(legs, POS_CARD_CONCURRENCY, async (l) => {
          try {
            const dd = await getPositionDetail(l.tokenId, cc);
            return {
              inWei: BigInt(l.initialWethWei || '0'),
              valWei: dd.valueBaseWei + dd.feesBaseWei,
              feeWei: dd.feesBaseWei,
              lo: Math.min(Number(dd.priceLower), Number(dd.priceUpper)),
              hi: Math.max(Number(dd.priceLower), Number(dd.priceUpper)),
              inRange: dd.inRange,
              converted: !dd.inRange && (l.side === 'token' ? dd.side === 'above' : dd.side === 'below'),
            };
          } catch {
            return null;
          }
        });
        const ok = seen.filter((x): x is NonNullable<typeof x> => x !== null);
        let ladderPnl: string | undefined;
        if (ok.length === legs.length) {
          const inF = Number(ethers.formatUnits(ok.reduce((a, x) => a + x.inWei, 0n), dec));
          const valF = Number(ethers.formatUnits(ok.reduce((a, x) => a + x.valWei, 0n), dec));
          const usd = await baseToUsd(rec.baseKind ?? d.baseKind, valF - inF, cc);
          const pct = inF > 0 ? ((valF - inF) / inF) * 100 : 0;
          ladderPnl = `${usd !== null ? msg.usdSigned(usd) : `${valF - inF >= 0 ? '+' : ''}${(valF - inF).toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`} (${msg.fmtPct(pct)})`;
        }
        // Nilai & fee SELURUH ladder, plus rentang mcap dari ujung terluar semua leg
        // — supaya kartu leg memakai bentuk yang sama dengan kartu v4.
        const complete = ok.length === legs.length;
        const fmtBase = (n: number) => `${n.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`;
        const ladderValue = complete
          ? fmtBase(Number(ethers.formatUnits(ok.reduce((a, x) => a + x.valWei, 0n), dec)))
          : undefined;
        const ladderFees = complete
          ? fmtBase(Number(ethers.formatUnits(ok.reduce((a, x) => a + x.feeWei, 0n), dec)))
          : undefined;
        let ladderMcRange: string | undefined;
        if (complete && rec.entryMcap && rec.entryPrice && Number(rec.entryPrice) > 0) {
          const e = Number(rec.entryPrice);
          const at = (price: number) => explore.usdShort((rec.entryMcap! * price) / e);
          const nowPrice = Number(d.currentPrice);
          const nowStr = nowPrice > 0 ? ` · now ${at(nowPrice)}` : '';
          ladderMcRange = `${at(Math.max(...ok.map((x) => x.hi)))} ⇄ ${at(Math.min(...ok.map((x) => x.lo)))}${nowStr}`;
        }
        const mineWei = BigInt(rec.initialWethWei || '0');
        return {
          legIndex: rec.legIndex ?? 0,
          legCount: rec.legCount ?? legs.length,
          shape: rec.shape ?? 'bidask',
          groupInvest: msg.cleanUnits(groupWei, dec),
          ladderValue,
          ladderFees,
          ladderMcRange,
          ladderPnl,
          sharePct: groupWei > 0n ? Number((mineWei * 10000n) / groupWei) / 100 : undefined,
          legValue: fmtBase(Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec))),
          legFees: d.feesBaseWei > 0n ? fmtBase(Number(ethers.formatUnits(d.feesBaseWei, dec))) : undefined,
          filled: ok.filter((x) => x.converted).length,
          active: ok.filter((x) => x.inRange).length,
          waiting: ok.filter((x) => !x.inRange && !x.converted).length,
          unread: legs.length - ok.length,
        };
      })()
    : undefined;
  const text = msg.msgPositionCard({
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    fee: rec.fee,
    invest,
    pnlText,
    range,
    mcRange,
    inRange: d.inRange,
    age: msg.fmtAge(Date.now() - rec.openedAt),
    dryRun: config.safety.dryRun,
    chain: cc.label,
    baseSymbol: d.baseSymbol,
    side: rec.side,
    converted: !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below'),
    feeIsTickSpacing: cc.slipstream,
    ladder,
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
  const cc = ctxOf(rec);
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
        Markup.button.callback('⬅️ Back', `back:card:${rec.tokenId}`),
        Markup.button.callback('🔄 Refresh', `detail:${rec.tokenId}`),
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
  opts: { resultEthWei?: bigint; reason: journal.JournalEntry['reason']; keep?: boolean; leftoverWei?: bigint },
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
      ...(opts.leftoverWei !== undefined ? { leftoverWei: opts.leftoverWei.toString() } : {}),
    });
  } else {
    store.remove(tokenId);
  }
}

/**
 * Id posisi v4 milik kita yang lahir sejak `from` — dipakai memungut NFT yang
 * terlanjur ter-mint saat alur open gagal di tengah jalan. Mengembalikan daftar
 * id terurut (urutan mint = urutan leg).
 */
async function adoptStrayV4(cc: ReturnType<typeof getChain>, from: bigint): Promise<string[]> {
  const to = await v4NextTokenId(cc).catch(() => null);
  if (to === null) return [];
  return await v4OwnedIdsInRange(cc, from, to).catch(() => []);
}

/** Kartu detail satu posisi v4 (nilai + range% + PnL bila dikelola bot) + tombol. */
/**
 * BaseKind untuk posisi v4 di chain ini. `'USDG'` di modul v4 berarti "base
 * stablecoin chain ini", bukan token USDG secara harfiah — di BSC itu USDT.
 * Memetakannya mati ke 'usdg' membuat desimal & simbolnya salah begitu v4
 * dinyalakan di chain lain.
 */
/** Alamat aset base v4 di chain ini — dipakai meminta quote sisi token. */
function baseAddrOf(cc: ChainCtx, base: 'ETH' | 'USDG' | null): string | null {
  if (base === 'ETH') return cc.wethAddress;
  if (base !== 'USDG') return null;
  return cc.bases.find((b) => isStableBase(b.kind))?.address ?? null;
}

function v4Kind(cc: ChainCtx, base: 'ETH' | 'USDG' | null): store.PosRecord['baseKind'] {
  if (base !== 'USDG') return 'weth';
  return (cc.bases.find((b) => isStableBase(b.kind))?.kind ?? 'usdg') as store.PosRecord['baseKind'];
}

async function buildV4Card(p: V4Position, ethUsdV4: number | null, cc = getChain()): Promise<{ text: string; extra: Record<string, unknown> }> {
  const tracked0 = v4store.getV4(p.tokenId);
  const feeLabel = p.dynamicFee ? 'dynamic' : `${(p.fee / 10000).toFixed(p.fee % 100 ? 2 : 0)}%`;
  const dec = v4BaseDecimals(cc, p.base);
  let valueLabel = '—';
  let feesLabel: string | undefined;
  // Value = prinsipal + fee. Tanpa rincian, kartu bisa tampak "cuma -3.6%"
  // padahal prinsipal -19% dan yang menambal adalah fee — sengaja dipisah.
  if (p.feesBaseWei !== null && p.feesBaseWei > 0n && p.valueBaseWei !== null) {
    const fd = v4BaseDecimals(cc, p.base);
    const f = Number(ethers.formatUnits(p.feesBaseWei, fd));
    const ent = tracked0 ? Number(ethers.formatUnits(BigInt(tracked0.entryBaseWei), fd)) : 0;
    const pct = ent > 0 ? ` (+${((f / ent) * 100).toFixed(1)}% of capital)` : '';
    feesLabel = `${f.toFixed(fd >= 18 ? 5 : 2)} ${p.base ?? ''}${pct}`;
  }
  if (p.valueBaseWei !== null && p.base === 'ETH') {
    const eth = Number(ethers.formatEther(p.valueBaseWei + (p.feesBaseWei ?? 0n)));
    valueLabel = ethUsdV4 !== null ? `${msg.usdPlain(eth * ethUsdV4)}  (${eth.toFixed(5)} ETH)` : `${eth.toFixed(5)} ETH`;
  } else if (p.valueBaseWei !== null && p.base === 'USDG') {
    valueLabel = `${Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), 6)).toFixed(2)} USDG`;
  }
  const tracked = tracked0;
  // Range % DIPATOK ke tick ENTRY (bila tersimpan) → angkanya diam, tak goyang tiap
  // refresh. Fallback ke live (relatif harga sekarang) untuk posisi tanpa entryTick.
  // Batas rentang DAN harga sekarang dihitung di SATU ruang: tick pool, dipatok
  // ke entryTick. Dulu "now" diambil dari DexScreener sementara batasnya dari
  // tick → kartu bisa bilang IN RANGE padahal "now" tampak di luar batas.
  const anchored = ((): { pcts: [number, number]; nowPct: number | null } | null => {
    if (tracked?.entryTick === undefined) return null;
    const sgn = tracked.baseIsCurrency0 ? -1 : 1;
    const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - tracked.entryTick!)) - 1) * 100;
    return {
      pcts: [pctOf(p.tickUpper), pctOf(p.tickLower)].sort((a, b) => b - a) as [number, number],
      nowPct: p.currentTick !== null ? pctOf(p.currentTick) : null,
    };
  })();
  const anchoredPcts = anchored?.pcts ?? null;
  // Persen rentang diukur dari harga SEKARANG, jadi ikut bergerak saat token
  // turun: "berapa jauh lagi ke tiap ujung dari sini". Batas absolutnya tetap
  // diam dan ditunjukkan baris mcap di bawahnya (dipatok ke entry). Dulu persen
  // ini juga dipatok ke entry → angkanya beku dan terbaca seolah range mati.
  const rangeLabel =
    p.rangePctHigh !== null && p.rangePctLow !== null
      ? `${msg.fmtPct(p.rangePctHigh)} / ${msg.fmtPct(p.rangePctLow)}`
      : anchoredPcts
        ? `${msg.fmtPct(anchoredPcts[0])} / ${msg.fmtPct(anchoredPcts[1])}`
        : '—';
  let pnlText: string | undefined;
  if (tracked && p.valueBaseWei !== null && p.base) {
    const curF = Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), dec));
    const entF = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
    // PnL USD ala LP Agent bila entryEthUsd tersimpan (gerak harga base ikut kehitung).
    const nowUsdPer = p.base === 'USDG' ? 1 : ethUsdV4;
    if (tracked.entryEthUsd && tracked.entryEthUsd > 0 && nowUsdPer !== null) {
      const entryUsd = entF * tracked.entryEthUsd;
      const pnlUsd = curF * nowUsdPer - entryUsd;
      const pct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
      pnlText = `${msg.usdSigned(pnlUsd)} (${msg.fmtPct(pct)})`;
    } else {
      const pnlF = curF - entF;
      const pct = entF > 0 ? (pnlF / entF) * 100 : 0;
      pnlText =
        p.base === 'ETH' && ethUsdV4 !== null
          ? `${msg.usdSigned(pnlF * ethUsdV4)} (${msg.fmtPct(pct)})`
          : `${pnlF >= 0 ? '+' : ''}${pnlF.toFixed(dec >= 18 ? 5 : 2)} ${p.base} (${msg.fmtPct(pct)})`;
    }
  }
  // Guard pool sekarat: bandingkan harga token menurut slot0 pool INI dengan
  // harga PASAR (DexScreener pool terdalam). Selisih besar = pool tipis, harga &
  // range di kartu tak bisa dipercaya (persis kasus PEPE di pool liq $25).
  let priceWarn: string | null = null;
  const baseSymbol = p.base ? v4BaseSymbol(cc, p.base) : undefined;
  const tokenSymbol = baseSymbol ? [p.sym0, p.sym1].find((s) => s !== baseSymbol) : undefined;
  // Market cap: kapitalisasi sekarang + di batas rentang (MC ∝ harga, jadi
  // MC@batas = MC_now × (1 + pct/100)). Samakan dengan sub-baris mcap kartu V3.
  let mcRange: string | undefined;
  let mcPool: number | null = null;
  let mcMarket: number | null = null;
  {
    const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
    const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
    const tokenAddr = [p.poolKey.currency0, p.poolKey.currency1].find((a) => !isEth(a) && !isUsdg(a));
    const mcNow = tokenAddr ? await explore.tokenMarketCap(cc, tokenAddr).catch(() => null) : null;
    mcMarket = mcNow;
    // Batas mcap DIPATOK ke entryMcap + range% dari entry → diam. mcNow ditampilkan
    // sebagai "now" (referensi hidup). Fallback ke live bila entry tak tersimpan.
    if (anchoredPcts && tracked?.entryMcap) {
      const at = (pct: number) => explore.usdShort(tracked.entryMcap! * (1 + pct / 100));
      // "now" dari tick pool → sebaris dengan batas rentang, status IN RANGE, dan PnL.
      mcPool = anchored?.nowPct != null ? tracked.entryMcap * (1 + anchored.nowPct / 100) : null;
      const shown = mcPool ?? mcNow;
      const nowStr = shown !== null ? ` · now ${explore.usdShort(shown)}` : '';
      mcRange = `${at(anchoredPcts[0])} ⇄ ${at(anchoredPcts[1])}${nowStr}`;
    } else if (mcNow !== null && p.rangePctHigh !== null && p.rangePctLow !== null) {
      const at = (pct: number) => explore.usdShort(mcNow * (1 + pct / 100));
      mcRange = `${at(p.rangePctHigh)} ⇄ ${at(p.rangePctLow)} · now ${explore.usdShort(mcNow)}`;
    }
  }
  // Guard pool sekarat: bandingkan mcap versi pool (dipakai kartu) dgn mcap pasar.
  // Menggantikan cek lama yang hanya jalan utk pasangan ETH — pasangan USDG dulu
  // lolos tanpa pemeriksaan sama sekali.
  if (mcPool !== null && mcMarket !== null && mcPool > 0 && mcMarket > 0) {
    const ratio = mcPool / mcMarket;
    if (ratio > 1.25 || ratio < 0.8) {
      const x = ratio >= 1 ? ratio : 1 / ratio;
      priceWarn = `this pool prices the token ${x.toFixed(1)}× the market (market ${explore.usdShort(mcMarket)}) — liquidity is thin, and the value and range above follow this pool, not the market.`;
    }
  }
  // Ringkasan SELURUH ladder untuk kartu satu leg. Yang disetor user adalah
  // ladder, bukan satu anak tangga — tanpa blok ini kartu leg memperlihatkan
  // nilai & PnL sepersekian modal dan terbaca menyesatkan. Datanya dari daftar
  // v4 yang sudah ter-cache (45 dtk), jadi tak ada pembacaan per-leg.
  const ladderSum = tracked?.groupId
    ? await (async () => {
        const legs = v4store.groupV4(tracked.groupId!);
        if (legs.length < 2) return undefined;
        const live = await listPositionsV4(cc).catch(() => [] as V4Position[]);
        const byId = new Map(live.map((x) => [x.tokenId, x]));
        let filled = 0;
        let active = 0;
        let valWei = 0n;
        let feeWei = 0n;
        let depWei = 0n;
        let lo: number | null = null;
        let hi: number | null = null;
        let seen = 0;
        let baseWei = 0n;
        let otherWei = 0n;
        let otherAddr: string | null = null;
        for (const l of legs) {
          depWei += BigInt(l.entryBaseWei || '0');
          const x = byId.get(l.tokenId);
          if (!x) continue;
          seen++;
          if (x.inRange) active++;
          else if (x.converted) filled++;
          if (x.valueBaseWei !== null) valWei += x.valueBaseWei;
          feeWei += x.feesBaseWei ?? 0n;
          baseWei += x.baseAmountWei ?? 0n;
          otherWei += x.otherAmountWei ?? 0n;
          otherAddr = otherAddr ?? x.otherAddress;
          lo = lo === null ? x.tickLower : Math.min(lo, x.tickLower);
          hi = hi === null ? x.tickUpper : Math.max(hi, x.tickUpper);
        }
        // NILAI YANG BISA DIDAPAT, bukan harga pasar semu.
        //
        // valueBaseWei menilai sisi token pada harga pool SEKARANG. Untuk posisi
        // sebesar kedalaman pool-nya, angka itu tak pernah bisa diambil: menjualnya
        // menggerakkan harga. 28 Agu 2026 kartu menulis "+10.2%" lalu tutupnya
        // menghasilkan -5.5% — Relay menolak rutenya dengan "swap impact 31.06%".
        // Jadi sisi token DIKUTIP dengan quote nyata; gagal quote → jatuh ke harga
        // pool, tapi ditandai supaya tak terbaca sebagai angka pasti.
        let quotedOtherWei: bigint | null = null;
        if (otherWei > 0n && otherAddr && baseAddrOf(cc, p.base)) {
          const q = await previewSwapOut(otherAddr, baseAddrOf(cc, p.base)!, otherWei, cc).catch(() => null);
          quotedOtherWei = q ? q.out : null;
        }
        const realWei = quotedOtherWei === null ? valWei : baseWei + quotedOtherWei;
        const markVal = Number(ethers.formatUnits(valWei + feeWei, dec));
        const val = Number(ethers.formatUnits(realWei + feeWei, dec));
        // Selisih besar antara harga pasar & hasil jual = kedalaman pool tipis.
        const impactPct = markVal > 0 ? ((markVal - val) / markVal) * 100 : 0;
        const dep = Number(ethers.formatUnits(depWei, dec));
        const pnl = val - dep;
        const pct = dep > 0 ? (pnl / dep) * 100 : 0;
        const usdPer = p.base === 'USDG' ? 1 : ethUsdV4;
        // Rentang ladder = ujung terluar seluruh leg, dipatok ke entry yang sama
        // dengan baris mcap leg supaya kedua baris bisa dibandingkan langsung.
        let mcRangeLadder: string | undefined;
        if (lo !== null && hi !== null && tracked.entryMcap && tracked.entryTick !== undefined) {
          const sgn = tracked.baseIsCurrency0 ? -1 : 1;
          const mcOf = (tk: number) => tracked.entryMcap! * Math.pow(1.0001, sgn * (tk - tracked.entryTick!));
          // Urutkan berdasarkan NILAI, bukan urutan tick: base = currency0 membuat
          // tick naik berarti mcap turun, jadi tick tertinggi justru batas bawah.
          const ends = [mcOf(lo), mcOf(hi)].sort((x, y) => y - x);
          const nowStr = p.currentTick !== null ? ` · now ${explore.usdShort(mcOf(p.currentTick))}` : '';
          mcRangeLadder = `${explore.usdShort(ends[0])} ⇄ ${explore.usdShort(ends[1])}${nowStr}`;
        }
        return {
          valueLabel: seen ? `${val.toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''}` : undefined,
          exitNote:
            quotedOtherWei === null && otherWei > 0n
              ? 'token side priced at pool rate, not a live quote'
              : impactPct >= 2
                ? `after ${msg.fmtPct(-impactPct)} price impact on the token side`
                : undefined,
          feesLabel: feeWei > 0n ? `${Number(ethers.formatUnits(feeWei, dec)).toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''}` : undefined,
          pnlText: seen
            ? usdPer !== null
              ? `${msg.usdSigned(pnl * usdPer)} (${msg.fmtPct(pct)})`
              : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''} (${msg.fmtPct(pct)})`
            : undefined,
          mcRange: mcRangeLadder,
          filled,
          active,
          waiting: legs.length - filled - active,
        };
      })()
    : undefined;
  const text = msg.msgV4Position({
    tokenId: p.tokenId,
    pair: `${p.sym0} / ${p.sym1}`,
    feeLabel,
    valueLabel,
    feesLabel,
    rangeLabel,
    inRange: p.inRange,
    pnlText,
    tracked: !!tracked,
    priceWarn,
    baseSymbol,
    tokenSymbol,
    age: tracked ? msg.fmtAge(Date.now() - tracked.openedAt) : undefined,
    chain: cc.label,
    mcRange,
    converted: p.converted,
    ladder: tracked?.groupId
      ? (() => {
          const legs = v4store.groupV4(tracked.groupId!);
          const depWei = legs.reduce((s, l) => s + BigInt(l.entryBaseWei || '0'), 0n);
          // Porsi modal leg ini dari seluruh ladder — murni dari data tersimpan,
          // nol RPC tambahan. Bid-ask menaruh bobot terkecil di leg teratas,
          // jadi leg yang duluan habis biasanya justru yang paling kecil.
          const mine = BigInt(tracked.entryBaseWei || '0');
          return {
            sharePct: depWei > 0n ? Number((mine * 10000n) / depWei) / 100 : undefined,
            ...ladderSum,
            legIndex: tracked.legIndex ?? 0,
            legCount: tracked.legCount ?? legs.length,
            shape: tracked.shape ?? 'bidask',
            groupDeposit: legs.length > 1 ? msg.cleanUnits(depWei, dec) : undefined,
          };
        })()
      : undefined,
  });
  // Tombol "➕ <size> ETH" dihapus: jalur uang tanpa screening/preview/cap dengan
  // rentang default ~170% yang tak pernah ditampilkan. Tambah modal lewat /add.
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', `posv4:${p.tokenId}`), Markup.button.callback('‹ Positions', 'positions_refresh')],
      [Markup.button.callback('⛔ Close v4 Position', `closev4:${p.tokenId}`)],
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
  protocol?: string | null; // 'V3' | 'V4' — ditulis di judul baris
  wethEq: number; // setara-WETH utk total invest (USDG→WETH via ethUsd)
  strategy?: string | null;
  baseSymbol?: string | null; // aset yang disetor — label sisi ikut ini, bukan 'ETH' kaku
  rangeLabel?: string | null;
  feesLabel?: string | null;
  feesUsdLabel?: string | null;
  converted?: boolean;
  convertedInto?: string | null;
  feesBase?: number; // fee belum diklaim dalam base, utk total di footer
  natSym?: string; // simbol native chain posisi ini — total hanya sah bila seragam
  groupId?: string | null; // ladder: baris legs digabung jadi satu
  legShape?: string | null; // 'bidask' | 'spot'
};

/** Gabung baris leg satu grup ladder jadi SATU baris agregat (mutasi array). */
function collapseLadderRows(rows: PosRow[]): void {
  const groups = new Map<string, PosRow[]>();
  for (const r of rows) if (r.groupId) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
  for (const [gid, legs] of groups) {
    if (legs.length < 2) continue;
    const base = legs[0];
    const unit = base.investLabel.replace(/^[\d.]+\s*/, '');
    const sumInvest = legs.reduce((s, r) => s + (parseFloat(r.investLabel) || 0), 0);
    const pnlVals = legs.map((r) => r.pnlUsd).filter((x): x is number => x !== null);
    const sumPnlUsd = pnlVals.length ? pnlVals.reduce((a, b) => a + b, 0) : null;
    const sumWethEq = legs.reduce((s, r) => s + r.wethEq, 0);
    const wsum = legs.reduce((s, r) => s + r.wethEq, 0) || 1;
    const pct = legs.reduce((s, r) => s + (r.pnlPct ?? 0) * r.wethEq, 0) / wsum;
    base.pair = `${base.pair}  ◣×${legs.length}`;
    base.investLabel = `${sumInvest.toFixed(sumInvest >= 1 ? 4 : 6)} ${unit}`.trim();
    base.pnlUsd = sumPnlUsd;
    base.pnlPct = pnlVals.length ? pct : null;
    base.wethEq = sumWethEq;
    base.inRange = legs.some((r) => r.inRange);
    base.rangeLabel = `${legs.length}-leg ${base.legShape ?? 'ladder'} · ${base.rangeLabel ?? ''}`;
    // Leg selain yang pertama DIBUANG dari array di bawah, jadi fee-nya harus
    // dipindahkan ke baris gabungan dulu — kalau tidak, ladder 8-leg cuma
    // melaporkan fee leg 1 (dan footer total ikut kehilangan sisanya).
    const feeVals = legs.map((r) => r.feesBase).filter((v): v is number => typeof v === 'number');
    if (feeVals.length) {
      const sumFee = feeVals.reduce((a, b) => a + b, 0);
      base.feesBase = sumFee;
      base.feesLabel = `${sumFee.toFixed(sumFee >= 1 ? 4 : 6)} ${unit}`.trim();
      const usdVals = legs
        .map((r) => (r.feesUsdLabel ? Number(r.feesUsdLabel.replace(/[^0-9.-]/g, '')) : null))
        .filter((v): v is number => v !== null && Number.isFinite(v));
      base.feesUsdLabel = usdVals.length === feeVals.length ? `+${msg.usdPlain(usdVals.reduce((a, b) => a + b, 0))}` : null;
    }
    // Buang leg selain yang pertama dari array.
    for (const r of legs.slice(1)) {
      const i = rows.indexOf(r);
      if (i >= 0) rows.splice(i, 1);
    }
  }
}

// /positions — SATU pesan konsolidasi: ringkasan + pohon per-posisi (v3 + v4).
async function cmdPositions(ctx: any, edit = false) {
  const cc = getChain();
  // Tarik posisi on-chain yang belum tercatat (mis. dibuka setelah /start terakhir)
  // supaya /positions tak melewatkannya. Fungsi ini fail-safe: gagal baca = store
  // tak disentuh. Sebelumnya sync hanya di /start → posisi baru tak pernah muncul.
  await syncOnChainPositions(cc).catch(() => {});
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
      const rcc = ctxOf(rec); // chain POSISI, bukan chain utama
      const d = await getPositionDetail(rec.tokenId, rcc);
      const dec = d.baseDecimals;
      const curF = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
      const initF = rec.imported ? null : Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
      let pnlUsd: number | null = null;
      let pnlPct: number | null = null;
      if (initF !== null && initF > 0) {
        // PnL USD ala LP Agent bila entryEthUsd tersimpan; kalau tidak, view ETH lama.
        if (rec.entryEthUsd && rec.entryEthUsd > 0) {
          const nowUsdPer = isStableBase(d.baseKind) ? 1 : await getEthUsd(rcc.wethAddress, rcc).catch(() => null);
          if (nowUsdPer !== null) {
            const entryUsd = initF * rec.entryEthUsd;
            pnlUsd = curF * nowUsdPer - entryUsd;
            pnlPct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
          }
        } else {
          const pnlF = curF - initF;
          pnlPct = (pnlF / initF) * 100;
          pnlUsd = await baseToUsd(d.baseKind, pnlF, rcc);
        }
      }
      const investNum = initF ?? curF;
      const nativeUsd = await getEthUsd(rcc.wethAddress, rcc).catch(() => null);
      return {
        id: rec.tokenId,
        groupId: rec.groupId ?? null,
        legShape: rec.shape ?? null,
        pair: pairLabel(d.baseSymbol, rec.symbol),
        protocol: 'V3',
        investLabel: `${investNum.toFixed(dec >= 18 ? 4 : 2)} ${d.baseSymbol}`,
        age: msg.fmtAge(Date.now() - rec.openedAt),
        pnlUsd,
        pnlPct,
        inRange: d.inRange,
        // Setara-native utk baris TOTAL: stable dibagi harga native CHAIN INI
        // (USDT BSC → BNB), bukan harga ETH chain utama.
        wethEq: d.baseKind === 'weth' ? investNum : (nativeUsd ? investNum / nativeUsd : 0),
        natSym: rcc.nativeSymbol,
        // tickLower/Upper dalam istilah TICK; dalam istilah HARGA TOKEN urutannya
        // bisa terbalik (tergantung sisi base di pool) → urutkan menaik dulu.
        // Dibaca kembali oleh kartu untuk menentukan sisi — pakai penanda stabil
        // ('token'/'base'), bukan kalimat yang bisa berubah saat teks diterjemahkan.
        strategy: rec.side === 'token' ? 'token' : 'base',
        baseSymbol: d.baseSymbol,
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
        feesUsdLabel: await baseToUsd(d.baseKind, Number(ethers.formatUnits(d.feesBaseWei, dec)), rcc)
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
        protocol: 'V3',
        investLabel: 'read failed',
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
    const dec = v4BaseDecimals(cc, p.base);
    const tracked = v4store.getV4(p.tokenId);
    const curF = p.valueBaseWei !== null ? Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), dec)) : null;
    let investNum = curF ?? 0;
    let pnlUsd: number | null = null;
    let pnlPct: number | null = null;
    if (tracked) {
      const entF = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
      investNum = entF;
      if (curF !== null && entF > 0) {
        const nowUsdPer = p.base === 'USDG' ? 1 : ethUsd;
        if (tracked.entryEthUsd && tracked.entryEthUsd > 0 && nowUsdPer !== null) {
          const entryUsd = entF * tracked.entryEthUsd;
          pnlUsd = curF * nowUsdPer - entryUsd;
          pnlPct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
        } else {
          const pnlF = curF - entF;
          pnlPct = (pnlF / entF) * 100;
          pnlUsd = p.base === 'ETH' ? (ethUsd !== null ? pnlF * ethUsd : null) : pnlF; // USDG ≈ $1
        }
      }
    }
    const sym = v4BaseSymbol(cc, p.base);
    rows.push({
      id: p.tokenId,
      groupId: tracked?.groupId ?? null,
      legShape: tracked?.shape ?? null,
      pair: `${p.sym0} / ${p.sym1}`,
      protocol: 'V4',
      investLabel: `${investNum.toFixed(dec >= 18 ? 4 : 2)} ${sym}`,
      age: tracked ? msg.fmtAge(Date.now() - tracked.openedAt) : '—',
      pnlUsd,
      pnlPct,
      baseSymbol: sym,
      inRange: p.inRange ?? false, // null (tak diketahui) → dianggap out (konservatif)
      wethEq: p.base === 'USDG' ? (ethUsd ? investNum / ethUsd : 0) : investNum,
      natSym: getChain().nativeSymbol,
      // Fee v4 DULU tak pernah diisi di baris daftar, jadi posisi v4 yang sudah
      // lama in-range tetap terbaca "Uncollected Fees: —" seolah tak panen apa pun.
      // Datanya sudah ada di p.feesBaseWei — cuma tak pernah diteruskan ke sini.
      ...(p.feesBaseWei !== null && p.feesBaseWei !== undefined
        ? (() => {
            const f = Number(ethers.formatUnits(p.feesBaseWei, dec));
            const usdPer = p.base === 'USDG' ? 1 : ethUsd;
            return {
              feesLabel: `${f.toFixed(dec >= 18 ? 5 : 2)} ${sym}`,
              // Harga tak terbaca → null, kartu jatuh ke satuan base. Jangan $0.00 palsu.
              feesUsdLabel: usdPer !== null ? `+${msg.usdPlain(f * usdPer)}` : null,
              feesBase: f,
            };
          })()
        : {}),
    });
  }

  collapseLadderRows(rows);
  const totalWethEq = rows.reduce((s, r) => s + r.wethEq, 0);
  // Menjumlahkan ETH dengan BNB lalu melabelinya "WETH" adalah angka fiksi. Total
  // hanya ditampilkan bila SEMUA posisi berdenominasi native yang sama; kalau
  // campur, baris totalnya disembunyikan (per-posisi tetap benar).
  const units = new Set(rows.map((r) => r.natSym).filter(Boolean));
  const totalUnit = units.size === 1 ? [...units][0]! : null;
  const pnlVals = rows.map((r) => r.pnlUsd).filter((x): x is number => x !== null);
  const totalPnlUsd = pnlVals.length ? pnlVals.reduce((a, b) => a + b, 0) : null;
  const text = msg.msgPositionsList({
    dryRun: config.safety.dryRun,
    activeCount: rows.length,
    totalInvestLabel: totalUnit ? `≈ ${totalWethEq.toFixed(4)} ${totalUnit}` : null,
    totalPnlUsd,
    outOfRange: rows.filter((r) => !r.inRange).length,
    listDegraded: v4Supported(cc) && v4ListDegraded(),
    totalFeesLabel: (() => {
      // Fee total hanya bisa dijumlah bila semua posisi memakai base yang sama;
      // sekarang base tunggal (WETH), tapi tetap jaga-jaga: lewati bila tak ada data.
      if (!totalUnit) return null;
      const vals = rows.map((r) => r.feesBase).filter((v): v is number => typeof v === 'number');
      return vals.length ? `≈ ${vals.reduce((a, b) => a + b, 0).toFixed(5)} ${totalUnit}` : null;
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
    Markup.button.callback('⬅️ Back', 'positions_back'),
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
  await ctx.answerCbQuery('Refreshing…');
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
  await ctx.answerCbQuery('Loading…');
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
    if (!p) return ctx.reply(msg.msgError('detail', 'position not found.'), html);
    const ethUsdV4 = p.base === 'ETH' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : null;
    const c = await buildV4Card(p, ethUsdV4, cc);
    return ctx.reply(c.text, c.extra);
  } catch (e) {
    return ctx.reply(msg.msgError('detail', (e as Error).message), html);
  }
});

// /history — riwayat trade tertutup, dari file jurnal khusus (tak muncul di /positions).
// Tombol pool → wizard /add penuh (screening & preview tetap jalan).
bot.action(/^x:([a-z0-9_-]+):(0x[0-9a-fA-F]{40})$/i, async (ctx: any) => {
  await ctx.answerCbQuery();
  resetFlows(ctx.from!.id);
  return continueAddlp(ctx, ctx.match[2], ctx.match[1], null);
});
// Bentuk lama tanpa chain — tombol di pesan yang sudah terkirim sebelum ini.
bot.action(/^x:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  resetFlows(ctx.from!.id);
  return continueAddlp(ctx, ctx.match[1], getChain().key, null);
});

/** Langkah 1 /add_lp tanpa CA — pair dari pool ber-APR teratas + opsi cari sendiri. */
async function pairPicker(ctx: any) {
  const prog = await ctx.reply(msg.msgProgress('loading top pools…'), html);
  const pools = await explore.fetchTopPools(getChain(), 5).catch(() => []);
  const withCa = pools.filter((p) => p.otherAddr);
  const rows = withCa.map((p) => [
    Markup.button.callback(`${p.pair} · ${msg.feeLabel(p.feeTier)}`, `x:${p.otherAddr}`),
  ]);
  rows.push([Markup.button.callback('🔍 Search Your Own Pair', 'pair:custom')]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  await editProgress(ctx, prog, msg.msgPairPicker(withCa.length), { ...html, ...Markup.inlineKeyboard(rows) });
}

bot.action('pair:custom', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgPairCustom(), html);
});

// /pools DIHAPUS sementara (permintaan pemilik). Modul src/explore.ts TETAP dipakai
// wizard /add_lp (poolsForToken, fetchTopPools), jadi jangan ikut dibuang. Untuk
// menghidupkan lagi: kembalikan cmdExplore + exploreKb + loadExplore, daftarkan
// bot.command('pools') & action 'explore'/'explore:refresh', dan entri menu.

// Audit keamanan token: tempel CA telanjang di chat → startTokenHub. Command
// /token_info dihapus — jalurnya sama persis, jadi cuma pintu kedua ke kartu yang sama.

bot.action(/^detail:(\d+)$/, async (ctx) => {
  const rec = store.get(ctx.match[1]);
  if (!rec) return ctx.answerCbQuery('Position not found.');
  await ctx.answerCbQuery('Loading…');
  try {
    await renderPositionDetail(ctx, rec, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — bukan error
    await ctx.reply(msg.msgError('detail', (e as Error).message), html);
  }
});

bot.action(/^back:card:(\d+)$/, async (ctx) => {
  const rec = store.get(ctx.match[1]);
  if (!rec) return ctx.answerCbQuery('Position not found.');
  await ctx.answerCbQuery('Loading…');
  try {
    await renderPositionCard(ctx, rec, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — bukan error
    await ctx.reply(msg.msgError('card', (e as Error).message), html);
  }
});

// ---------- Fase 3: tulis (wizard /add bertahap) ----------

/** Keyboard pilih pool: pasangan (WETH/USDG) · fee · kedalaman. Callback bawa base. */
const POOL_PICK_MAX = 3; // TOP 3 by skor kedalaman (lihat poolSize) — sisanya tak ditawarkan

// tickSpacing pool: v4 langsung; v3 dipetakan dari fee tier standar.
function poolSpacing(p: explore.TokenPool, cc: ChainCtx = getChain()): number {
  if (p.poolKey?.tickSpacing) return p.poolKey.tickSpacing;
  return cc.tickSpacing[p.fee] ?? 60;
}
// Seberapa dekat harga harus bergerak sebelum single-side MULAI terisi — tepi
// range wajib kelipatan tickSpacing, worst-case ≈ 1 spacing. Makin kecil, makin cepat isi.
function fillTightnessPct(p: explore.TokenPool): number {
  return (Math.pow(1.0001, poolSpacing(p)) - 1) * 100;
}
// Pool teratas bisa punya spacing kasar (isi single-side lebih lambat) — karena itu
// angka 'fills≤x%' tetap dicetak di kartunya supaya kompromi itu terlihat sebelum
// ditekan.
//
// Ambang kedalaman: pool di bawah ini tak layak jadi tempat menaruh modal, berapa
// pun volumenya. Volume BUKAN pengganti kedalaman — ia gampang dipalsukan.
export const MIN_POOL_TVL_USD = 1_000;
// Bobot volume dalam peringkat. TVL & volume beda satuan (stok vs aliran) dan
// volume 24 jam rutin 10–30× TVL, jadi menjumlahkannya mentah-mentah membuat
// peringkat efektif = volume saja: pernah terjadi di produksi, pool TVL $429k
// (vol $12,8M) mengalahkan pool TVL $654k (vol $6,7M). Untuk LP yang menentukan
// risiko eksekusi & slippage adalah kedalaman, jadi TVL yang memimpin dan volume
// hanya menambah nilai — bukan mengambil alih.
// Bobot saja tak cukup: dengan volume rutin 30× TVL, bahkan 0,25× masih mengambil
// alih peringkat. Kontribusi volume karena itu DIBATASI setinggi-tingginya sebesar
// TVL pool itu sendiri — volume boleh menggandakan skor, tak boleh lebih. Efeknya:
// pool yang lebih dalam tak akan pernah kalah oleh pool yang >2× lebih dangkal,
// seberapa pun ramai volumenya (yang gampang dipalsukan).
const VOL_WEIGHT = 0.25;
// Peringkat pool = kedalaman + bonus aktivitas fee (dibatasi). Seri → spacing halus.
const poolSize = (p: explore.TokenPool): number => {
  const tvl = p.tvlUsd;
  return tvl + Math.min(VOL_WEIGHT * (p.vol24hUsd ?? 0), tvl);
};
function rankPoolsForFill(pools: explore.TokenPool[]): explore.TokenPool[] {
  return [...pools].sort((a, b) => poolSize(b) - poolSize(a) || poolSpacing(a) - poolSpacing(b));
}

const tightLabel = (p: explore.TokenPool): string => {
  const t = fillTightnessPct(p);
  return `${t < 1 ? t.toFixed(1) : Math.round(t)}%`;
};

/** Ringkasan pool untuk kartu langkah 1 (maks POOL_PICK_MAX, urut TVL). */
const poolSummaries = (pools: explore.TokenPool[]) =>
  pools.slice(0, POOL_PICK_MAX).map((p) => ({
    pair: `${p.otherSymbol} / ${p.baseSymbol}`,
    ver: p.protocol.toUpperCase(),
    feeLabel: msg.feeLabel(p.fee),
    tvl: msg.usdCompact(p.tvlUsd),
    vol: p.vol24hUsd != null && p.vol24hUsd > 0 ? msg.usdCompact(p.vol24hUsd) : '?',
    // APR null = volume tak terbaca. '~0.0%' akan mengarang pool mati.
    apr: p.aprPct == null ? '?' : `~${p.aprPct >= 100 ? Math.round(p.aprPct) : p.aprPct.toFixed(1)}%`,
    tight: tightLabel(p),
  }));

function poolKeyboard(pools: explore.TokenPool[]) {
  return Markup.inlineKeyboard([
    ...pools.slice(0, POOL_PICK_MAX).map((p, i) => [
      Markup.button.callback(`${p.otherSymbol} / ${p.baseSymbol} (${msg.feeLabel(p.fee)})`, `pick:${i}`),
    ]),
    [Markup.button.callback('❌ Cancel', 'cancel')],
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
  const text = msg.msgPoolStep(
    `$${flow.pools[0]?.otherSymbol ?? '?'} (${getChain(flow.chain).label})`,
    poolSummaries(flow.pools),
  );
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
      [Markup.button.callback(`🟢 ${base.symbol} Side (Buy ${sel?.otherSymbol ?? 'Token'})`, 'strat:base')],
      [Markup.button.callback(`🔵 Token Side (Sell ${sel?.otherSymbol ?? 'Token'})`, 'strat:token')],
      [Markup.button.callback('⬅️ Back', 'back:pool'), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 4/5 — pilih lebar rentang (%). */
async function renderRangeStep(ctx: any, flow: AddFlow, edit: boolean) {
  const up = flow.strategy === 'token';
  const rows = RANGE_OPTIONS.map((o) => [
    Markup.button.callback(`${up ? '📈 +' : '📉 -'}${o.pct}% ${o.label}`, `rng:${o.pct}`),
  ]);
  rows.push([
    Markup.button.callback('⬅️ Back', 'back:amount'),
    Markup.button.callback('❌ Cancel', 'cancel'),
  ]);
  const text = msg.msgRangeStep(flow.strategy === 'token');
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Langkah 3/4 — pilih nominal ETH. */
/** Base asset yang dipilih di wizard (weth/usdg/usdt). */
const wizardBase = (flow: AddFlow): BaseAsset => baseOf(getChain(flow.chain), flow.base ?? 'weth');
/** ctx wizard = chain + venue pool yang DIPILIH (Uniswap v3 di BSC punya factory sendiri). */
const wizardCtx = (flow: AddFlow): ChainCtx => venueCtx(getChain(flow.chain), flow.selected?.venue);

/** Konteks nominal base-aware: preset (dari /size per-aset), simbol, batas, contoh. */
function amountCtx(flow: AddFlow) {
  const base = wizardBase(flow);
  const stable = isStableBase(base.kind);
  // Sisi token: satuannya token itu sendiri, jadi angka tetap tak bermakna —
  // MAX_ETH_PER_TX tak berlaku di sini. Tapi batasnya TETAP ADA: saldo token yang
  // benar-benar dipegang, dibaca saat nominal diketik (lihat penegakan di bawah).
  if (flow.strategy === 'token') {
    return {
      symbol: flow.selected?.otherSymbol ?? 'TOKEN',
      cap: Infinity, // diganti saldo nyata sebelum ditegakkan
      capLabel: 'your full balance',
      example: '1000',
    };
  }
  // Tiap denominasi punya batasnya sendiri: ETH/BNB pakai MAX_ETH_PER_TX,
  // USDT/USDG pakai MAX_STABLE_PER_TX (satuan dolar, tak bisa disamakan).
  const cap = stable ? maxStable : maxEth;
  return {
    symbol: base.symbol,
    cap,
    capLabel: capLabelFor(cap, base.symbol),
    example: stable ? '50' : '0.02',
  };
}

async function renderAmountStep(ctx: any, flow: AddFlow, edit: boolean) {
  // Nominal boleh diketik ATAU dipilih sebagai persentase saldo. Persentase
  // dihitung dari saldo YANG BISA DIPAKAI, bukan saldo mentah — lihat usableFor().
  flow.awaitingAmount = true;
  const a = amountCtx(flow);
  const rows: any[] = [];
  rows.push(...pctPresets.chunkButtons(pctPresets.get('add').map((p) => Markup.button.callback(`${p}%`, `amt:${p}`))));
  rows.push([Markup.button.callback('⬅️ Back', 'back:strategy')], [Markup.button.callback('❌ Cancel', 'cancel')]);
  // Saldo (1 RPC, gagal → '?': jangan pernah memblokir langkah ini).
  const dec = flow.strategy === 'token' ? (flow.tokenDec ?? 18) : wizardBase(flow).decimals;
  const raw = await rawBalanceFor(flow).catch(() => null);
  const balLabel = raw === null ? '?' : `${msg.cleanUnits(raw, dec)} ${a.symbol}`;
  const text = msg.msgAmountStep(a.symbol, a.capLabel, balLabel, a.example);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Persentase saldo yang ditawarkan di langkah nominal. */

/** Saldo mentah sisi yang sedang dipilih (token / native / stablecoin). */
async function rawBalanceFor(flow: AddFlow): Promise<bigint> {
  const cc = wizardCtx(flow);
  if (flow.strategy === 'token') {
    return new ethers.Contract(flow.token, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
  }
  const base = wizardBase(flow);
  return base.wrappable
    ? cc.provider.getBalance(cc.wallet.address)
    : new ethers.Contract(base.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
}

/**
 * Saldo yang BENAR-BENAR bisa disetor. Untuk aset native, ongkos gas dipotong
 * lebih dulu: 90% dari saldo mentah akan menghabiskan gas, wrap berhasil lalu
 * mint gagal, dan dana terjebak sebagai WETH. Sisi token & stablecoin tak
 * membayar gas dari dirinya sendiri, jadi dipakai utuh.
 */
async function usableFor(flow: AddFlow): Promise<bigint> {
  const raw = await rawBalanceFor(flow);
  if (flow.strategy === 'token' || !wizardBase(flow).wrappable) return raw;
  const buf = await gasBuffer(wizardCtx(flow));
  return raw > buf ? raw - buf : 0n;
}

bot.action(/^amt:(\d{1,3})$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const flow = getFlow(ctx);
  if (!flow?.awaitingAmount) return;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  const pct = Number(ctx.match[1]);
  if (!pctPresets.get('add').includes(pct)) return;

  const dec = flow.strategy === 'token' ? (flow.tokenDec ?? 18) : wizardBase(flow).decimals;
  const usable = await usableFor(flow).catch(() => null);
  if (usable === null) return ctx.reply(msg.msgError('amount', 'Balance read failed — type the amount instead.'), html);
  if (usable <= 0n) {
    return ctx.reply(
      msg.msgError('amount', 'Nothing available to deposit on this side after the gas reserve.'),
      html,
    );
  }

  let wei = (usable * BigInt(pct)) / 100n;

  // Batas per-tx tetap berlaku pada tombol, persis seperti pada nominal ketikan.
  const a = amountCtx(flow);
  const capWei = a.cap === Infinity ? null : ethers.parseUnits(String(a.cap), dec);
  if (capWei !== null && wei > capWei) wei = capWei;
  if (wei <= 0n) return ctx.reply(msg.msgError('amount', 'That percentage rounds to zero.'), html);

  flow.awaitingAmount = false;
  flow.ethAmount = ethers.formatUnits(wei, dec);
  await renderRangeStep(ctx, flow, false);
});

/** Langkah 4/4 — hitung & tampilkan rencana + konfirmasi. */
async function renderPlanStep(ctx: any, flow: AddFlow, edit: boolean) {
  if (flow.selected?.protocol === 'v4') return renderPlanStepV4(ctx, flow, edit);
  const cc = wizardCtx(flow);
  const base = baseOf(cc, flow.base ?? 'weth');
  const isLadder = flow.strategy === 'base' && flow.shape === 'bidask' && (flow.legs ?? 1) > 1;
  // plan + estimasi biaya paralel (saling independen).
  const tokenSide = flow.strategy === 'token';
  const [planSettled, costSettled] = await Promise.allSettled([
    tokenSide
      ? planAddTokenSide(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc)
      : isLadder
        ? planLadderSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, flow.legs!, 'bidask', base, cc).then((legs) => legs[0])
        : planAddSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc),
    // Sisi token tak menyetor base: yang perlu dicek cuma gas, bukan saldo base.
    estimateAddCost(cc, base, tokenSide ? '0' : flow.ethAmount!),
  ]);
  if (planSettled.status === 'rejected') throw planSettled.reason;
  const plan = planSettled.value;
  flow.plan = plan;
  // Ladder: hitung SEMUA leg untuk preview & simpan buat confirm. pctHigh = leg
  // terdekat, pctLow = leg terjauh → preview menampilkan rentang gabungan.
  let ladderNote: string | undefined;
  if (isLadder) {
    const legPlans = await planLadderSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, flow.legs!, 'bidask', base, cc);
    flow.ladderPlans = legPlans;
    const w = ladderWeights(legPlans.length, 'bidask');
    plan.pctHigh = legPlans[0].pctHigh;
    plan.pctLow = legPlans[legPlans.length - 1].pctLow;
    plan.priceLower = legPlans[legPlans.length - 1].priceLower;
    plan.priceUpper = legPlans[0].priceUpper;
    ladderNote =
      `\n\n◣ <b>BID-ASK ladder · ${legPlans.length} leg</b>\n` +
      legPlans
        .map((lp, i) => `  ${i + 1}. ${msg.fmtPct(lp.pctHigh)}…${msg.fmtPct(lp.pctLow)} · ${(w[i] * 100).toFixed(0)}% of capital`)
        .join('\n') +
      `\n<i>Bigger size the lower the price — that is the buy-the-dip shape.</i>`;
  } else {
    flow.ladderPlans = undefined;
  }
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
  const fullText = ladderNote ? text + ladderNote : text;
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Sign', 'addok')],
      [Markup.button.callback('⬅️ Back', isLadder ? 'back:legs' : 'back:range'), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  await (edit ? ctx.editMessageText(fullText, extra) : ctx.reply(fullText, extra));
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
  const isLadder = flow.shape === 'bidask' && (flow.legs ?? 1) > 1;
  let rangePctHigh: number;
  let rangePctLow: number;
  let ladderNote: string | undefined;
  if (isLadder) {
    // Ladder v4: hitung leg (batch modifyLiquidities) untuk preview + simpan.
    const legs = await planLadderV4(cc, pk, pool.baseIsCurrency0!, amountWei, flow.rangePct!, flow.legs!, 'bidask');
    flow.v4LadderLegs = legs;
    const total = legs.reduce((s, l) => s + l.baseAmountWei, 0n);
    rangePctHigh = legs[0].pctHigh;
    rangePctLow = legs[legs.length - 1].pctLow;
    ladderNote =
      `\n\n◣ <b>BID-ASK ladder v4 · ${legs.length} leg · 1 tx atomik</b>\n` +
      legs
        .map((l, i) => `  ${i + 1}. ${msg.fmtPct(l.pctHigh)}…${msg.fmtPct(l.pctLow)} · ${((Number(l.baseAmountWei) / Number(total)) * 100).toFixed(0)}% of capital`)
        .join('\n') +
      `\n<i>Bigger size the lower the price — that is the buy-the-dip shape.</i>`;
  } else {
    flow.v4LadderLegs = undefined;
    const widthSpacings = rangePctToSpacings(flow.rangePct!, pk.tickSpacing);
    const sim = await openPositionV4(cc, pk, pool.baseIsCurrency0!, amountWei, { widthSpacings, dryRun: true });
    const val = await valuePositionV4(cc, pk, sim.tickLower, sim.tickUpper, sim.liquidity);
    rangePctHigh = val.rangePctHigh;
    rangePctLow = val.rangePctLow;
  }
  const depositUsd = (await baseToUsd(wizardBase(flow).kind, Number(flow.ethAmount!), cc)) ?? undefined;
  const text0 = msg.msgPlanStepV4({
    screenDanger: flow.screenBahaya,
    screenFailed: flow.screenFailed,
    baseSymbol: pool.baseSymbol,
    symbol: pool.otherSymbol,
    fee: pool.fee,
    tvlUsd: pool.tvlUsd,
    depositAmount: flow.ethAmount!,
    depositUsd,
    rangePctHigh,
    rangePctLow,
    dryRun: config.safety.dryRun,
  });
  const text = ladderNote ? text0 + ladderNote : text0;
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Sign', 'addok')],
      [Markup.button.callback('⬅️ Back', isLadder ? 'back:legs' : 'back:range'), Markup.button.callback('❌ Cancel', 'cancel')],
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
    msg.msgProgress(pre ? 'finding pools…' : `auditing token & finding pools on ${cc.label}…`),
  );
  const [screened, found, krystalFound] = await Promise.allSettled([
    pre ? Promise.resolve(null) : screenToken(token, cc),
    explore.poolsForToken(cc, token),
    krystal.krystalPools(cc, token),
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

  let gwPools: explore.TokenPool[];
  if (found.status === 'fulfilled') {
    gwPools = found.value;
  } else {
    console.log('[poolsForToken] gateway gagal, fallback v3 on-chain:', String(found.reason).slice(0, 120));
    gwPools = await discoverAllPoolsFallback(token, cc).catch(() => []);
  }
  // Krystal = sumber pool yang lengkap (gateway sering melewatkan pool ETH/token
  // ber-TVL besar & melaporkan TVL ngawur). poolKey-nya sudah DIVERIFIKASI on-chain
  // (event Initialize), jadi tak perlu resolve ulang & fee-nya fee poolKey asli.
  const kPools = krystalFound.status === 'fulfilled' ? krystalFound.value : [];
  if (krystalFound.status === 'rejected')
    console.log('[krystal] gagal:', String(krystalFound.reason).slice(0, 120));
  const poolIdOf = (p: explore.TokenPool): string | null =>
    p.poolKey
      ? ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['tuple(address,address,uint24,int24,address)'],
            [[p.poolKey.currency0, p.poolKey.currency1, p.poolKey.fee, p.poolKey.tickSpacing, p.poolKey.hooks]],
          ),
        )
      : null;
  const kIds = new Set(kPools.map(poolIdOf).filter(Boolean) as string[]);
  // v3 tak punya poolId; dedup-nya per (venue+base+fee) — satu token+DEX+base+fee =
  // satu pool v3. Venue WAJIB ikut: Uniswap v3 & PancakeSwap v3 di BSC bisa punya
  // base+fee sama tapi itu dua pool berbeda di dua factory berbeda.
  const v3Key = (p: explore.TokenPool) => `v3:${p.venue ?? ''}:${p.base}:${p.fee}`;
  const kV3 = new Set(kPools.filter((p) => p.protocol === 'v3').map(v3Key));

  // Gateway: v3 tetap disaring fee-tier standar; v4 poolKey-nya divalidasi/di-resolve
  // on-chain (urutan currency & ETH-native sering salah). Pool yang sudah ada di
  // Krystal (by poolId) dibuang di sini supaya tak dobel. TIDAK ada lagi cap fee:
  // pool asli Robinhood justru ber-fee tinggi (5%+); yang membedakan asli vs jebakan
  // adalah TVL/likuiditas, bukan fee.
  const gwFixed = (
    await Promise.all(
      gwPools
        // feeTiers diuji terhadap VENUE pool itu (Uniswap 3000 vs PancakeSwap 2500).
        .filter((p) => (p.protocol === 'v4' ? true : venueCtx(cc, p.venue).feeTiers.includes(p.fee)))
        .map(async (p) => {
          if (p.protocol !== 'v4' || !p.poolKey) {
            return kV3.has(v3Key(p)) ? null : p; // v3 sudah ada di Krystal → skip
          }
          const fixed = await resolvePoolKeyV4(cc, p.poolKey, p.baseIsCurrency0!).catch(() => null);
          if (!fixed) return null;
          const merged = { ...p, poolKey: fixed.poolKey, baseIsCurrency0: fixed.baseIsCurrency0 };
          const id = poolIdOf(merged);
          return id && kIds.has(id) ? null : merged; // sudah ada versi Krystal → skip
        }),
    )
  ).filter((p): p is explore.TokenPool => p !== null);

  // Krystal duluan (TVL benar & poolKey terverifikasi), lalu sisa gateway.
  let pools = [...kPools, ...gwFixed];
  // Buang pool v4 ETH yang SEKARAT: TVL gateway sering nol/salah utk v4, dan pool
  // liq ~$0 harganya nyangkut jauh dari pasar → dana yang disetor langsung
  // "hilang" ke harga palsu (persis kasus PEPE di pool liq $25). Saring pakai
  // likuiditas aktif on-chain + selisih harga vs pasar (DexScreener).
  {
    const tokMkt = await getTokenEthPrice(token, cc).catch(() => null);
    pools = (
      await Promise.all(
        pools.map(async (p) => {
          if (p.protocol !== 'v4' || !p.poolKey) return p;
          const h = await poolHealthV4(cc, p.poolKey).catch(() => null);
          // Likuiditas AKTIF 0 = pool mati (TVL gateway sering bohong: mis. BULL
          // fee 30000 "TVL $173" tapi activeLiq 0). Mint di sini → 'liquidity 0'
          // atau dana nyangkut. Buang, apapun base-nya (ETH & USDG sama saja).
          if (!h || h.liquidity === 0n) return null;
          // Utk pasangan ETH ada acuan harga pasar → buang juga yang melenceng >25%.
          if (p.base === 'weth' && tokMkt && h.impliedTokenEthPrice) {
            const r = h.impliedTokenEthPrice / tokMkt;
            if (r > 1.25 || r < 0.8) return null;
          }
          return p;
        }),
      )
    ).filter((p): p is explore.TokenPool => p !== null);
  }
  // Jaminan SINGLE-SIDE: hanya pool yang base-nya benar-benar didukung chain ini
  // (ETH/USDG di Robinhood, BNB/USDT di BSC). base datang dari 3 sumber berbeda —
  // ini penjaga terakhir supaya tiap pool yang ditawarkan pasti bisa dibuka 1-sisi.
  const okBase = new Set(cc.bases.map((b) => b.kind));
  pools = pools.filter((p) => okBase.has(p.base));
  // Ambang diuji pada TVL SENDIRI, bukan TVL+Volume. Dengan ambang gabungan, volume
  // palsu meloloskan pool kosong: 20 Agu 2026 pool `USDT/牛来 fee100` ber-TVL $2
  // (vol $83k) benar-benar tampil di top-3. Lebih baik menawarkan <3 pool nyata.
  const sized = pools.filter((p) => p.tvlUsd >= MIN_POOL_TVL_USD);
  if (sized.length > 0) pools = sized;
  if (pools.length === 0) {
    await editProgress(ctx, prog, msg.msgNoPools(cc.bases.map((b) => b.symbol).join('/')));
    return;
  }
  // Cukup TOP-3 by TVL+Volume (rankPoolsForFill), gabungan semua sumber chain ini.
  pools = rankPoolsForFill(pools).slice(0, POOL_PICK_MAX);
  console.log(
    `[add] ${token} ${cc.key}: krystal=${kPools.length} gateway=${gwPools.length} → top${pools.length}` +
      ` | ${pools.map((p) => `${p.baseSymbol}/${p.otherSymbol} ${p.protocol} fee${p.fee} $${Math.round(p.tvlUsd)}+v${Math.round(p.vol24hUsd ?? 0)}`).join(' , ')}`,
  );

  // 3) Mulai wizard — reuse bubble progress jadi step pilih pool.
  const flow: AddFlow = { token, chain: chainKey, screenBahaya, screenFailed, pools, startedAt: Date.now() };
  flows.set(ctx.from.id, flow);
  await editProgress(ctx, prog, msg.msgPoolStep(`$${pools[0]?.otherSymbol ?? '?'} (${cc.label})`, poolSummaries(pools)), {
    ...html,
    ...poolKeyboard(pools),
  });
}

// Simpan token yang menunggu pilihan chain.

bot.command('add_lp', async (ctx: any) => {
  resetFlows(ctx.from!.id); // alur baru = buang sisa alur lama (anti-hijack ketikan)
  const [, token] = ctx.message.text.trim().split(/\s+/);
  // Tanpa CA → langkah 1 naskah: pilih pair dari pool teratas, atau cari sendiri.
  if (!token) return pairPicker(ctx);
  if (!ethers.isAddress(token)) return ctx.reply(msg.msgInvalidAddress(), html);

  // 0) Deteksi chain — 1 bubble progress (di-edit di langkah berikutnya).
  const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
  const found = await detectChains(token);
  if (found.length === 0) {
    return editProgress(
      ctx,
      prog,
      msg.msgError(
        'chain',
        `Token not found on any chain (${Object.values(CHAINS)
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
      [Markup.button.callback('❌ Cancel', 'cancel')],
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
  if (!flow) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  const sel = flow.pools[Number(ctx.match[1])];
  if (!sel) return ctx.answerCbQuery('Invalid choice — start again with /add_lp.');
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
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  if (flow.selected?.protocol === 'v4' && ctx.match[1] === 'token') {
    return ctx.answerCbQuery('Token side is not supported on v4 pools — pick a v3 pool.');
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
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.strategy = undefined;
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderStrategyStep(ctx, flow, true);
});

bot.action(/^rng:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.rangePct = Number(ctx.match[1]);
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  // Ladder Bid-Ask sisi BASE (buy-dip) — v3 (multicall) & v4 (batch modifyLiquidities).
  // Sisi token → preview SPOT tunggal (perilaku lama).
  if (flow.strategy === 'base') {
    await ctx.answerCbQuery();
    return renderShapeStep(ctx, flow, true);
  }
  flow.shape = 'spot';
  flow.legs = 1;
  await ctx.answerCbQuery('Calculating preview…');
  try {
    await renderPlanStep(ctx, flow, true);
  } catch (err) {
    await ctx.reply(msg.msgError('plan', (err as Error).message), html);
  }
});

/** Langkah pilih BENTUK distribusi: SPOT (rata, 1 posisi) atau BID-ASK (ladder buy-dip). */
async function renderShapeStep(ctx: any, flow: AddFlow, edit: boolean) {
  const text = msg.msgShapeStep(flow.selected?.otherSymbol ?? 'token', flow.rangePct ?? 0);
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('▬ SPOT (one position, earns fees)', 'shape:spot')],
      [Markup.button.callback('◣ BID-ASK ladder (buy-dip) →', 'shape:bidask')],
      [Markup.button.callback('⬅️ Back', 'back:range'), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Pilih jumlah leg untuk ladder Bid-Ask (auto-cap ke spacing pool saat plan). */
async function renderLegStep(ctx: any, flow: AddFlow, edit: boolean) {
  const text = msg.msgLegStep(flow.selected?.otherSymbol ?? 'token', flow.rangePct ?? 0);
  // Pilihan leg diambil dari setelan (/settings → Ladder legs), bukan daftar mati.
  const opts = pctPresets.get('legs').map((n) =>
    Markup.button.callback(n >= 15 ? `${n} legs · 💸 paid RPC` : `${n} legs`, `leg:${n}`),
  );
  // Yang butuh RPC berbayar dipisah ke barisnya sendiri biar tak asal kepencet.
  const cheap = opts.filter((_, i) => pctPresets.get('legs')[i] < 15);
  const pricey = opts.filter((_, i) => pctPresets.get('legs')[i] >= 15);
  const rows = [
    ...pctPresets.chunkButtons(cheap),
    ...pctPresets.chunkButtons(pricey),
    [Markup.button.callback('⬅️ Back', 'back:shape'), Markup.button.callback('❌ Cancel', 'cancel')],
  ];
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

bot.action(/^shape:(spot|bidask)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.shape = ctx.match[1] as 'spot' | 'bidask';
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  if (flow.shape === 'bidask') {
    await ctx.answerCbQuery();
    return renderLegStep(ctx, flow, true);
  }
  flow.legs = 1;
  await ctx.answerCbQuery('Calculating preview…');
  try {
    await renderPlanStep(ctx, flow, true);
  } catch (err) {
    await ctx.reply(msg.msgError('plan', (err as Error).message), html);
  }
});

bot.action(/^leg:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.shape = 'bidask';
  flow.legs = Math.max(2, Math.min(69, Number(ctx.match[1])));
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  await ctx.answerCbQuery('Calculating preview…');
  try {
    await renderPlanStep(ctx, flow, true);
  } catch (err) {
    await ctx.reply(msg.msgError('plan', (err as Error).message), html);
  }
});

bot.action('back:pool', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow) return ctx.answerCbQuery('Expired — start again with /add_lp.');
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
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderRangeStep(ctx, flow, true);
});

bot.action('back:shape', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  await ctx.answerCbQuery();
  await renderShapeStep(ctx, flow, true);
});

bot.action('back:legs', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  await ctx.answerCbQuery();
  await renderLegStep(ctx, flow, true);
});

bot.action('back:amount', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.strategy === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

bot.action('addok', async (ctx) => {
  const flow = getFlow(ctx);
  // --- Jalur LADDER v4 (batch modifyLiquidities: N leg dalam 1 tx atomik) ---
  if (flow?.selected?.protocol === 'v4' && flow.shape === 'bidask' && (flow.legs ?? 1) > 1) {
    if (!flow.ethAmount || flow.rangePct === undefined || !flow.v4LadderLegs?.length)
      return ctx.answerCbQuery('Expired — start again with /add_lp.');
    const { selected, ethAmount, chain } = flow;
    flows.delete(ctx.from!.id);
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    const groupId = `V${Date.now()}`;
    try {
      const cc = getChain(chain);
      const pk = selected.poolKey!;
      const base = baseOf(cc, selected.base);
      // Re-plan segar sebelum kirim (tick tak basi).
      const legs = await planLadderV4(cc, pk, selected.baseIsCurrency0!, ethers.parseUnits(ethAmount, base.decimals), flow.rangePct, flow.legs!, 'bidask');
      await ensureGasForLegs(cc, legs.length, base.wrappable ? legs.reduce((s, l) => s + l.baseAmountWei, 0n) : 0n);
      await ctx.editMessageText(msg.msgProgress(`opening ${legs.length}-leg v4 ladder (1 atomic tx)…`), html);
      const entryEthUsd = selected.base === 'usdg' ? 1 : ((await getEthUsd(cc.wethAddress, cc).catch(() => null)) ?? undefined);
      const tokenAddr = selected.baseIsCurrency0! ? pk.currency1 : pk.currency0;
      const [entryTick, entryMcap] = await Promise.all([
        currentTickV4(cc, pk).catch(() => undefined),
        explore.tokenMarketCap(cc, tokenAddr).catch(() => null),
      ]);
      // Kurung rentang id SEBELUM kirim. Kalau alur ini gagal setelah tx mendarat
      // (wait timeout, log tak terbaca, revert di percobaan lanjutan), NFT sudah
      // lahir tapi tak tercatat — itulah cara posisi jadi "hilang" dari
      // /positions. Rentang ini membuatnya bisa dipungut lagi.
      const idBefore = await v4NextTokenId(cc).catch(() => null);
      let ids: string[];
      try {
        ids = (await openLadderV4(cc, pk, selected.baseIsCurrency0!, legs, { dryRun: false })).tokenIds;
      } catch (e) {
        // Gagal ≠ tak jadi. Pungut dulu yang terlanjur ter-mint, baru lempar.
        const stray = idBefore !== null ? await adoptStrayV4(cc, idBefore) : [];
        if (stray.length === 0) throw e;
        ids = stray;
        await ctx.reply(
          msg.msgError('add v4 ladder', `${(e as Error).message.slice(0, 160)}\n\n${stray.length} leg(s) had already been minted, and are now tracked by the bot.`),
          html,
        );
      }
      // Sukses tapi jumlahnya kurang → sisanya juga dipungut lewat jalur yang sama.
      if (idBefore !== null && ids.length < legs.length) {
        const stray = await adoptStrayV4(cc, idBefore);
        if (stray.length > ids.length) ids = stray;
      }
      const r = { tokenIds: ids };
      for (let i = 0; i < r.tokenIds.length; i++) {
        v4store.trackV4({
          tokenId: r.tokenIds[i],
          chain: cc.key,
          currency0: pk.currency0,
          currency1: pk.currency1,
          fee: pk.fee,
          tickSpacing: pk.tickSpacing,
          hooks: pk.hooks,
          base: selected.base === 'usdg' ? 'USDG' : 'ETH',
          baseIsCurrency0: selected.baseIsCurrency0!,
          entryBaseWei: legs[i].baseAmountWei.toString(),
          entryEthUsd,
          entryTick,
          entryMcap: entryMcap ?? undefined,
          groupId,
          legIndex: i,
          legCount: r.tokenIds.length,
          shape: 'bidask',
        });
      }
      invalidateV4ListCache(); // posisi baru → /positions harus segar
      await ctx.editMessageText(msg.msgLadderOpened(r.tokenIds.length, legs.length, `${selected.baseSymbol} / ${selected.otherSymbol}`, ethAmount), html);
    } catch (err) {
      console.error('[open v4 ladder] gagal:', (err as Error).message.slice(0, 200));
      await recoverStrayWeth(getChain(chain), 'add v4 ladder').catch(() => {});
      await ctx.reply(msg.msgError('add v4 ladder', (err as Error).message), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  // --- Jalur v4 (buka posisi single-sided ETH di pool v4) ---
  if (flow?.selected?.protocol === 'v4') {
    if (!flow.ethAmount || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
    const { selected, ethAmount, chain, rangePct } = flow;
    flows.delete(ctx.from!.id); // idempotency: double-tap tak buka dobel
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    try {
      await ctx.editMessageText(msg.msgOpeningLp(), html);
      const cc = getChain(chain);
      const pk = selected.poolKey!;
      const base = baseOf(cc, selected.base); // 'weth'→ETH-native / 'usdg'→USDG
      const amountWei = ethers.parseUnits(ethAmount, base.decimals);
      const widthSpacings = rangePctToSpacings(rangePct, pk.tickSpacing);
      // Probe = jumlah NFT posisi v4 (lihat retryOnce): mint mendarat → tak diulang.
      const r = await retryOnce(
        'add v4',
        () => v4PositionCount(cc),
        () => openPositionV4(cc, pk, selected.baseIsCurrency0!, amountWei, { widthSpacings, dryRun: false }),
        { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
      );
      if (r.tokenId) {
        const tokenAddr = r.baseIsCurrency0 ? pk.currency1 : pk.currency0;
        const [entryTick, entryMcap] = await Promise.all([
          currentTickV4(cc, pk).catch(() => undefined),
          explore.tokenMarketCap(cc, tokenAddr).catch(() => null),
        ]);
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
          entryEthUsd:
            selected.base === 'usdg'
              ? 1
              : (await getEthUsd(cc.wethAddress, cc).catch(() => null)) ?? undefined,
          entryTick,
          entryMcap: entryMcap ?? undefined,
        });
      }
      invalidateV4ListCache();
      await ctx.editMessageText(
        msg.msgV4Added({
          tokenId: r.tokenId,
          sizeEth: `${ethAmount} ${base.symbol}`,
          rangeLabel: `single-sided ${base.symbol} · range ~${rangePct}%`,
          txHash: r.txHash,
          dryRun: false,
        }),
        html,
      );
    } catch (err) {
      await recoverStrayWeth(getChain(chain), 'add v4').catch(() => {});
      await ctx.reply(msg.msgError('add v4', (err as Error).message), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  // --- Jalur LADDER Bid-Ask (v3, sisi base): mint N leg berbagi groupId ---
  if (flow?.shape === 'bidask' && (flow.legs ?? 1) > 1 && flow.strategy === 'base') {
    if (flow.fee === undefined || !flow.ethAmount || flow.rangePct === undefined)
      return ctx.answerCbQuery('Expired — start again with /add_lp.');
    flows.delete(ctx.from!.id);
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    const groupId = `L${Date.now()}`;
    const opened: string[] = [];
    try {
      const ccAdd = wizardCtx(flow);
      const base = baseOf(ccAdd, flow.base ?? 'weth');
      // Plan segar tepat sebelum mint (tick tak basi). Metadata entry dihitung sekali.
      const legPlans = await planLadderSingleSided(flow.token, flow.fee, flow.ethAmount, flow.rangePct, flow.legs!, 'bidask', base, ccAdd);
      const entryMcap = (await explore.tokenMarketCap(ccAdd, flow.token).catch(() => null)) ?? undefined;
      const entryEthUsd = isStableBase(base.kind) ? 1 : ((await getEthUsd(ccAdd.wethAddress, ccAdd).catch(() => null)) ?? undefined);
      const usable = legPlans.filter((lp) => lp.baseAmountWei > 0n); // buang leg debu (pembulatan)
      // Base WETH wrappable disetor dari native → butuh native = deposit + gas; base
      // stable → native cuma buat gas. ensureBaseReady di executeAddBatch urus wrap,
      // tapi cek dulu supaya gagalnya ramah ("top up ETH"), bukan revert mentah.
      await ensureGasForLegs(ccAdd, usable.length, base.wrappable ? usable.reduce((s, lp) => s + lp.baseAmountWei, 0n) : 0n);
      await ctx.editMessageText(msg.msgProgress(`opening ${usable.length}-leg ladder (batched)…`), html);
      // BATCH multicall: semua leg dalam ~1 tx atomik per chunk (tutup kelemahan N-tx).
      const { tokenIds } = await executeAddBatch(usable, flow.token, flow.fee, ccAdd);
      for (let i = 0; i < tokenIds.length; i++) {
        const lp = usable[i];
        store.add({
          tokenId: tokenIds[i],
          chain: flow.chain,
          venue: flow.selected?.venue,
          ca: flow.token,
          fee: flow.fee,
          symbol: lp.otherSymbol,
          baseKind: lp.baseKind,
          initialWethWei: lp.baseAmountWei.toString(),
          side: 'base',
          rangeLowPct: lp.pctLow,
          rangeHighPct: lp.pctHigh,
          entryPrice: lp.currentPrice,
          entryMcap,
          entryEthUsd,
          groupId,
          legIndex: i,
          legCount: tokenIds.length,
          shape: 'bidask',
          openedAt: Date.now(),
          status: 'ACTIVE',
          lastInRange: false,
        });
        opened.push(tokenIds[i]);
      }
      await ctx.editMessageText(msg.msgLadderOpened(opened.length, usable.length, `${legPlans[0].baseSymbol} / ${legPlans[0].otherSymbol}`, flow.ethAmount), html);
      const first = opened[0] ? store.get(opened[0]) : undefined;
      if (first) await renderPositionCard(ctx, first, false).catch(() => {});
    } catch (err) {
      console.error('[open ladder] gagal:', (err as Error).message.slice(0, 200));
      await recoverStrayWeth(getChain(flow.chain), 'add ladder').catch(() => {});
      const note = opened.length ? ` (${opened.length} leg(s) already opened and saved)` : '';
      await ctx.reply(msg.msgError('add ladder', (err as Error).message + note), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  if (!flow?.plan || flow.fee === undefined || !flow.ethAmount || flow.rangePct === undefined)
    return ctx.answerCbQuery('Expired — start again with /add_lp.');
  // Idempotency: hapus flow SEBELUM eksekusi (sinkron, sebelum await pertama) →
  // double-tap tombol Konfirmasi tak bisa membuka posisi dobel (dobel ETH).
  // Gagal open → flow sudah hilang, user ulangi /add (aman).
  flows.delete(ctx.from!.id);
  await ctx.answerCbQuery('Processing…');
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
    // Pool bisa berasal dari DEX non-bawaan chain (mis. Uniswap v3 di BSC) — kontrak
    // yang dipakai HARUS milik venue-nya, bukan cc.factory chain.
    const ccAdd = wizardCtx(flow);
    // Sisi setoran HARUS sama dengan yang dipilih di langkah strategi. Selalu
    // memakai planAddSingleSided di sini membuat pilihan "sisi token" berubah jadi
    // setoran base saat dikonfirmasi — nominal token dibaca sbg nominal ETH.
    const args = [flow.token, flow.fee, flow.ethAmount, flow.rangePct, baseOf(ccAdd, flow.base ?? 'weth'), ccAdd] as const;
    // Probe = jumlah NFT posisi. Mint yang sudah mendarat menaikkannya → JANGAN diulang
    // (posisi dobel = modal dobel). Wrap ETH→WETH tak menaikkannya, jadi kegagalan
    // sesudah wrap tetap boleh diulang — dan percobaan kedua memakai WETH yang sudah
    // jadi, tanpa perlu unwrap manual dulu.
    const { tokenId, notes, plan } = await retryOnce(
      'add',
      () => ccAdd.positionManager.balanceOf(ccAdd.wallet.address) as Promise<bigint>,
      async () => {
        // re-plan tiap percobaan: tick & harga dihitung ulang, jangan pakai yang basi.
        const p2 = await (flow.strategy === 'token'
          ? planAddTokenSide(...args)
          : planAddSingleSided(...args));
        return { ...(await executeAdd(p2, flow.token!, flow.fee!, ccAdd)), plan: p2 };
      },
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    store.add({
      tokenId,
      chain: flow.chain,
      venue: flow.selected?.venue,
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
      // Market cap saat buka — batas mcap kartu dipatok ke sini supaya diam (tak
      // bergoyang karena mcNow DexScreener & harga on-chain dari sumber berbeda).
      entryMcap: (await explore.tokenMarketCap(ccAdd, flow.token!).catch(() => null)) ?? undefined,
      // Harga base(USD) saat buka → PnL USD ala LP Agent dipatok ke sini. Stable = 1.
      entryEthUsd: isStableBase(plan.baseKind)
        ? 1
        : (await getEthUsd(ccAdd.wethAddress, ccAdd).catch(() => null)) ?? undefined,
      openedAt: Date.now(),
      status: 'ACTIVE',
      lastInRange: false,
    });
    console.log(`[open] #${tokenId}:`, notes.join(' | ')); // pasangan [cashout] — tanpa ini buka posisi tak berjejak
    // Ringkas OPENED di bubble yang sama, lalu kartu posisi live.
    // priceLower/Upper mengikuti urutan TICK; dalam satuan harga bisa terbalik,
    // dan rentang yang tercetak mundur membuat kartu ini tampak salah hitung.
    const [pLo, pHi] =
      Number(plan.priceLower) <= Number(plan.priceUpper)
        ? [plan.priceLower, plan.priceUpper]
        : [plan.priceUpper, plan.priceLower];
    await ctx.editMessageText(
      msg.msgLpOpened(tokenId, notes, `${plan.baseSymbol} / ${plan.otherSymbol}`, `${pLo} — ${pHi}`),
      html,
    );
    const rec = store.get(tokenId);
    if (rec) {
      try {
        await renderPositionCard(ctx, rec, false);
      } catch (e) {
        await ctx.reply(msg.msgPositionReadFail(tokenId, (e as Error).message), html);
      }
    }
  } catch (err) {
    // Add gagal setelah wrap menyisakan WETH — dirapikan di sini supaya tak perlu
    // /unwrap manual sebelum mencoba /add_lp lagi.
    console.error('[open] gagal:', (err as Error).message.slice(0, 200));
    await recoverStrayWeth(getChain(flow.chain), 'add').catch(() => {});
    await ctx.reply(msg.msgError('add', (err as Error).message), html);
  } finally {
    store.endMoneyOp();
  }
});

/** Konfirmasi tutup posisi (kartu). Eksekusi: remove + collect + cash-out ETH via Relay. */
async function renderStopConfirm(ctx: any, tokenId: string, edit: boolean) {
  const rec = store.get(tokenId);
  const cc = rec ? ctxOf(rec) : getChain();
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
      [Markup.button.callback('⛔ Close Position', `close:${tokenId}`)],
      [
        Markup.button.callback('⬅️ Back', `back:card:${tokenId}`),
        Markup.button.callback('❌ Cancel', 'cancel'),
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

// /stop — tutup posisi: kartu per posisi (v3 + v4), konfirmasi masing-masing.
// Dulu terpisah dari /closeall; keduanya melakukan hal yang sama, bedanya cuma
// /closeall ikut menampilkan posisi v4 — jadi yang tersisa versi lengkapnya.
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
    const c = await buildV4Card(p, ethUsd, cc);
    await ctx.reply(c.text, c.extra);
  }
}
bot.command('stop', cmdCloseAll);

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
  quotedAt?: number;      // kapan angka di kartu Preview dihitung (TTL konfirmasi)
  quotedOutWei?: bigint;  // hasil yang DILIHAT user — jadi lantai minOut saat eksekusi
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
  // Pintasan stablecoin base di SEMUA chain aktif: alamatnya sudah kita ketahui,
  // jadi memaksa user menempel CA-nya sendiri hanya menambah langkah & risiko salah tempel.
  const quick: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const c of Object.values(CHAINS)) {
    for (const b of basesFor(c)) {
      if (!isStableBase(b.kind)) continue;
      quick.push([Markup.button.callback(`💵 Buy ${b.symbol} · ${c.label}`, `bca:${b.address}`)]);
    }
  }
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([...quick, [Markup.button.callback('❌ Cancel', 'cancel')]]),
  };
  const text = msg.msgBuyAskCA(
    config.safety.dryRun,
    Object.values(CHAINS).flatMap((c) =>
      basesFor(c)
        .filter((b) => isStableBase(b.kind))
        .map((b) => ({ symbol: b.symbol, chain: c.label, ca: b.address })),
    ),
  );
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Pintasan: CA dibawa DI callback (bukan state) → tombol lama tetap benar.
bot.action(/^bca:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  return buyStartFromCA(ctx, ctx.match[1], prog);
});

// Chain kandidat = tempat token ADA ∩ chain yg didukung swap (robinhood/stable).
async function buyDetectChains(ca: string): Promise<ChainCtx[]> {
  const swapKeys = new Set(swapTokenChains().map((c) => c.key));
  return (await detectChains(ca)).filter((c) => swapKeys.has(c.key));
}

// Langkah 1: pilih chain (hanya bila token ada di >1 chain didukung).
function buyChainStep(ctx: any, flow: TSwapFlow, keys: string[], edit: boolean) {
  flow.chainOptions = keys;
  const rows = keys.map((k) => [Markup.button.callback(CHAINS[k]!.label, `buychain:${k}`)]);
  rows.push([Markup.button.callback('⬅️ Back', 'buyback:ca'), Markup.button.callback('❌ Cancel', 'cancel')]);
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
      return editProgress(ctx, prog, msg.msgError('buy', 'Could not read token decimals — aborted (amounts could be off by 10^12).'));
    }
  }
  if (flow.screenText === undefined) {
    prog = await editProgress(ctx, prog, msg.msgProgress(`auditing token on ${cc.label}…`));
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
      [Markup.button.callback('🟢 Continue', 'buy:go')],
      [Markup.button.callback('⬅️ Back', back), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  const text = `${flow.screenText}\n\n${msg.msgBuySafetyHint(flow.tokenSym ?? '?')}`;
  if (prog) return editProgress(ctx, prog, text, extra);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Langkah 3: pilih aset bayar (ETH/USDG). Stable → auto USDT, langsung ke size.
function buyBaseStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  const cc = CHAINS[flow.chainKey]!;
  // Membeli USDT dengan USDT bukan pilihan — buang dari daftar aset bayar.
  const bases = basesFor(cc).filter((b) => b.address.toLowerCase() !== (flow.token ?? '').toLowerCase());
  if (bases.length <= 1) {
    flow.base = bases[0];
    return buySizeStep(ctx, flow, edit);
  }
  const row = bases.map((b) => Markup.button.callback(b.symbol, `buybase:${b.kind}`));
  const back = flow.fromHub ? 'hub:back' : 'buyback:safety';
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([row, [Markup.button.callback('⬅️ Back', back), Markup.button.callback('❌ Cancel', 'cancel')]]),
  };
  const text = msg.msgTSwapBase(cc.label, true);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Langkah 4: pilih size (preset /size aset terpilih + ketik nominal). Preview back → size.
/**
 * Saldo base yang BENAR-BENAR bisa dibelanjakan di /buy.
 *
 * Base wrappable dibiayai native, dan native juga yang membayar gas — 100% dari
 * saldo mentah berarti wrap sukses lalu swap gagal "insufficient funds for gas".
 * Cadangan gas dipotong lebih dulu, sama seperti tombol persen di wizard /add.
 */
async function buyUsableWei(flow: TSwapFlow): Promise<bigint> {
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  if (!base.wrappable) {
    return (await new ethers.Contract(base.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address)) as bigint;
  }
  const [bal, buf] = await Promise.all([cc.provider.getBalance(cc.wallet.address), gasBuffer(cc)]);
  return bal > buf ? bal - buf : 0n;
}

async function buySizeStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  flow.awaitingAmount = true;
  flow.previewBack = 'buyback:size'; // Kembali dari Preview → balik ke size
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  let balLine = '';
  try {
    if (base.wrappable) {
      // Yang membiayai = NATIVE chain itu (bot mem-wrap sendiri). Simbolnya WAJIB
      // ikut chain: menulis 'ETH' saat berada di BSC menyebut aset yang tak pernah
      // dipegang, dan angkanya jadi terbaca sebagai saldo chain yang salah.
      const b = await cc.provider.getBalance(cc.wallet.address);
      balLine = msg.note(`balance: ${Number(ethers.formatEther(b)).toFixed(5)} ${cc.nativeSymbol}`);
    } else {
      const bc = new ethers.Contract(base.address, ERC20_ABI, cc.provider);
      const b: bigint = await bc.balanceOf(cc.wallet.address);
      balLine = msg.note(`balance: ${Number(ethers.formatUnits(b, base.decimals)).toFixed(2)} ${base.symbol}`);
    }
  } catch {
    /* saldo opsional */
  }
  // Nominal boleh diketik di chat (flow.awaitingAmount) ATAU dipilih sebagai
  // persentase saldo — sejajar dengan /sell dan wizard /add, yang sudah punya
  // tombol persen. "Custom %" untuk angka di luar preset.
  const rows: any[] = [];
  rows.push(...pctPresets.chunkButtons(pctPresets.get('buy').map((p) => Markup.button.callback(`${p}%`, `buypct:${p}`))));
  const multiBase = basesFor(cc).length > 1;
  const backSize = multiBase ? 'buyback:base' : flow.fromHub ? 'hub:back' : 'buyback:safety';
  rows.push([Markup.button.callback('⬅️ Back', backSize), Markup.button.callback('❌ Cancel', 'cancel')]);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgTSwapAmountPrompt(true, base.wrappable ? cc.nativeSymbol : base.symbol, balLine);
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
  prog = await editProgress(ctx, prog, msg.msgProgress(`auditing token on ${cc.label}…`));

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
    return editProgress(ctx, prog, msg.msgError('token', 'Could not read token decimals — aborted (amounts could be off by 10^12).'));
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
      ? `liquidity ${msg.usdCompact(sc.liquidityUsd)}${sc.pairAgeHours != null ? ` · pool ${Math.round(sc.pairAgeHours)}h old` : ''}`
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
    // Kartu ini statis: harganya beku di detik kamu menempel CA. Untuk token yang
    // baru lahir, satu menit sudah jauh — jadi sediakan cara memperbaruinya di tempat.
    [Markup.button.callback('🔄 Refresh', `ca:refresh:${ca}`), Markup.button.callback('❌ Cancel', 'cancel')],
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
bot.action(/^ca:refresh:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const ca = ethers.getAddress(ctx.match[1]);
  const h = hubs.get(ctx.from!.id);
  if (!h || h.ca.toLowerCase() !== ca.toLowerCase()) return ctx.answerCbQuery('Expired — paste the CA again.');
  await ctx.answerCbQuery('Refreshing…');
  // Cache 60 detik dibuang dulu; kalau tidak, tombol ini cuma menggambar ulang
  // angka yang sama dan terasa seperti tak bekerja.
  bustScreenCache(ca);
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  return renderTokenHub(ctx, ca, h.chainKey, prog);
});

bot.action(/^ca:(add|buy|close|sell):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const [, what, ca] = ctx.match as unknown as [string, 'add' | 'buy' | 'close' | 'sell', string];
  const h = hubs.get(ctx.from!.id);
  if (!h || h.ca.toLowerCase() !== ca.toLowerCase()) return ctx.answerCbQuery('Expired — paste the CA again.');
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
      msg.msgError(what === 'buy' ? 'buy' : 'sell', `${cc.label} has no bot swap route — only Add LP / Close LP are available there.`),
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
    if (bal <= 0n) return ctx.editMessageText(msg.msgError('sell', 'Balance is 0 — nothing to sell.'), html);
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
        [Markup.button.callback('⛔ Close v4 Position', `closev4go:${v4[0]}`)],
        [Markup.button.callback('⬅️ Back', 'hub:back'), Markup.button.callback('❌ Cancel', 'cancel')],
      ]),
    });
  }
  if (v3.length + v4.length === 0) {
    return ctx.editMessageText(msg.msgError('close', 'No active LP position for this token.'), html);
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
        const c = await buildV4Card(p, ethUsd, cc);
        await ctx.reply(c.text, c.extra);
      }
    }
  }
});

/** Pintu masuk hub dari CA telanjang: deteksi chain dulu (pemilih bila >1). */
async function startTokenHub(ctx: any, ca: string) {
  resetFlows(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
  const found = await detectChains(ca);
  if (found.length === 0) {
    return editProgress(
      ctx,
      prog,
      msg.msgError('token', `Token not found on any chain (${Object.values(CHAINS).map((c) => c.label).join('/')}).`),
    );
  }
  if (found.length === 1) return renderTokenHub(ctx, ca, found[0].key, { message_id: prog.message_id });
  return editProgress(ctx, prog, msg.msgChainPick(), {
    ...html,
    ...Markup.inlineKeyboard([
      ...found.map((c) => [Markup.button.callback(c.label, `hubchn:${c.key}:${ca}`)]),
      [Markup.button.callback('❌ Cancel', 'cancel')],
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
  if (!h) return ctx.answerCbQuery('Expired — paste the CA again.');
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
  prog = await editProgress(ctx, prog, msg.msgProgress('detecting chain…'));
  const found = await buyDetectChains(ca);
  if (found.length === 0) {
    return editProgress(ctx, prog, msg.msgError('buy', 'Token not found on any chain supported by /buy.'));
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
  const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
  return buyStartFromCA(ctx, ca, { message_id: prog.message_id });
}
bot.command('buy', cmdBuy);

bot.action(/^buychain:(\w+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  if (!CHAINS[ctx.match[1]]) return ctx.answerCbQuery('Chain unavailable.');
  flow.chainKey = ctx.match[1];
  flow.screenText = undefined; // ganti chain → screening ulang
  await ctx.answerCbQuery();
  await buySafetyStep(ctx, flow, null, true);
});

bot.action('buy:go', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buyBaseStep(ctx, flow, true);
});

bot.action(/^buybase:(weth|usdg|usdt)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  flow.base = baseOf(CHAINS[flow.chainKey]!, ctx.match[1] as BaseKind);
  await ctx.answerCbQuery();
  await buySizeStep(ctx, flow, true);
});

// Tombol Kembali /buy.
bot.action('buyback:ca', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow) return ctx.answerCbQuery('Expired — start again with /buy.');
  flow.awaitingCA = true;
  flow.screenText = undefined;
  await ctx.answerCbQuery();
  await buyAskCA(ctx, true);
});
bot.action('buyback:chain', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.chainOptions?.length) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buyChainStep(ctx, flow, flow.chainOptions, true);
});
bot.action('buyback:safety', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buySafetyStep(ctx, flow, null, true);
});
bot.action('buyback:base', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buyBaseStep(ctx, flow, true);
});
/** Persen saldo → nominal beli. Sumbernya saldo yang BISA DIPAKAI (gas sudah disisihkan). */
bot.action(/^buypct:(\d+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.base || !flow.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  const sym = base.wrappable ? cc.nativeSymbol : base.symbol;
  void sym;
  await ctx.answerCbQuery();
  return buyFromPct(ctx, flow, Number(ctx.match[1]));
});

/** Jalur bersama tombol preset & "Custom %" di /buy. */
async function buyFromPct(ctx: any, flow: TSwapFlow, pct: number): Promise<unknown> {
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  const sym = base.wrappable ? cc.nativeSymbol : base.symbol;
  const usable = await buyUsableWei(flow).catch(() => 0n);
  const amountWei = pct >= 100 ? usable : (usable * BigInt(pct)) / 100n;
  if (amountWei <= 0n) {
    return ctx.reply(msg.msgError('buy', `No spendable ${sym} left after the gas reserve.`), html);
  }
  const label = `${Number(ethers.formatUnits(amountWei, base.decimals)).toLocaleString('en-US', { maximumFractionDigits: base.decimals >= 18 ? 6 : 2 })} ${sym} (${pct}%)`;
  return tswapQuoteConfirm(ctx, flow, cc, base.address, flow.token!, amountWei, label);
}

bot.action('buyback:size', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.base || !flow.token) return ctx.answerCbQuery('Expired — start again with /buy.');
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
  // Hanya wrapped-native yang dilewati (itu urusan /unwrap, bukan swap).
  // Stablecoin base (USDT/USDG) SENGAJA ikut: mengubahnya kembali ke native adalah
  // hal yang wajar diminta, dan tanpa ini USDT di BSC tak punya jalan keluar.
  const skip = new Set<string>([cc.wethAddress.toLowerCase()]);
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
    await addStableBases(cc, out);
    await addNativeHolding(cc, out);
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
  await addStableBases(cc, out);
  await addNativeHolding(cc, out);
  return out.slice(0, SELL_HOLDINGS_CAP);
}

/** Sisa native yang WAJIB ditinggal untuk gas — menjual habis = tx-nya sendiri gagal. */
const NATIVE_SELL_RESERVE = ethers.parseEther('0.0005');

/**
 * Saldo NATIVE (ETH/BNB) sebagai kandidat jual → stablecoin. Dicatat dengan alamat
 * wrapped-native: jalur eksekusi mem-wrap seperlunya sebelum swap, dan sisi
 * penerima otomatis jatuh ke stablecoin (base yang sama dgn token dibuang).
 */
async function addNativeHolding(cc: ChainCtx, out: SellHolding[]): Promise<void> {
  if (!cc.hasWethBase) return;
  if (!basesFor(cc).some((b) => isStableBase(b.kind))) return; // tak ada tujuan jual
  try {
    const raw: bigint = await cc.provider.getBalance(cc.wallet.address);
    const sellable = raw > NATIVE_SELL_RESERVE ? raw - NATIVE_SELL_RESERVE : 0n;
    if (sellable <= 0n) return;
    const amountNum = Number(ethers.formatEther(sellable));
    const px = await getEthUsd(cc.wethAddress, cc).catch(() => null);
    out.push({
      ca: ethers.getAddress(cc.wethAddress),
      symbol: cc.nativeSymbol,
      dec: 18,
      balWei: sellable,
      amountNum,
      usd: px !== null ? amountNum * px : null,
    });
  } catch {
    /* saldo native tak terbaca → lewati */
  }
}

/** Saldo stablecoin base chain ini (USDT/USDG) sebagai kandidat jual. */
async function addStableBases(cc: ChainCtx, out: SellHolding[]): Promise<void> {
  // Butuh lawan native: tanpa itu tak ada tujuan swap yang masuk akal.
  if (!cc.hasWethBase) return;
  for (const b of basesFor(cc)) {
    if (!isStableBase(b.kind)) continue;
    if (out.some((h) => h.ca.toLowerCase() === b.address.toLowerCase())) continue;
    try {
      const erc = new ethers.Contract(b.address, ERC20_ABI, cc.provider);
      const balWei: bigint = await erc.balanceOf(cc.wallet.address);
      if (balWei <= 0n) continue;
      const amountNum = Number(ethers.formatUnits(balWei, b.decimals));
      out.push({ ca: ethers.getAddress(b.address), symbol: b.symbol, dec: b.decimals, balWei, amountNum, usd: amountNum });
    } catch {
      /* lewati bila tak terbaca */
    }
  }
}

const fmt4 = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
function sellListKb(list: SellHolding[], showChain = false) {
  const rows = list.map((h, i) => [Markup.button.callback(
    `${h.symbol} · ${fmt4(h.amountNum)}${h.usd ? ` · $${h.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : ''}` +
      (showChain && h.chainKey ? ` @${CHAINS[h.chainKey]?.label ?? h.chainKey}` : ''),
    `sellpick:${i}`,
  )]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}

// Langkah 2: pilih % / jumlah.
function sellAmountStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  flow.awaitingAmount = true;
  flow.previewBack = 'sellback:amount'; // Kembali dari Preview → step %/jumlah
  // Masuk dari hub = tak ada daftar holdings untuk dituju; pulangkan ke kartu token.
  const back = flow.sellList ? 'sellback:list' : flow.fromHub ? 'hub:back' : 'cancel';
  const rows = [
    ...pctPresets.chunkButtons(pctPresets.get('sell').map((p) => Markup.button.callback(`${p}%`, `sellpct:${p}`))),
    [Markup.button.callback('Type an amount', 'sellpct:custom')],
    [Markup.button.callback('⬅️ Back', back), Markup.button.callback('❌ Cancel', 'cancel')],
  ];
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgSellAmount(flow.tokenSym!, `${fmt4(flow.tokenBalNum!)} ${flow.tokenSym}`);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

/**
 * Kartu Preview jual. Hasil akhir SELALU ETH — permintaan pemilik 2 Agu 2026.
 *
 * Dulu di sini ada pemilihan base otomatis: ETH/USDG/USDT dibandingkan nilai USD-nya
 * lalu yang tertinggi dipakai. Akibatnya /sell kadang mendarat di stablecoin tanpa
 * diminta, dan PnL jadi tercampur dua denominasi. Sekarang tak ada pilihan sama sekali.
 *
 * Token yang likuiditasnya hanya di pool USDG tetap terlayani: swapTokenToEthRobust
 * punya rute 2-hop token→USDG→ETH di dalamnya. Jadi "selalu ETH" tak mempersempit
 * apa yang bisa dijual, hanya memastikan di mana berakhirnya.
 */
async function sellPreview(ctx: any, flow: TSwapFlow, amountWei: bigint, amtLabel: string) {
  const cc = CHAINS[flow.chainKey]!;
  const prog = await ctx.reply(msg.msgProgress('finding the best sell route…'), html);
  // Saldo NATIVE ikut daftar jual, dan dicatat memakai alamat wrapped-native. Kalau
  // tujuannya juga native, from == to — swap ke dirinya sendiri, yang selalu balik
  // sebagai "No route (thin pool/liquidity)". Menjual native berarti menjualnya ke
  // STABLECOIN; itu pula yang dimaksud addNativeHolding ("tak ada tujuan jual" bila
  // chain-nya tak punya stablecoin base).
  const sellingNative = flow.token!.toLowerCase() === cc.wethAddress.toLowerCase();
  const dest = sellingNative
    ? basesFor(cc).find((b) => isStableBase(b.kind))
    : basesFor(cc).find((b) => b.wrappable);
  if (!dest) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(
      ctx,
      prog,
      msg.msgError('sell', sellingNative
        ? `${cc.label} has no stablecoin to sell ${cc.nativeSymbol} into.`
        : `${cc.label} has no native base to sell into.`),
    );
  }
  flow.base = dest;
  await tswapQuoteConfirm(ctx, flow, cc, flow.token!, dest.address, amountWei, amtLabel, { message_id: prog.message_id });
}

async function cmdSell(ctx: any) {
  resetFlows(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('reading your holdings…'), html);
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
// Tombol "💱 Quick Sell" di kartu /status.
bot.action('sell:start', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdSell(ctx);
});

bot.action(/^sellpick:(\d+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.sellList) return ctx.answerCbQuery('Expired — start again with /sell.');
  const h = flow.sellList[Number(ctx.match[1])];
  if (h?.chainKey) flow.chainKey = h.chainKey; // eksekusi WAJIB di chain token itu
  if (!h) return ctx.answerCbQuery('Invalid choice.');
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
  if (!flow?.token || flow.tokenBalWei === undefined) return ctx.answerCbQuery('Expired — start again with /sell.');
  if (ctx.match[1] === 'custom') {
    await ctx.answerCbQuery();
    return ctx.editMessageText(msg.msgSellTypeAmount(flow.tokenSym!), {
      ...html,
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'sellback:amount')]]),
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
  if (!flow?.sellList) return ctx.answerCbQuery('Expired — start again with /sell.');
  flow.awaitingAmount = false;
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgSellList(flow.sellList.length), {
    ...html,
    ...sellListKb(flow.sellList, !!flow.sellMultiChain),
  });
});
bot.action('sellback:amount', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /sell.');
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
  const prog = prog0 ?? (await ctx.reply(msg.msgProgress('requesting the best-route quote…'), html));
  // Batas per-tx dulu hanya ditegakkan di wizard /add — preset & ketik-nominal
  // /buy lolos begitu saja. Sekarang KEDUA denominasi dijaga, masing-masing
  // dengan batasnya sendiri (konsisten dengan amountCtx).
  {
    const stable = isStableBase(base.kind);
    const cap = stable ? maxStable : maxEth;
    const spend = Number(ethers.formatUnits(amountWei, base.decimals));
    if (spend > cap) {
      tswapFlows.delete(ctx.from!.id);
      return editProgress(
        ctx,
        prog,
        msg.msgError('swap', `Above the ${capLabelFor(cap, base.symbol)}/tx limit — lower the amount.`),
      );
    }
  }
  const q = await previewSwapOut(fromAddr, toAddr, amountWei, cc);
  if (!q) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(ctx, prog, msg.msgError('swap', 'No route (thin pool/liquidity). Try a different amount or token.'));
  }
  const outDec = tflow.buy ? tflow.tokenDec! : base.decimals;
  const outSym = tflow.buy ? tflow.tokenSym! : base.symbol;
  const estOutLabel = `${Number(ethers.formatUnits(q.out, outDec)).toLocaleString('en-US', { maximumFractionDigits: outDec >= 18 ? 6 : 2 })} ${outSym}`;
  tflow.amountWei = amountWei;
  tflow.amountInLabel = amountInLabel;
  tflow.outLabel = estOutLabel;
  tflow.route = q.route;
  tflow.quotedAt = Date.now();
  tflow.quotedOutWei = q.out;
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
    ? [[Markup.button.callback('⬅️ Back', tflow.previewBack ?? 'buyback:size'), Markup.button.callback('❌ Cancel', 'cancel')]]
    : [
        [Markup.button.callback(`🟢 Confirm · ${amountInLabel}`, 'tswapok')],
        [Markup.button.callback('⬅️ Back', tflow.previewBack ?? 'buyback:size'), Markup.button.callback('❌ Cancel', 'cancel')],
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

/**
 * Wrap native → wrapped, TAPI sisakan gas.
 *
 * Tanpa sisa ini: ketik nominal mepet saldo → deposit sukses, lalu approve & swap
 * gagal "insufficient funds for gas". Dananya kini WETH, dan /unwrap pun butuh gas
 * yang sudah habis — nyangkut sampai dompet diisi ulang. Lebih baik ditolak di sini.
 */
/** Umur maksimum angka di kartu Preview /buy & /sell (sama dgn /bridge). */
/**
 * Unwrap WETH nyasar → native. Dipanggil setelah add/close gagal separuh jalan, supaya
 * tak perlu /unwrap manual atau menunggu sweep monitor (siklus 1 menit).
 * Aman diulang: saldo 0 → tak ada transaksi sama sekali.
 */
async function recoverStrayWeth(cc: ChainCtx, why: string): Promise<void> {
  if (config.safety.dryRun || !cc.hasWethBase) return;
  const bal: bigint = await cc.weth.balanceOf(cc.wallet.address);
  if (bal === 0n) return;
  const tx = await cc.weth.withdraw(bal);
  await tx.wait();
  console.log(`[recover:${why}] unwrap ${ethers.formatEther(bal)} → ${cc.nativeSymbol} (${cc.key}) tx ${tx.hash}`);
}

const TSWAP_QUOTE_TTL_MS = 120_000;
/** Slippage maksimum untuk /buy & /sell — TAK PERNAH dilampaui, tak ada eskalasi.
 *  Jalur close/sweep sengaja TIDAK memakai ini: di sana gagal = token nyangkut. */
const MAX_SLIP_PCT = 3;

async function wrapWithGasReserve(cc: ChainCtx, wrapWei: bigint): Promise<void> {
  const [nativeBal, buffer] = await Promise.all([
    cc.provider.getBalance(cc.wallet.address),
    gasBuffer(cc),
  ]);
  if (nativeBal < wrapWei + buffer) {
    throw new Error(
      `Not enough ${cc.nativeSymbol} for the swap plus gas: need ~${ethers.formatEther(wrapWei + buffer)}, ` +
        `available ${ethers.formatEther(nativeBal)}. Lower the amount or top up.`,
    );
  }
  const wtx = await cc.weth.deposit({ value: wrapWei });
  await wtx.wait();
}

bot.action('tswapok', async (ctx) => {
  const uid = ctx.from!.id;
  const flow = tswapFlows.get(uid);
  if (!flow || flow.amountWei === undefined || !flow.base || !flow.token) {
    return ctx.answerCbQuery('Expired — start again with /buy or /sell.');
  }
  // Angka di kartu Preview punya umur. Tanpa batas ini, konfirmasi yang ditekan
  // sejam kemudian dieksekusi di harga saat itu — user menyetujui angka lain.
  if (Date.now() - (flow.quotedAt ?? 0) > TSWAP_QUOTE_TTL_MS) {
    tswapFlows.delete(uid);
    await ctx.answerCbQuery('Quote expired.');
    return ctx.reply(
      msg.msgError('swap', 'The quote is older than 2 minutes — run /buy or /sell again for fresh numbers.'),
      html,
    );
  }
  if (tswapInFlight.has(uid)) return ctx.answerCbQuery('Processing…');
  tswapInFlight.add(uid);
  store.beginMoneyOp();
  const { chainKey, buy, base, token, tokenSym, tokenDec, amountWei, amountInLabel } = flow;
  tswapFlows.delete(uid); // idempotency: hapus SEBELUM eksekusi (double-tap tak swap dobel)
  const cc = CHAINS[chainKey]!;
  await ctx.answerCbQuery('Processing…');
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(
        msg.msgTSwapDone({ buy, tokenSym: tokenSym!, amountInLabel: amountInLabel!, outLabel: flow.outLabel ?? '(estimasi)', dryRun: true }),
        html,
      );
      return;
    }
    await ctx.editMessageText(msg.msgProgress('swapping via the best route…'), html);
    // Lantai harga = angka yang BENAR-BENAR dilihat user di kartu Preview, minus 3%.
    // Rute eksekusi punya fallback slippage sampai 15% dan me-re-quote sendiri; tanpa
    // pembanding ini tak ada satu pun yang mengaitkan hasil eksekusi dengan angka yang
    // disetujui. Cek dilakukan SEBELUM tx pertama — batal di sini hanya buang 1 RPC.
    if (flow.quotedOutWei && flow.quotedOutWei > 0n) {
      const [qFrom, qTo] = buy ? [base!.address, token!] : [token!, base!.address];
      const fresh = await previewSwapOut(qFrom, qTo, amountWei, cc).catch(() => null);
      const floor = (flow.quotedOutWei * 97n) / 100n;
      if (fresh && fresh.out < floor) {
        throw new Error(
          `Price moved against you since the preview (quoted ${flow.outLabel}, now ~${Number(
            ethers.formatUnits(fresh.out, buy ? tokenDec! : base!.decimals),
          ).toFixed(6)}). Nothing was swapped — run /${buy ? 'buy' : 'sell'} again.`,
        );
      }
    }
    const attempt = async (): Promise<{ outLabel: string; route: string }> => {
      if (buy) {
        // base → token. Base ETH: wrap seperlunya dulu (Uniswap butuh WETH).
        if (base!.wrappable) {
          const have: bigint = await cc.weth.balanceOf(cc.wallet.address);
          if (have < amountWei) await wrapWithGasReserve(cc, amountWei - have);
        }
        const r = await swapExactInBest(base!.address, token!, amountWei, cc, MAX_SLIP_PCT, MAX_SLIP_PCT);
        return {
          outLabel: `${Number(ethers.formatUnits(r.outWei, tokenDec!)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${tokenSym}`,
          route: r.route,
        };
      }
      // Menjual SALDO NATIVE: daftar jual mencatatnya memakai alamat wrapped-native,
      // tapi dananya masih native — belum pernah di-wrap. Tanpa langkah ini setiap
      // rute mencoba menarik WBNB yang saldonya 0 ("STF", "did not reduce the token
      // balance") lalu menyerah sebagai "All swap routes failed". Tujuannya pun
      // stablecoin, bukan native: menjual native ke native adalah swap ke diri sendiri.
      if (token!.toLowerCase() === cc.wethAddress.toLowerCase()) {
        const have: bigint = await cc.weth.balanceOf(cc.wallet.address);
        if (have < amountWei) await wrapWithGasReserve(cc, amountWei - have);
        const r = await swapTokenToUsdgRobust(token!, amountWei, base!.address, cc, MAX_SLIP_PCT);
        return {
          outLabel: `${Number(ethers.formatUnits(r.outWei, base!.decimals)).toFixed(2)} ${base!.symbol}`,
          route: r.route,
        };
      }
      // JUAL token biasa berakhir di native ETH (permintaan pemilik 2 Agu 2026).
      // Token yang cuma punya pool USDG tetap terlayani lewat rute 2-hop di dalam
      // swapTokenToEthRobust (token→USDG→ETH).
      const r = await swapTokenToEthRobust(token!, amountWei, cc, MAX_SLIP_PCT);
      return { outLabel: `${Number(ethers.formatEther(r.outEthWei)).toFixed(6)} ${cc.nativeSymbol}`, route: r.route };
    };

    // Probe = saldo aset masukan. Berkurang → swap sudah (sebagian) jalan → jangan ulang.
    // Menjual saldo native: yang berkurang adalah NATIVE. Memakai saldo WBNB di sini
    // justru NAIK dari 0 setelah wrap, jadi percobaan yang sudah mendarat terbaca
    // "belum jalan" dan diulang — wrap dobel.
    const sellNative = !buy && token!.toLowerCase() === cc.wethAddress.toLowerCase();
    const inC = new ethers.Contract(buy ? base!.address : token!, ERC20_ABI, cc.provider);
    const probe = sellNative
      ? () => cc.provider.getBalance(cc.wallet.address)
      : () => inC.balanceOf(cc.wallet.address) as Promise<bigint>;
    const { outLabel, route } = await retryOnce(
      'swap',
      probe,
      attempt,
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
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
          [Markup.button.callback('⛔ Force Close', `close:${ctx.match[1]}`)],
          [Markup.button.callback('❌ Cancel', 'cancel')],
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
  feesBaseWei?: bigint,
  shape?: 'spot' | 'bidask',
): Promise<void> {
  if (!rec) return;
  const dec = baseDecimalsOf(rec.chain, rec.baseKind);
  const baseSym = baseSymbolOf(rec.baseKind, ctxOf(rec));
  const baseIn = Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
  const baseOut = Number(ethers.formatUnits(baseOutWei, dec));
  const pnl = baseOut - baseIn;
  const pnlPct = baseIn > 0 ? (pnl / baseIn) * 100 : 0;
  const positive = pnl >= 0;
  // PnL SELALU dalam aset yang dipakai DEPOSIT: deposit USDG dilaporkan dalam
  // USDG, deposit ETH dalam ETH. Dulu semuanya dikali harga hari ini jadi USD —
  // itu memasukkan gerak harga base ke dalam angka yang seharusnya murni hasil
  // LP (deposit 1 ETH balik 1 ETH bisa terbaca "-$120" cuma karena ETH turun),
  // sekaligus tak sebaris dengan baris deposit/received di bawahnya.
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: dec >= 18 ? 5 : 2 });
  const pnlBig = `${positive ? '+' : ''}${fmt(pnl)} ${baseSym}`;
  const buf = await renderProfitCard({
    pair: pairLabel(baseSym, rec.symbol),
    positive,
    pnlBig,
    pnlPct: msg.fmtPct(pnlPct),
    stats: [
      { label: 'deposit', value: `${fmt(baseIn)} ${baseSym}` },
      { label: 'received', value: `${fmt(baseOut)} ${baseSym}` },
      { label: 'held', value: msg.fmtAge(Date.now() - rec.openedAt) },
      // Fee dibaca SEBELUM burn (lihat pemanggil). Tak terbaca → kotak keempat
      // dikosongkan, bukan diisi 0 yang terbaca seperti "tak dapat fee sama sekali".
      ...(feesBaseWei !== undefined && feesBaseWei > 0n
        ? [{ label: 'fees', value: `${fmt(Number(ethers.formatUnits(feesBaseWei, dec)))} ${baseSym}` }]
        : []),
    ],
    footerLeft: `#${tokenId} · ${new Date().toISOString().slice(0, 10)} ${msg.nowWib()}`,
    // Bentuk posisi ikut dari catatan; posisi lama tanpa penanda dianggap SPOT
    // (itu memang perilaku sebelum ladder ada).
    shape: shape ?? rec.shape ?? 'spot',
  });
  // sendDocument, BUKAN sendPhoto: Telegram me-render ulang foto jadi JPEG
  // (terukur 1130 KB -> 185 KB) dan artefaknya paling terlihat pada teks tajam
  // di latar gelap — persis isi kartu ini. Sebagai dokumen, PNG-nya utuh (HD).
  await ctx.replyWithDocument(Input.fromBuffer(buf, `philips-${tokenId}.png`));
}

/**
 * Tutup seluruh leg satu grup ladder secara BATCH: remove+collect+burn semua leg
 * via multicall (~1 tx/chunk), lalu SATU swap token→base agregat. Hasil dibagi
 * proporsional ke tiap leg (sesuai modal) supaya jurnal PnL per-leg tetap benar.
 */
async function closeGroup(ctx: any, groupId: string, legs: store.PosRecord[]) {
  await ctx.answerCbQuery('Closing ladder…');
  if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunClose(groupId), html));
  const cc = ctxOf(legs[0]);
  const tokenIds = legs.map((l) => l.tokenId);
  for (const l of legs) closingInFlight.set(l.tokenId, Date.now());
  store.beginMoneyOp();
  try {
    // Semua leg satu pool → base & token sama. Baca dari leg pertama yang MASIH ada
    // (leg 0 bisa sudah ke-burn duluan → positions() throw; jangan gagalkan close).
    let p: { token0: string; token1: string } | null = null;
    for (const id of tokenIds) {
      try {
        const q = await cc.positionManager.positions(id);
        p = { token0: q.token0, token1: q.token1 };
        break;
      } catch {
        /* leg hangus → coba berikutnya */
      }
    }
    if (!p) throw new Error('All ladder legs already closed on-chain.');
    const base = detectBase(cc, p.token0, p.token1);
    if (!base) throw new Error('This pool is not paired with WETH/USDG/USDT — close manually at app.uniswap.org.');
    const otherAddr = base.address.toLowerCase() === p.token0.toLowerCase() ? p.token1 : p.token0;
    const otherC = new ethers.Contract(otherAddr, ERC20_ABI, cc.wallet);
    const baseC = base.wrappable ? cc.weth : new ethers.Contract(base.address, ERC20_ABI, cc.wallet);
    const baseBefore: bigint = await baseC.balanceOf(cc.wallet.address);
    const otherBefore: bigint = await otherC.balanceOf(cc.wallet.address).catch(() => 0n);

    await ctx.editMessageText(msg.msgProgress(`closing ${legs.length}-leg ladder (batched)…`), html);
    const notes: string[] = [];
    // Fee dibaca SEBELUM burn: sesudahnya ia sudah melebur ke hasil cash-out.
    const feesWei = (
      await Promise.all(
        tokenIds.map((id) => getPositionDetail(id, cc).then((dd) => dd.feesBaseWei).catch(() => 0n)),
      )
    ).reduce((a, b) => a + b, 0n);
    notes.push(...(await executeRemoveBatch(tokenIds, cc)).notes);
    // Tak ada tx penarikan yang terkirim = tak ada yang ditutup. Melanjutkan ke
    // finalisasi akan menandai posisi HIDUP sebagai tertutup lalu menghapusnya dari
    // catatan — persis yang terjadi 28 Agu 2026.
    if (!notes.some((n) => n.startsWith('Batch close ') && n.includes('tx '))) {
      throw new Error(
        'No withdrawal transaction was sent, so nothing was closed. Your positions are untouched — try again.',
      );
    }
    await sleep(1500);
    const sw = await sweepTokenToBase(otherAddr, otherC, base, cc, notes, otherBefore).catch(() => ({
      baseOut: 0n,
      txHashes: [] as string[],
      leftover: true,
      leftoverWei: 0n,
    }));

    let totalOut: bigint;
    if (base.wrappable) {
      // WETH: pokok + hasil swap semuanya mendarat sbg WETH → ukur kenaikan lalu unwrap.
      const wethBal: bigint = await cc.weth.balanceOf(cc.wallet.address).catch(() => 0n);
      totalOut = wethBal > baseBefore ? wethBal - baseBefore : sw.baseOut;
      if (wethBal > 0n) {
        try {
          await (await cc.weth.withdraw(wethBal)).wait();
        } catch (e) {
          console.error(`[unwrap] gagal close ladder ${groupId}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    } else {
      const baseAfter: bigint = await baseC.balanceOf(cc.wallet.address);
      totalOut = baseAfter > baseBefore ? baseAfter - baseBefore : sw.baseOut;
    }

    // Bagi hasil proporsional ke modal tiap leg → jurnal PnL per-leg tetap masuk akal.
    const totalInit = legs.reduce((s, l) => s + BigInt(l.initialWethWei || '0'), 0n);
    let attributed = 0n;
    legs.forEach((l, i) => {
      const share = i === legs.length - 1 ? totalOut - attributed : totalInit > 0n ? (totalOut * BigInt(l.initialWethWei || '0')) / totalInit : 0n;
      attributed += share;
      finalizeClose(l.tokenId, {
        ...(share > 0n ? { resultEthWei: share } : {}),
        reason: 'cashed',
        keep: i === 0 && sw.leftover,
        leftoverWei: i === 0 ? sw.leftoverWei : 0n,
      });
    });

    const baseSym = base.wrappable ? cc.nativeSymbol : base.symbol;
    const outLabel = base.wrappable ? `${msg.fmtEth(totalOut)} ${baseSym}` : `${msg.cleanUnits(totalOut, base.decimals)} ${baseSym}`;
    await ctx.reply(
      `✅ ${msg.bold('LADDER CLOSED')} · ${legs.length} legs\n\nTotal cashed out · ${msg.bold(msg.esc(outLabel))}`,
      { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Other Positions', 'positions')]]) },
    );
    // Kartu PnL untuk SELURUH ladder (lihat catatan yang sama di jalur v4).
    // Hasil 0 = delta saldo tak terukur, BUKAN rugi total: kartunya akan menulis
    // −100% padahal dananya utuh. Lebih baik tak ada kartu daripada kartu bohong.
    if (totalOut > 0n) {
      await sendProfitCard(
      ctx,
      `${legs[0].tokenId} +${legs.length - 1}`,
      { ...legs[0], initialWethWei: totalInit.toString(), openedAt: Math.min(...legs.map((l) => l.openedAt)) },
      totalOut,
      feesWei,
        legs[0].shape ?? 'bidask',
      ).catch((e) => console.log('[profit-card] ladder gagal:', (e as Error).message.slice(0, 120)));
    } else {
      await ctx.reply(msg.note('Result could not be measured, so no PnL card for this close.'), html);
    }
  } catch (err) {
    await recoverStrayWeth(cc, 'close ladder').catch(() => {});
    await ctx.reply(msg.msgError('close ladder', (err as Error).message), html);
  } finally {
    for (const l of legs) closingInFlight.delete(l.tokenId);
    store.endMoneyOp();
  }
}

/** Tutup grup ladder v4 batch (BURN×N + TAKE_PAIR 1 tx) + swap agregat; jurnal per-leg. */
async function closeGroupV4(ctx: any, groupId: string, legs: import('./v4store.js').V4Record[]) {
  await ctx.answerCbQuery('Closing v4 ladder…');
  if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunClose(groupId), html));
  const cc = getChain(legs[0].chain);
  const tokenIds = legs.map((l) => l.tokenId);
  for (const l of legs) closingInFlight.set(`v4:${l.tokenId}`, Date.now());
  store.beginMoneyOp();
  try {
    await ctx.editMessageText(msg.msgProgress(`closing ${legs.length}-leg v4 ladder (batched)…`), html);
    // Fee dibaca SEBELUM burn: sesudahnya ia sudah melebur ke hasil cash-out dan tak
    // bisa dipisah lagi. Gagal baca ≠ gagal close — kartu cuma kehilangan satu kotak.
    const feesWei = (
      await Promise.all(
        tokenIds.map((id) => checkV4Status(cc, id).then((st) => st.val?.feesBaseWei ?? 0n).catch(() => 0n)),
      )
    ).reduce((a, b) => a + b, 0n);
    const r = await closeLadderV4(tokenIds, cc, { dryRun: false });
    // Bagi hasil proporsional ke modal tiap leg → jurnal PnL per-leg benar.
    const totalInit = legs.reduce((s, l) => s + BigInt(l.entryBaseWei || '0'), 0n);
    let attributed = 0n;
    legs.forEach((l, i) => {
      const share = i === legs.length - 1 ? r.baseOutWei - attributed : totalInit > 0n ? (r.baseOutWei * BigInt(l.entryBaseWei || '0')) / totalInit : 0n;
      attributed += share;
      journal.recordClose(
        {
          tokenId: l.tokenId,
          symbol: `${r.sym0}/${r.sym1}`,
          ca: r.other,
          chain: cc.key,
          baseKind: v4Kind(cc, r.base),
          openedAt: l.openedAt,
          initialWethWei: l.entryBaseWei || '0',
        },
        { ...(share > 0n ? { resultEthWei: share } : {}), reason: 'cashed' },
      );
      v4store.removeV4(l.tokenId);
    });
    invalidateV4ListCache();
    const dec = v4BaseDecimals(cc, r.base);
    const sym = v4BaseSymbol(cc, r.base);
    await ctx.reply(
      `✅ ${msg.bold('V4 LADDER CLOSED')} · ${legs.length} legs\n\nTotal cashed out · ${msg.bold(msg.esc(`${msg.cleanUnits(r.baseOutWei, dec)} ${sym}`))}`,
      { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Other Positions', 'positions')]]) },
    );
    // Leg yang terpaksa di-burn tanpa lantai harga harus terlihat, bukan cuma di log.
    if (r.unprotected?.length) await ctx.reply(msg.esc(V4_UNPROTECTED_NOTE(r.unprotected.join(', #'))), html);
    // Kartu PnL untuk SELURUH ladder — yang disetor user memang satu ladder, bukan
    // 8 posisi terpisah. Dulu jalur ladder (v3 & v4) tak pernah mengirim kartu sama
    // sekali; hanya close posisi tunggal yang punya.
    if (r.baseOutWei > 0n) {
      await sendProfitCard(
      ctx,
      `${legs[0].tokenId} +${legs.length - 1}`,
      {
        tokenId: legs[0].tokenId,
        chain: cc.key,
        baseKind: v4Kind(cc, r.base),
        symbol: `${r.sym0}/${r.sym1}`,
        initialWethWei: totalInit.toString(),
        openedAt: Math.min(...legs.map((l) => l.openedAt)),
      } as store.PosRecord,
      r.baseOutWei,
      feesWei,
        legs[0].shape ?? 'bidask',
      ).catch((e) => console.log('[profit-card] v4 ladder gagal:', (e as Error).message.slice(0, 120)));
    } else {
      await ctx.reply(msg.note('Result could not be measured, so no PnL card for this close.'), html);
    }
  } catch (err) {
    await recoverStrayWeth(cc, 'close v4 ladder').catch(() => {});
    await ctx.reply(msg.msgError('close v4 ladder', (err as Error).message), html);
  } finally {
    for (const l of legs) closingInFlight.delete(`v4:${l.tokenId}`);
    store.endMoneyOp();
  }
}

bot.action(/^close:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  const tappedRec = store.get(tokenId);
  // Ladder: menutup satu leg = menutup SELURUH grup (satu posisi logis). Tutup tiap
  // leg berurutan, jumlahkan hasil, tampilkan satu ringkasan.
  if (tappedRec?.groupId) {
    const legs = store.group(tappedRec.groupId).filter((r) => !closeLocked(r.tokenId));
    if (legs.length > 1) return closeGroup(ctx, tappedRec.groupId, legs);
  }
  if (closeLocked(tokenId)) return ctx.answerCbQuery('Processing…');
  closingInFlight.set(tokenId, Date.now());
  const closingRec = store.get(tokenId); // tangkap SEBELUM finalizeClose menghapus
  // Close = remove + collect + swap + unwrap, bisa 1–2 menit. Tanpa penanda ini
  // sweep monitor (tiap 1 menit) boleh jalan di tengahnya dari dompet yang sama:
  // tabrakan nonce, atau WETH milik close ini ikut disapu.
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgDryRunClose(tokenId), html);
      return;
    }
    // WAJIB venue-aware: posisi yang dibuka di Uniswap v3 BSC harus ditutup lewat
    // PositionManager Uniswap. Dengan getChain() saja, PM PancakeSwap yang dipakai
    // dan positions(tokenId) menunjuk posisi ORANG LAIN — detectBase gagal dan close
    // berhenti dengan "pool is not paired with WETH/USDG/USDT".
    const ccClose = closingRec ? ctxOf(closingRec) : getChain();
    const baseSym = isStableBase(closingRec?.baseKind ?? 'weth')
      ? baseSymbolOf(closingRec?.baseKind, ccClose)
      : ccClose.nativeSymbol;
    await ctx.editMessageText(msg.msgClosing(baseSym), html);
    // Probe = likuiditas posisi. Sudah berkurang → decreaseLiquidity/burn mendarat,
    // mengulang dari awal hanya akan revert (dan bisa menjual dua kali). Posisi sudah
    // hangus → pm.positions melempar → probe -1n → juga tak diulang.
    const summary = await retryOnce(
      'close',
      async () => BigInt((await ccClose.positionManager.positions(tokenId)).liquidity),
      () => stopAndCashOut(tokenId, ccClose),
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    // resultEthWei = 0 adalah PLACEHOLDER backfill di jurnal (dikecualikan dari PnL).
    // Hasil yang benar-benar tak terukur harus undefined, bukan 0.
    finalizeClose(tokenId, {
      ...(summary.baseOutWei > 0n ? { resultEthWei: summary.baseOutWei } : {}),
      reason: 'cashed',
      keep: summary.leftover,
      leftoverWei: summary.leftoverWei,
    });
    await ctx.reply(summary.text, {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Other Positions', 'positions')],
        [Markup.button.callback('💧 Open a New LP', 'howto:add')],
      ]),
    });
    await sendProfitCard(ctx, tokenId, closingRec, summary.baseOutWei, summary.feesBaseWei).catch((e) =>
      console.log('[profit-card] failed:', (e as Error).message.slice(0, 120)),
    );
  } catch (err) {
    if (isGoneErr(err)) {
      finalizeClose(tokenId, { reason: 'gone' });
      await ctx.reply(msg.msgAlreadyClosed(tokenId), html);
    } else {
      // Close gagal separuh jalan biasanya menyisakan WETH hasil remove. Dulu itu
      // berarti /unwrap manual (atau menunggu sweep monitor sampai 1 menit). Rapikan
      // di sini juga: withdraw() aman & idempoten — tak ada WETH, tak ada tx.
      await recoverStrayWeth(getChain(closingRec?.chain), 'close').catch(() => {});
      await ctx.reply(msg.msgError('close', (err as Error).message), html);
    }
  } finally {
    closingInFlight.delete(tokenId);
    store.endMoneyOp();
  }
});

/** Remove + collect, lalu swap seluruh aset hasil LP ke ETH (token via Relay, WETH di-unwrap). */
async function stopAndCashOut(
  tokenId: string,
  cc: ChainCtx = getChain(),
): Promise<{ text: string; baseOutWei: bigint; leftover: boolean; leftoverWei: bigint; feesBaseWei?: bigint }> {
  const { positionManager: pm, weth: wethC, wallet: w } = cc;
  const p = await pm.positions(tokenId);
  // Pool tanpa base yang kita kenal (mis. TOKENA/TOKENB hasil impor): tak ada rute
  // cash-out dua sisi. Fallback ke WETH akan membakar posisi lalu salah hitung
  // (unwrap WETH milik operasi lain) dan meninggalkan satu sisi token selamanya.
  // Gagal SEBELUM burn — dana tetap utuh di posisi.
  const base = detectBase(cc, p.token0, p.token1);
  if (!base) {
    throw new Error(
      'This pool is not paired with WETH/USDG/USDT — the bot cannot cash out both sides. Close it manually at app.uniswap.org.',
    );
  }
  const otherAddr = base.address.toLowerCase() === p.token0.toLowerCase() ? p.token1 : p.token0;
  const otherC = new ethers.Contract(otherAddr, ERC20_ABI, w);
  const baseC = base.wrappable ? wethC : new ethers.Contract(base.address, ERC20_ABI, w);
  const baseBefore: bigint = await baseC.balanceOf(w.address);
  // Saldo token SEBELUM burn = bag spot yang mungkin kamu pegang terpisah. Cash-out
  // hanya boleh menjual yang dihasilkan POSISI ini (delta di atas ini), bukan bag-mu.
  const otherBefore: bigint = await otherC.balanceOf(w.address).catch(() => 0n);

  // Fee belum diklaim DIBACA SEBELUM burn: sesudahnya posisi lenyap dan fee sudah
  // melebur ke dalam hasil cash-out, tak bisa dipisah lagi. Gagal baca ≠ gagal
  // close — kartu cuma kehilangan satu kotak.
  const feesBaseWei = await getPositionDetail(tokenId, cc)
    .then((d) => d.feesBaseWei)
    .catch(() => undefined);

  const notes: string[] = [];
  notes.push(...(await executeRemove(tokenId, cc)).notes);
  await sleep(1500); // beri waktu collect settle sebelum baca saldo

  const txHashes: string[] = [];
  // ① Swap token hasil posisi (di atas bag lama) → base, ulang sampai habis (bukan
  //    sekali/delta). Menutup celah: token sisa dari close lama, RPC telat, no-op.
  // NFT sudah di-burn di atas: mulai sini TAK BOLEH melempar, kalau tidak user
  // hanya melihat ERROR mentah & tak tahu posisinya sudah ditarik (PnL pun hilang).
  let sw: { baseOut: bigint; txHashes: string[]; leftover: boolean; leftoverWei: bigint } = {
    baseOut: 0n,
    txHashes: [],
    leftover: true, // default konservatif: anggap masih ada sisa → monitor retry
    leftoverWei: 0n,
  };
  try {
    sw = await sweepTokenToBase(otherAddr, otherC, base, cc, notes, otherBefore);
  } catch (e) {
    notes.push(`Cash-out failed: ${(e as Error).message.slice(0, 120)} — token held, the monitor will retry.`);
  }
  txHashes.push(...sw.txHashes);

  let baseOutWei: bigint;
  if (base.wrappable) {
    // ② WETH: unwrap SELURUH saldo (pokok + hasil swap) → ETH native.
    const wethBal: bigint = await wethC.balanceOf(w.address).catch(() => 0n);

    // Hasil posisi = WETH yang BERTAMBAH selama close ini, diukur SEBELUM unwrap.
    //
    // Dua kesalahan yang dulu ada di sini, dua-duanya membuat kartu PnL bohong:
    //  • memakai seluruh saldo dompet, bukan pertambahannya → WETH sisa operasi lain
    //    (mis. 0,12 yang sempat nyangkut) dihitung sebagai untung posisi ini;
    //  • menghitung dari hasil unwrap, sehingga unwrap yang GAGAL tercatat hasil 0
    //    dan jurnal melaporkan −100% padahal dananya utuh, cuma masih berbentuk WETH.
    // Unwrap itu urusan bentuk (WETH vs ETH), bukan urusan nilai.
    const gainedWeth = wethBal > baseBefore ? wethBal - baseBefore : 0n;
    if (wethBal > gainedWeth) {
      notes.push(
        `Note: ${msg.fmtEth(wethBal - gainedWeth)} WETH was already in the wallet before this close — ` +
          `unwrapped too, but not counted as this position's result.`,
      );
    }

    if (wethBal > 0n) {
      try {
        const tx = await wethC.withdraw(wethBal);
        const rc = await tx.wait();
        if (rc) txHashes.push(rc.hash);
        notes.push(`Unwrap ${msg.fmtEth(wethBal)} WETH → ETH`);
      } catch (e) {
        // Jangan percaya pengecualian soal apa yang mendarat di chain. Pada 2 Agu 2026
        // pesan "Unwrap failed" muncul untuk transaksi yang BERHASIL (blok 25593905,
        // status 1) — kemungkinan wait()/RPC yang gagal, bukan transaksinya. Bacanya
        // jadi salah dua kali: pengguna disuruh /unwrap padahal tak perlu.
        const after: bigint = await wethC.balanceOf(w.address).catch(() => wethBal);
        if (after < wethBal) {
          notes.push(`Unwrap ${msg.fmtEth(wethBal - after)} WETH → ETH (confirmed by balance)`);
        } else {
          console.error(`[unwrap] gagal saat close #${tokenId}: ${(e as Error).message.slice(0, 160)}`);
          notes.push('Unwrap failed — the WETH stays in your wallet (use /unwrap). Your result is unaffected.');
        }
      }
    }
    baseOutWei = gainedWeth + sw.baseOut;
  } else {
    // ② USDG: tetap sbg stablecoin (tak di-unwrap). Total bersih = kenaikan saldo.
    const baseAfter: bigint = await baseC.balanceOf(w.address).catch(() => baseBefore);
    baseOutWei = baseAfter > baseBefore ? baseAfter - baseBefore : sw.baseOut;
    notes.push(`Received ${ethers.formatUnits(baseOutWei, base.decimals)} ${base.symbol} (kept as stablecoin)`);
  }

  if (sw.leftover) {
    notes.push('⚠️ Some tokens are left over — the monitor will retry automatically.');
  }

  const ethOut = base.wrappable
    ? `${msg.fmtEth(baseOutWei)} ETH`
    : `${ethers.formatUnits(baseOutWei, base.decimals)} ${base.symbol}`;
  console.log(`[cashout] #${tokenId}:`, notes.join(' | ')); // rekam ke journal
  const text = msg.msgCashOut({ tokenId, notes, ethOut, txHashes });
  // leftover = token benar-benar masih tersisa di wallet setelah semua percobaan.
  return { text, baseOutWei, leftover: sw.leftover, leftoverWei: sw.leftoverWei, feesBaseWei };
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
    const c = await buildV4Card(p, await getEthUsd(cc.wethAddress, cc).catch(() => null), cc);
    await ctx.editMessageText(c.text, c.extra);
  } catch (e) {
    if (!/not modified/i.test((e as Error).message)) {
      await ctx.reply(msg.msgError('v4 position', (e as Error).message), html);
    }
  }
});

bot.action(/^closev4:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgV4CloseConfirm(tokenId), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⛔ Close v4 Position', `closev4go:${tokenId}`)], // aksi uang: baris sendiri
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

bot.action(/^closev4go:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  // Ladder v4: tutup SELURUH grup dalam 1 tx batch (BURN×N + TAKE_PAIR).
  const trk = v4store.getV4(tokenId);
  if (trk?.groupId) {
    const legs = v4store.groupV4(trk.groupId);
    if (legs.length > 1) return closeGroupV4(ctx, trk.groupId, legs);
  }
  const key = `v4:${tokenId}`;
  if (closeLocked(key)) return ctx.answerCbQuery('Processing…');
  closingInFlight.set(key, Date.now());
  const cc = getChain();
  const tracked = v4store.getV4(tokenId); // tangkap SEBELUM removeV4
  // Base dibaca dari poolKey SEBELUM close (setelah burn, info pool ikut hilang).
  const trackedBase = await getPoolKeyV4(cc, tokenId)
    .then((x) => v4Kind(cc, x.base))
    .catch(() => 'weth' as const);
  // Hasil close diukur dari delta saldo BASE posisi. Base ETH → saldo native; base
  // USDG → saldo token USDG. Dulu `afterWei` dipaksa null untuk non-ETH, sehingga
  // SETIAP close v4 berpasangan USDG tercatat tanpa hasil: hilang dari /pnl dan tak
  // pernah memunculkan profit card. Pool terbaik sering justru yang USDG.
  const readBase = async (): Promise<bigint | null> => {
    if (trackedBase === 'usdg') {
      if (!cc.usdgAddress) return null;
      return (await new ethers.Contract(cc.usdgAddress, ERC20_ABI, cc.provider)
        .balanceOf(cc.wallet.address)
        .catch(() => null)) as bigint | null;
    }
    return cc.provider.getBalance(cc.wallet.address).catch(() => null);
  };
  const beforeWei = await readBase();
  // Alasan sama dengan jalur v3: fee v4 hanya ada selama posisinya masih hidup.
  const feesBaseWei = await checkV4Status(cc, tokenId)
    .then((st) => st.val?.feesBaseWei)
    .catch(() => undefined);
  // Profit card v4: butuh hasil terukur + modal awal. Diisi di cabang jurnal di
  // bawah (satu-satunya tempat keduanya diketahui), dikirim setelah kartu teks.
  let cardRec: store.PosRecord | undefined;
  let cardOutWei: bigint | undefined;
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    await ctx.editMessageText(msg.msgProgress('closing v4 position…'), html).catch(() => {});
    // Probe = likuiditas posisi v4: sudah turun → sebagian close mendarat, jangan ulang.
    const r = await retryOnce(
      'close v4',
      () => v4Liquidity(cc, tokenId),
      () => closePositionV4(tokenId, cc, { dryRun: config.safety.dryRun }),
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    if (!r.dryRun) {
      // Jurnalkan sebelum berhenti melacak — tanpa ini /history & /pnl buta pada v4,
      // dan sisa token v4 tak pernah jadi kandidat sweep (ca hanya ada di jurnal).
      if (r.base === 'ETH' || r.base === 'USDG') {
        const afterWei = await readBase();
        // ponytail: hasil ETH = delta saldo native (ikut memotong gas → PnL konservatif).
        // Ledger presisi baru perlu kalau v4 jadi jalur utama.
        // Base yang diukur harus SAMA dengan base hasil close; kalau tidak, deltanya
        // milik aset lain → lebih baik "tak terukur" daripada angka yang salah.
        const sameBase = trackedBase === v4Kind(cc, r.base);
        const measured =
          sameBase && beforeWei !== null && afterWei !== null && afterWei > beforeWei
            ? afterWei - beforeWei
            : undefined;
        const rec = {
          tokenId,
          symbol: `${r.sym0}/${r.sym1}`,
          ca: r.other,
          chain: cc.key,
          baseKind: v4Kind(cc, r.base),
          openedAt: tracked?.openedAt ?? Date.now(),
          initialWethWei: tracked?.entryBaseWei ?? '0',
        };
        journal.recordClose(rec, { resultEthWei: measured, reason: 'cashed' });
        // Kartu hanya bermakna bila modal DAN hasil sama-sama terukur; posisi v4
        // yang tak ter-track (entry 0) akan memberi PnL +∞ yang menyesatkan.
        if (measured !== undefined && tracked?.entryBaseWei) {
          cardRec = rec as store.PosRecord;
          cardOutWei = measured;
        }
      }
      v4store.removeV4(tokenId); // berhenti dilacak setelah tertutup
      invalidateV4ListCache();
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
    if (r.unprotected) await ctx.reply(msg.esc(V4_UNPROTECTED_NOTE(tokenId)), html);
    if (cardOutWei !== undefined) {
      await sendProfitCard(ctx, tokenId, cardRec, cardOutWei, feesBaseWei, tracked?.shape).catch((e) =>
        console.log('[profit-card] v4 failed:', (e as Error).message.slice(0, 120)),
      );
    } else if (!r.dryRun) {
      // Kartu butuh modal DAN hasil yang sama-sama terukur. Posisi v4 yang tak
      // tercatat bot (dibuka di luar) atau delta saldo yang tak terbaca akan
      // menghasilkan angka karangan — sebut alasannya, jangan diam saja.
      await ctx.reply(msg.note('Result could not be measured, so no PnL card for this close.'), html);
    }
  } catch (e) {
    await recoverStrayWeth(cc, 'close v4').catch(() => {});
    await ctx.reply(msg.msgError('close v4', (e as Error).message), html);
  } finally {
    closingInFlight.delete(key);
    store.endMoneyOp();
  }
});

// Batal berlaku untuk semua alur (wizard /add maupun konfirmasi tutup).
bot.action('cancel', async (ctx) => {
  resetFlows(ctx.from!.id);
  await ctx.answerCbQuery('Cancelled');
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

  // /bridge menunggu nominal — dicek lebih dulu karena state-nya terpisah.
  if (await handleBridgeAmount(ctx, raw)) return;

  // /buy /sell token: menunggu alamat kontrak, lalu jumlah → quote rute terbaik → konfirmasi.
  const tflow = tswapFlows.get(ctx.from.id);
  if (tflow && (tflow.awaitingCA || tflow.awaitingToken || tflow.awaitingAmount) && isStaleFlow(tflow.startedAt)) {
    tswapFlows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  // Jawaban untuk prompt persen di /settings dicek lebih dulu: "25 50 75" harus
  // tersimpan sebagai setelan, bukan terbaca sebagai nominal di alur yang terbuka.
  if (await handlePctReply(ctx, raw)) return;
  // /send: alamat lalu nominal. Diperiksa sebelum alur nominal lain supaya angka
  // yang diketik di sini tak tertelan wizard /add atau /buy yang masih terbuka.
  if (await handleSendAddress(ctx, raw)) return;
  if (await handleSendAmount(ctx, raw)) return;
  if (tflow?.awaitingCA) {
    // /buy alur CA-dulu: user tempel CA → deteksi chain → safety.
    tflow.awaitingCA = false;
    const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
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
      return ctx.reply(msg.msgError('sell', `Amount exceeds your balance (${fmt4(tflow.tokenBalNum ?? 0)} ${tflow.tokenSym}).`), html);
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
        // Base wrappable dibiayai native (ETH/BNB), jadi itu yang disebut di kartu.
        amountInLabel = `${raw} ${base.wrappable ? cc.nativeSymbol : base.symbol}`;
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
          return ctx.reply(msg.msgError('swap', `Not enough token balance (you have ${ethers.formatUnits(balTok, tflow.tokenDec!)}).`), html);
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
    // Atapnya = MODAL YANG BENAR-BENAR DIPEGANG, bukan angka kebijakan. usableFor()
    // sudah menangani kedua sisi: sisi token = saldo token, sisi base wrappable =
    // saldo native dikurangi cadangan gas (kalau dipakai habis, tx-nya sendiri tak
    // terbayar). Dulu hanya sisi token yang dijaga saldo; sisi base bersandar pada
    // batas per-tx, jadi begitu batas itu dimatikan tak ada yang menahan sama sekali.
    // Pembacaan gagal → pakai batas dari amountCtx, jangan memblokir hanya karena RPC ngadat.
    let cap = a.cap;
    let capLabel = a.capLabel;
    const balWei = await usableFor(flow).catch(() => null);
    if (balWei !== null) {
      const sym = flow.strategy === 'token' ? a.symbol : wizardBase(flow).wrappable ? wizardCtx(flow).nativeSymbol : a.symbol;
      cap = Number(ethers.formatUnits(balWei, dec));
      capLabel = `${cap.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${sym}`;
    }
    if (num > cap) return ctx.reply(msg.msgOverLimit(capLabel), html);
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
  if (ctx.callbackQuery) ctx.answerCbQuery('Failed — see the message.').catch(() => {});
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
  { command: 'start', description: 'Welcome card & bot status' },
  { command: 'help', description: 'Menu, bot mode & command list' },
  // Pantau
  { command: 'portfolio', description: 'Portfolio, balances & network' },
  { command: 'positions', description: 'Active LP positions (live)' },
  { command: 'pnl', description: 'Lifetime PnL summary' },
  // Riset
  // LP
  { command: 'claim_fees', description: 'Collect fees without closing' },
  { command: 'stop', description: 'Close an LP position' },
  // Swap
  { command: 'buy', description: 'Buy a token (best route)' },
  { command: 'sell', description: 'Sell a token (best route)' },
  { command: 'unwrap', description: 'Convert stuck wrapped native back' },
  { command: 'bridge', description: 'Move native funds across chains' },
  { command: 'send', description: 'Send funds to another address' },
  // Dompet & setelan
  { command: 'settings', description: 'Wallet & transaction preferences' },
  { command: 'alerts', description: 'Notification settings' },
] as const;

/** Menu vs command terdaftar. Selisihnya dilaporkan ke log, tidak mematikan bot. */
/**
 * Alias yang SENGAJA tak dipasang di menu. Penjaga menu tetap galak untuk sisanya —
 * daftar ini agar alias yang disengaja tak terbaca sebagai command yang lupa didaftar.
 */
// Alias tersembunyi: /status nama lama /portfolio; /add_lp masih jadi satu-satunya
// pintu ke pemilih pool teratas (tanpa CA), jadi handler-nya tetap hidup.
const HIDDEN_COMMANDS = new Set(['status', 'add_lp']);

function assertMenuComplete(): void {
  const inMenu = new Set(BOT_COMMANDS.map((c) => c.command));
  const missing = [...registeredCommands].filter((c) => !inMenu.has(c as never) && !HIDDEN_COMMANDS.has(c));
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
        walletStore.address() ?? '(not connected)',
        '| mode:',
        msg.modeLabel(config.safety.dryRun),
      );
      // Tanpa WALLET_SECRET, keystore dikunci memakai token bot. Ganti/cabut token
      // di BotFather = kunci tak bisa dibuka lagi, dan bot hanya diam bilang
      // "connect your wallet". Peringatkan sekali tiap boot, bukan diam-diam.
      if (!process.env.WALLET_SECRET) {
        console.warn(
          '[wallet] WARNING: WALLET_SECRET is not set — the keystore is encrypted with the bot token. ' +
            'Rotating the token will make the stored key permanently unreadable. ' +
            'To fix: set WALLET_SECRET, restart, then reconnect the wallet via /settings.',
        );
      }
      registerBotCommands().catch((e) => console.error('[menu]', (e as Error).message));
    })
    .then(
      () => console.log('PHILIPS stopped'),
      (err) => {
        const code = (err as any)?.response?.error_code;
        const text = String((err as Error)?.message ?? err);
        const is409 = code === 409 || /409|conflict|terminated by other getUpdates/i.test(text);

        // Token salah TIDAK akan sembuh dengan menunggu. Telegram membalas 401
        // (dicabut) atau 404 pada getMe (tak dikenal) — mencoba ulang enam kali lalu
        // keluar membuat systemd mengulangnya selamanya, dengan pesan "404: Not Found"
        // yang tak menyebut penyebabnya sama sekali. Berhenti, dan katakan apa adanya.
        const badToken = code === 401 || (code === 404 && /getMe/i.test(JSON.stringify((err as any)?.on ?? '')));
        if (badToken) {
          console.error(
            'TELEGRAM_BOT_TOKEN is not valid — Telegram does not recognise it.\n' +
              '  Open @BotFather, send /mybots, pick your bot, then "API Token".\n' +
              '  Copy the whole line (it looks like 1234567890:AA...) into .env and restart.',
          );
          process.exit(EXIT_CONFIG);
          return;
        }

        console.error(
          `Launch failed (attempt ${attempt}/${maxTries})${is409 ? ' [409 — another instance is still polling]' : ''}:`,
          text.slice(0, 200),
        );
        if (attempt >= maxTries) {
          console.error('Giving up. Check the network, the RPC, and TELEGRAM_BOT_TOKEN.');
          process.exit(1);
          return;
        }
        setTimeout(() => launchWithRetry(attempt + 1, maxTries), is409 ? 5000 : 2000);
      },
    );
}
launchWithRetry();
startMonitor(bot); // auto-monitor posisi aktif

// --- Watchdog liveness: telegraf long-poll bisa NGADAT diam-diam (getUpdates
// wedged / DC bot 502) — proses tetap "hidup", tapi bot bisu berjam-jam: tak ada
// alert anjlok/IL, tak ada respons command. systemd tak me-restart karena tak crash.
// Probe getMe() berkala; gagal beruntun = poll mati → exit(1), biar systemd restart
// (memulai long-poll baru — obat yang sama yang memulihkan insiden 7 jam). getMe
// lewat DC yang sama dgn getUpdates, jadi ikut gagal saat poll ngadat.
function startWatchdog() {
  const EVERY_MS = 3 * 60_000;
  const TIMEOUT_MS = 10_000;
  const MAX_FAILS = 4; // ~12 menit tak terjangkau → restart
  let fails = 0;
  setInterval(async () => {
    try {
      await Promise.race([
        bot.telegram.getMe(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getMe timeout')), TIMEOUT_MS)),
      ]);
      fails = 0;
    } catch (e) {
      fails++;
      console.error(`[watchdog] getMe gagal ${fails}/${MAX_FAILS}: ${(e as Error).message.slice(0, 80)}`);
      if (fails >= MAX_FAILS) {
        console.error('[watchdog] Telegram tak terjangkau — restart via systemd.');
        await notifyCrash('watchdog', 'long-poll ngadat — restart otomatis').catch(() => {});
        setTimeout(() => process.exit(1), 2000).unref();
      }
    }
  }, EVERY_MS).unref();
}
startWatchdog();

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
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  // Keluar DIJADWALKAN LEBIH DULU, baru notif. Penyebab crash paling lazim di bot
  // ini adalah masalah jaringan/Telegram — persis keadaan saat sendMessage-nya ikut
  // menggantung. Kalau exit menunggu notif, proses hidup terus dalam keadaan pasca-
  // crash: monitor tetap menandatangani tx, systemd tak pernah me-restart.
  setTimeout(() => process.exit(1), 3000).unref(); // systemd Restart=always menghidupkan lagi
  notifyCrash('uncaughtException', err).finally(() => process.exit(1));
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
