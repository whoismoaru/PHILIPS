import { ethers } from 'ethers';
import sdkCore from '@uniswap/sdk-core';
import {
  Pool,
  Position,
  TICK_SPACINGS,
  nearestUsableTick,
  tickToPrice,
  type FeeAmount,
} from '@uniswap/v3-sdk';
import type { Token as TToken } from '@uniswap/sdk-core';
import type { Pool as TPool, Position as TPosition } from '@uniswap/v3-sdk';
// SDK Uniswap masih CommonJS → impor default lalu ambil isinya.
const { Token, Percent, CurrencyAmount } = sdkCore;

// SDK Uniswap tak mengenal fee tier 2500 (khas PancakeSwap v3): Pool.tickSpacing
// mengembalikan undefined, lalu invariant Position gagal / lebar rentang jadi NaN.
// Daftarkan spacing-nya sekali di sini — angkanya diverifikasi on-chain lewat
// factory.feeAmountTickSpacing(2500) = 50.
(TICK_SPACINGS as Record<number, number>)[2500] = 50;
import { ERC20_ABI, approveExact } from './chain.js';
import { sendTxNonceSafe, isGoneErr } from './core.js';
import { getChain, baseOf, basesFor, detectBase, type ChainCtx, type BaseAsset, type BaseKind } from './chains.js';

const MAX_UINT128 = (1n << 128n) - 1n;
const SLIPPAGE = new Percent(50, 10_000); // 0.5%

/** Fee tier yang valid di Uniswap v3. */
/** Tick-spacing fee tier di chain ini. Melempar bila tier tak terdaftar — lebih baik
 *  berhenti daripada menghitung lebar rentang dengan spacing `undefined` (NaN → tick sampah). */
function spacingOf(fee: number, ctx: ChainCtx): number {
  const s = ctx.tickSpacing[fee] ?? TICK_SPACINGS[fee as FeeAmount];
  if (!s) throw new Error(`Fee tier ${fee} is not available on ${ctx.label}.`);
  return s;
}

/** Fee untuk objek SDK Uniswap. Slipstream memakai tickSpacing arbitrer yang tak ada
 *  di TICK_SPACINGS SDK → paksa 100 (spacing 1). Math jumlah token TIDAK memakai
 *  tickSpacing, dan tick kita (kelipatan spacing asli) tetap kelipatan 1, jadi
 *  invariant Position (tick % spacing === 0) lolos & jumlahnya tetap benar. */
const sdkFee = (fee: number, ctx: ChainCtx): FeeAmount => (ctx.slipstream ? 100 : fee) as FeeAmount;

/** Fragmen slot0(). CLPool Velodrome Slipstream mengembalikan 6 field (tanpa
 *  `feeProtocol uint8` milik Uniswap v3) → decode 7-field gagal. Keduanya menaruh
 *  sqrtPriceX96 di [0] & tick di [1], jadi kode pembaca tak berubah. */
const slot0Abi = (ctx: ChainCtx): string =>
  ctx.slipstream
    ? 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)'
    : 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)';

// Cache metadata token per chain (alamat sama bisa ada di banyak chain).
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

export async function getTokenMeta(
  address: string,
  ctx: ChainCtx = getChain(),
): Promise<{ symbol: string; decimals: number }> {
  const key = `${ctx.key}:${address.toLowerCase()}`;
  const cached = tokenMetaCache.get(key);
  if (cached) return cached;
  const c = new ethers.Contract(address, ERC20_ABI, ctx.provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  const meta = { symbol: symbol as string, decimals: Number(decimals) };
  tokenMetaCache.set(key, meta);
  return meta;
}

/** Ubah alamat token jadi objek Token milik SDK (butuh decimals & symbol). */
async function toSdkToken(address: string, ctx: ChainCtx): Promise<TToken> {
  const meta = await getTokenMeta(address, ctx);
  return new Token(ctx.chainId, ethers.getAddress(address), meta.decimals, meta.symbol);
}

type PoolState = {
  poolAddress: string;
  sdkPool: TPool;
  token0: string;
  token1: string;
  baseIsToken0: boolean;
  tokenOther: TToken; // token selain base (WETH/USDG)
  sdkBase: TToken;
  currentTick: number;
};

/** Baca kondisi pool base/token dari on-chain lalu bangun objek Pool milik SDK. */
export async function loadPool(
  tokenAddress: string,
  fee: number,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<PoolState> {
  // Fee tier & tick-spacing milik CHAIN: PancakeSwap memakai 2500 (spacing 50) dan
  // sama sekali tak punya 3000. Memakai tabel Uniswap di sana = lebar rentang NaN.
  if (!ctx.feeTiers.includes(fee)) {
    throw new Error(`Invalid fee tier ${fee}. Options: ${ctx.feeTiers.join(', ')}`);
  }
  const poolAddress: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new Error(`No ${base.symbol}/token pool at this fee tier.`);
  }

  const poolAbi = [
    slot0Abi(ctx),
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
  ];
  const pool = new ethers.Contract(poolAddress, poolAbi, ctx.provider);
  const [slot0, liquidity, token0, token1] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
    pool.token1(),
  ]);

  const sqrtPriceX96: bigint = slot0[0];
  const currentTick = Number(slot0[1]);
  const baseIsToken0 = token0.toLowerCase() === base.address.toLowerCase();

  const [sdkToken0, sdkToken1] = await Promise.all([toSdkToken(token0, ctx), toSdkToken(token1, ctx)]);
  const sdkPool = new Pool(
    sdkToken0,
    sdkToken1,
    sdkFee(fee, ctx),
    sqrtPriceX96.toString(),
    liquidity.toString(),
    currentTick,
  );

  const sdkBase = baseIsToken0 ? sdkToken0 : sdkToken1;
  const tokenOther = baseIsToken0 ? sdkToken1 : sdkToken0;

  return {
    poolAddress,
    sdkPool,
    token0,
    token1,
    baseIsToken0,
    tokenOther,
    sdkBase,
    currentTick,
  };
}

/** Ubah lebar rentang (persen PENURUNAN harga token) menjadi jumlah tick.
 *  Target: ujung terjauh = harga turun tepat X%. faktor = 1 - X/100 →
 *  width = |ln(1-X/100)| / ln(1.0001). Dibulatkan KELUAR (ceil) ke kelipatan
 *  spacing supaya rentang minimal menutup X% yang diminta. */
function widthInTicks(rangePercent: number, spacing: number): number {
  const frac = Math.min(Math.max(rangePercent, 0.1), 95) / 100;
  const raw = Math.abs(Math.log(1 - frac)) / Math.log(1.0001);
  return Math.max(spacing, Math.ceil(raw / spacing) * spacing);
}

/** Lebar rentang untuk KENAIKAN harga X%: width = ln(1+X/100)/ln(1.0001). */
function widthInTicksUp(rangePercent: number, spacing: number): number {
  const frac = Math.min(Math.max(rangePercent, 0.1), 1000) / 100;
  const raw = Math.log(1 + frac) / Math.log(1.0001);
  return Math.max(spacing, Math.ceil(raw / spacing) * spacing);
}

export type AddPlan = {
  baseKind: BaseKind;
  baseSymbol: string;
  baseDecimals: number;
  baseIsToken0: boolean;
  tickLower: number;
  tickUpper: number;
  priceLower: string;
  priceUpper: string;
  baseAmountWei: bigint; // pokok base (WETH 18-dec / USDG 6-dec)
  otherAmountWei: bigint; // idealnya ~0 (single-sided)
  otherSymbol: string;
  currentPrice: string; // harga token sekarang dalam base
  pctLow: number; // % ujung terjauh dari harga sekarang (paling negatif)
  pctHigh: number; // % ujung terdekat dari harga sekarang
  side: 'base' | 'token'; // aset yang disetor
  tokenAmountWei: bigint; // setoran sisi token (0 pada sisi base)
  tokenDecimals: number;
  position: TPosition;
};

/**
 * Hitung rencana posisi SINGLE-SIDED (hanya base = WETH atau USDG):
 *  - Kalau base = token0 → rentang harus DI ATAS harga sekarang.
 *  - Kalau base = token1 → rentang harus DI BAWAH harga sekarang.
 * Dengan begitu token yang lain dibutuhkan ~0. Jumlah base memakai
 * parseUnits(base.decimals) — WAJIB (USDG 6-dec ≠ WETH 18-dec).
 */
export async function planAddSingleSided(
  tokenAddress: string,
  fee: number,
  amount: string,
  rangePercent: number,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<AddPlan> {
  const st = await loadPool(tokenAddress, fee, base, ctx);
  const spacing = spacingOf(fee, ctx);
  const width = widthInTicks(rangePercent, spacing);
  const baseWei = ethers.parseUnits(amount, base.decimals);

  let tickLower: number;
  let tickUpper: number;
  let position: TPosition;

  if (st.baseIsToken0) {
    // Rentang di ATAS tick sekarang → butuh hanya token0 (base).
    // Ambil kelipatan spacing TERDEKAT di atas current (ceil) biar mepet harga.
    let lower = Math.ceil(st.currentTick / spacing) * spacing;
    if (lower <= st.currentTick) lower += spacing;
    tickLower = lower;
    tickUpper = lower + width;
    position = Position.fromAmount0({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount0: baseWei.toString(),
      useFullPrecision: true,
    });
  } else {
    // Rentang di BAWAH tick sekarang → butuh hanya token1 (base).
    let upper = Math.floor(st.currentTick / spacing) * spacing;
    if (upper >= st.currentTick) upper -= spacing;
    tickUpper = upper;
    tickLower = upper - width;
    position = Position.fromAmount1({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount1: baseWei.toString(),
    });
  }

  const mint = position.mintAmounts;
  const amount0 = BigInt(mint.amount0.toString());
  const amount1 = BigInt(mint.amount1.toString());
  const baseAmountWei = st.baseIsToken0 ? amount0 : amount1;
  const otherAmountWei = st.baseIsToken0 ? amount1 : amount0;

  // Harga token (dalam base) di kedua ujung rentang, untuk ditampilkan.
  const pLower = tickToPrice(st.tokenOther, st.sdkBase, tickLower).toSignificant(6);
  const pUpper = tickToPrice(st.tokenOther, st.sdkBase, tickUpper).toSignificant(6);
  const [priceLower, priceUpper] =
    Number(pLower) <= Number(pUpper) ? [pLower, pUpper] : [pUpper, pLower];

  // Rentang dalam persen relatif terhadap harga token sekarang.
  const currentPrice = st.sdkPool.priceOf(st.tokenOther).toSignificant(8);
  const cur = Number(currentPrice);
  const pctLow = cur > 0 ? (Number(priceLower) / cur - 1) * 100 : 0;
  const pctHigh = cur > 0 ? (Number(priceUpper) / cur - 1) * 100 : 0;

  return {
    baseKind: base.kind,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    baseIsToken0: st.baseIsToken0,
    tickLower,
    tickUpper,
    priceLower,
    priceUpper,
    baseAmountWei,
    otherAmountWei,
    otherSymbol: st.tokenOther.symbol!,
    currentPrice,
    pctLow,
    pctHigh,
    side: 'base',
    tokenAmountWei: 0n,
    tokenDecimals: st.tokenOther.decimals,
    position,
  };
}

/** Bentuk distribusi modal ladder. spot = rata; bidask = numpuk di harga terjauh (paling turun). */
export type LadderShape = 'spot' | 'bidask';

/** Bobot per-leg (index 0 = terdekat harga, N-1 = terjauh/paling turun). Jumlah = 1. */
export function ladderWeights(n: number, shape: LadderShape): number[] {
  if (n <= 1) return [1];
  // bidask linear: bobot ∝ (index+1) → leg terjauh paling berat. spot: rata.
  const raw = shape === 'bidask' ? Array.from({ length: n }, (_, i) => i + 1) : Array.from({ length: n }, () => 1);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * Rencana LADDER single-sided sisi BASE (buy-the-dip): pecah rentang [sekarang …
 * −X%] jadi N leg bersebelahan, tiap leg posisi terkonsentrasi sendiri dengan
 * modal berbobot. spot = modal rata; bidask = modal makin besar di harga makin
 * rendah. Tiap leg = AddPlan utuh → di-mint lewat executeAdd biasa (satu tokenId
 * per leg, dikelompokkan oleh groupId di store). Hanya sisi base — sisi token
 * tetap SPOT tunggal.
 */
export async function planLadderSingleSided(
  tokenAddress: string,
  fee: number,
  totalAmount: string,
  rangePercent: number,
  legs: number,
  shape: LadderShape,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<AddPlan[]> {
  const st = await loadPool(tokenAddress, fee, base, ctx);
  const spacing = spacingOf(fee, ctx);
  const fullWidth = widthInTicks(rangePercent, spacing);
  // Auto-cap: tiap leg butuh ≥1 tick-spacing. Pool kasar (spacing besar) tak muat
  // banyak leg dalam rentang → potong N ke jumlah spacing yang tersedia (maks 69).
  const maxLegs = Math.max(1, Math.floor(fullWidth / spacing));
  const n = Math.max(1, Math.min(legs, 69, maxLegs));
  // Lebar tiap leg = porsi spacing dari total, minimal 1 spacing.
  const legWidth = Math.max(spacing, Math.round(fullWidth / n / spacing) * spacing);
  const weights = ladderWeights(n, shape);
  const totalWei = ethers.parseUnits(totalAmount, base.decimals);
  const currentPrice = st.sdkPool.priceOf(st.tokenOther).toSignificant(8);
  const cur = Number(currentPrice);

  // Tick pangkal (mepet harga sekarang), sama seperti planAddSingleSided.
  let anchor: number;
  if (st.baseIsToken0) {
    anchor = Math.ceil(st.currentTick / spacing) * spacing;
    if (anchor <= st.currentTick) anchor += spacing;
  } else {
    anchor = Math.floor(st.currentTick / spacing) * spacing;
    if (anchor >= st.currentTick) anchor -= spacing;
  }

  const plans: AddPlan[] = [];
  let allocated = 0n;
  for (let k = 0; k < n; k++) {
    // Modal leg: bobot × total; leg terakhir menyapu sisa (hindari debu pembulatan).
    const legWei = k === n - 1 ? totalWei - allocated : (totalWei * BigInt(Math.round(weights[k] * 1e9))) / 1_000_000_000n;
    allocated += legWei;

    let tickLower: number;
    let tickUpper: number;
    let position: TPosition;
    if (st.baseIsToken0) {
      // Rentang DI ATAS: leg k makin jauh ke atas = harga token makin turun.
      tickLower = anchor + k * legWidth;
      tickUpper = tickLower + legWidth;
      position = Position.fromAmount0({ pool: st.sdkPool, tickLower, tickUpper, amount0: legWei.toString(), useFullPrecision: true });
    } else {
      // Rentang DI BAWAH: leg k makin jauh ke bawah = harga token makin turun.
      tickUpper = anchor - k * legWidth;
      tickLower = tickUpper - legWidth;
      position = Position.fromAmount1({ pool: st.sdkPool, tickLower, tickUpper, amount1: legWei.toString() });
    }

    const mint = position.mintAmounts;
    const amount0 = BigInt(mint.amount0.toString());
    const amount1 = BigInt(mint.amount1.toString());
    const pLower = tickToPrice(st.tokenOther, st.sdkBase, tickLower).toSignificant(6);
    const pUpper = tickToPrice(st.tokenOther, st.sdkBase, tickUpper).toSignificant(6);
    const [priceLower, priceUpper] = Number(pLower) <= Number(pUpper) ? [pLower, pUpper] : [pUpper, pLower];

    plans.push({
      baseKind: base.kind,
      baseSymbol: base.symbol,
      baseDecimals: base.decimals,
      baseIsToken0: st.baseIsToken0,
      tickLower,
      tickUpper,
      priceLower,
      priceUpper,
      baseAmountWei: st.baseIsToken0 ? amount0 : amount1,
      otherAmountWei: st.baseIsToken0 ? amount1 : amount0,
      otherSymbol: st.tokenOther.symbol!,
      currentPrice,
      pctLow: cur > 0 ? (Number(priceLower) / cur - 1) * 100 : 0,
      pctHigh: cur > 0 ? (Number(priceUpper) / cur - 1) * 100 : 0,
      side: 'base',
      tokenAmountWei: 0n,
      tokenDecimals: st.tokenOther.decimals,
      position,
    });
  }
  return plans;
}

/**
 * Rencana SINGLE-SIDED sisi TOKEN: setor tokennya saja, rentang DI ATAS harga
 * sekarang. Posisi bekerja seperti limit-sell pasif — token perlahan berubah
 * jadi base saat harga naik melewati rentang, sambil memanen fee.
 *
 * Cermin dari planAddSingleSided: sisi tick yang dipakai kebalikannya, karena
 * posisi berisi 100% token0 saat harga DI BAWAH rentang, dan 100% token1 saat
 * harga DI ATAS rentang.
 */
export async function planAddTokenSide(
  tokenAddress: string,
  fee: number,
  amountToken: string,
  rangePercentUp: number,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<AddPlan> {
  const st = await loadPool(tokenAddress, fee, base, ctx);
  const spacing = spacingOf(fee, ctx);
  const width = widthInTicksUp(rangePercentUp, spacing);
  const tokenWei = ethers.parseUnits(amountToken, st.tokenOther.decimals);

  let tickLower: number;
  let tickUpper: number;
  let position: TPosition;

  if (st.baseIsToken0) {
    // Token = token1 → posisi harus berisi token1 saja → rentang DI BAWAH tick.
    let upper = Math.floor(st.currentTick / spacing) * spacing;
    if (upper >= st.currentTick) upper -= spacing;
    tickUpper = upper;
    tickLower = upper - width;
    position = Position.fromAmount1({ pool: st.sdkPool, tickLower, tickUpper, amount1: tokenWei.toString() });
  } else {
    // Token = token0 → posisi harus berisi token0 saja → rentang DI ATAS tick.
    let lower = Math.ceil(st.currentTick / spacing) * spacing;
    if (lower <= st.currentTick) lower += spacing;
    tickLower = lower;
    tickUpper = lower + width;
    position = Position.fromAmount0({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount0: tokenWei.toString(),
      useFullPrecision: true,
    });
  }

  const mint = position.mintAmounts;
  const amount0 = BigInt(mint.amount0.toString());
  const amount1 = BigInt(mint.amount1.toString());
  const baseAmountWei = st.baseIsToken0 ? amount0 : amount1;
  const tokenAmountWei = st.baseIsToken0 ? amount1 : amount0;

  const pLower = tickToPrice(st.tokenOther, st.sdkBase, tickLower).toSignificant(6);
  const pUpper = tickToPrice(st.tokenOther, st.sdkBase, tickUpper).toSignificant(6);
  const [priceLower, priceUpper] =
    Number(pLower) <= Number(pUpper) ? [pLower, pUpper] : [pUpper, pLower];

  const currentPrice = st.sdkPool.priceOf(st.tokenOther).toSignificant(8);
  const cur = Number(currentPrice);
  const pctLow = cur > 0 ? (Number(priceLower) / cur - 1) * 100 : 0;
  const pctHigh = cur > 0 ? (Number(priceUpper) / cur - 1) * 100 : 0;

  return {
    baseKind: base.kind,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    baseIsToken0: st.baseIsToken0,
    tickLower,
    tickUpper,
    priceLower,
    priceUpper,
    baseAmountWei,
    otherAmountWei: tokenAmountWei,
    otherSymbol: st.tokenOther.symbol!,
    currentPrice,
    pctLow,
    pctHigh,
    side: 'token',
    tokenAmountWei,
    tokenDecimals: st.tokenOther.decimals,
    position,
  };
}

/** Pastikan saldo BASE cukup & izin (approve) ke Position Manager.
 *  WETH (wrappable): bungkus ETH native seperlunya. USDG (non-wrappable):
 *  wajib sudah dipegang — tak bisa di-wrap. Semua format pakai base.decimals. */
/** Estimasi unit gas buka LP (wrap + approve + mint). Dipakai juga oleh preview biaya. */
export const ADD_GAS_UNITS = 700_000n;

/**
 * Cadangan gas saat wrap: dulu datar 0.0005 ETH — di chain gas mahal itu 10× terlalu
 * kecil, ETH habis ke wrap lalu mint gagal "insufficient funds" & dana terjebak
 * sebagai WETH. Hitung dari harga gas nyata (+20% headroom), dengan lantai lama.
 */
export async function gasBuffer(ctx: ChainCtx): Promise<bigint> {
  try {
    const fee = await ctx.provider.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice;
    if (price) {
      const est = (price * ADD_GAS_UNITS * 12n) / 10n;
      return est > MIN_GAS_BUFFER ? est : MIN_GAS_BUFFER;
    }
  } catch {
    /* pakai lantai */
  }
  return MIN_GAS_BUFFER;
}
const MIN_GAS_BUFFER = ethers.parseEther('0.0005'); // lantai cadangan gas L2

async function ensureBaseReady(base: BaseAsset, amountWei: bigint, ctx: ChainCtx): Promise<string[]> {
  const { wallet, provider } = ctx;
  const notes: string[] = [];
  const baseC = base.wrappable ? ctx.weth : new ethers.Contract(base.address, ERC20_ABI, wallet);
  let bal: bigint = await baseC.balanceOf(wallet.address);

  if (bal < amountWei) {
    if (!base.wrappable) {
      // USDG dsb: ERC20 biasa, harus SUDAH ada di wallet.
      throw new Error(
        `Not enough ${base.symbol} on ${ctx.label}: need ${ethers.formatUnits(amountWei, base.decimals)}, ` +
          `available ${ethers.formatUnits(bal, base.decimals)}. ${base.symbol} cannot be wrapped from ETH — ` +
          `top up with ${base.symbol} first, or lower the amount.`,
      );
    }
    // WETH: wrap ETH native seperlunya, jaga cadangan gas.
    const native = ctx.nativeSymbol;
    const need = amountWei - bal;
    const ethBal = await provider.getBalance(wallet.address);
    const buffer = await gasBuffer(ctx);
    if (ethBal < need + buffer) {
      throw new Error(
        `Not enough ${native} on ${ctx.label}: need ~${ethers.formatEther(need + buffer)} ` +
          `(wrap + gas), available ${ethers.formatEther(ethBal)}. Top up your wallet or lower the amount.`,
      );
    }
    const tx = await ctx.weth.deposit({ value: need });
    await tx.wait();
    notes.push(`Wrap ${ethers.formatEther(need)} ${native} (tx ${tx.hash})`);
    // RPC kerap belum memperbarui saldo tepat setelah tx mendarat. Baca ulang
    // beberapa kali SEBELUM menyimpulkan kurang: dulu pembacaan basi (0) langsung
    // memicu wrap KEDUA sebesar amountWei PENUH — padahal ETH sudah terpakai di
    // wrap pertama, jadi node menolak "insufficient funds" dan seluruh hasil wrap
    // tertinggal sebagai WETH. Terjadi 2 Agu 2026: 0.12 WETH nyangkut.
    for (let i = 0; i < 5 && bal < amountWei; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      bal = await baseC.balanceOf(wallet.address);
    }
    if (bal < amountWei) {
      // Yang kurang saja, dan hanya bila ETH yang tersisa memang menutupi.
      const short = amountWei - bal;
      const nativeNow = await provider.getBalance(wallet.address);
      if (nativeNow < short + buffer) {
        throw new Error(
          `Wrap fell short by ${ethers.formatEther(short)} ${native} and the remaining ` +
            `${ethers.formatEther(nativeNow)} ${native} cannot cover it plus gas. ` +
            `Your wrapped ${base.symbol} is safe in the wallet — use /unwrap to convert it back.`,
        );
      }
      const tx2 = await ctx.weth.deposit({ value: short });
      await tx2.wait();
      notes.push(`Wrap extra ${ethers.formatEther(short)} ${native} (tx ${tx2.hash})`);
      bal = await baseC.balanceOf(wallet.address);
      if (bal < amountWei) throw new Error('Wrap still short after retry — try again.');
    }
  }
  for (const h of await approveExact(base.address, ctx.pmAddress, amountWei, wallet)) {
    notes.push(`Approve ${base.symbol} for Position Manager (tx ${h})`);
  }
  return notes;
}

/** Pastikan saldo ERC20 (token biasa) cukup & sudah di-approve ke Position Manager.
 *  Tak ada wrap di sini: token biasa harus memang sudah dipegang. */
async function ensureErc20Ready(
  address: string,
  amountWei: bigint,
  symbol: string,
  decimals: number,
  ctx: ChainCtx,
): Promise<string[]> {
  const { wallet } = ctx;
  const notes: string[] = [];
  const c = new ethers.Contract(address, ERC20_ABI, wallet);
  const bal: bigint = await c.balanceOf(wallet.address);
  if (bal < amountWei) {
    throw new Error(
      `Insufficient ${symbol} balance: need ${ethers.formatUnits(amountWei, decimals)}, ` +
        `have ${ethers.formatUnits(bal, decimals)}. Buy some with /buy or lower the amount.`,
    );
  }
  for (const h of await approveExact(address, ctx.pmAddress, amountWei, wallet)) {
    notes.push(`Approve ${symbol} for Position Manager (tx ${h})`);
  }
  return notes;
}

/** Eksekusi penambahan LP single-sided. Mengembalikan tokenId posisi baru + catatan. */
export async function executeAdd(
  plan: AddPlan,
  tokenAddress: string,
  fee: number,
  ctx: ChainCtx = getChain(),
): Promise<{ tokenId: string; notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const base = baseOf(ctx, plan.baseKind);
  // Sisi token: yang perlu disiapkan tokennya, bukan base (tak ada yang di-wrap).
  const notes =
    plan.side === 'token'
      ? await ensureErc20Ready(tokenAddress, plan.tokenAmountWei, plan.otherSymbol, plan.tokenDecimals, ctx)
      : await ensureBaseReady(base, plan.baseAmountWei, ctx);

  const withSlip = plan.position.mintAmountsWithSlippage(SLIPPAGE);
  const params = {
    token0: plan.baseIsToken0 ? base.address : tokenAddress,
    token1: plan.baseIsToken0 ? tokenAddress : base.address,
    fee,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    amount0Desired: BigInt(plan.position.mintAmounts.amount0.toString()),
    amount1Desired: BigInt(plan.position.mintAmounts.amount1.toString()),
    amount0Min: BigInt(withSlip.amount0.toString()),
    amount1Min: BigInt(withSlip.amount1.toString()),
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600,
    // Slipstream: mint butuh sqrtPriceX96 (0 = pool sudah ada, jangan buat baru).
    // Field `fee` di params ini = tickSpacing (ABI Slipstream menamainya `fee`).
    // ABI Uniswap v3 mengabaikan key ekstra ini, jadi aman diisi selalu.
    ...(ctx.slipstream ? { sqrtPriceX96: 0n } : {}),
  };

  let receipt;
  try {
    const tx = await positionManager.mint(params);
    receipt = await tx.wait();
  } catch (e) {
    // STF = transfer base gagal (saldo/allowance). Pulihkan sekali lalu retry.
    if (/STF/i.test((e as Error).message)) {
      notes.push(`Mint hit STF — re-verifying assets and retrying...`);
      notes.push(
        ...(plan.side === 'token'
          ? await ensureErc20Ready(tokenAddress, plan.tokenAmountWei, plan.otherSymbol, plan.tokenDecimals, ctx)
          : await ensureBaseReady(base, plan.baseAmountWei, ctx)),
      );
      const tx = await positionManager.mint({ ...params, deadline: Math.floor(Date.now() / 1000) + 600 });
      receipt = await tx.wait();
    } else {
      throw e;
    }
  }
  notes.push(`Mint Position (tx ${receipt.hash})`);

  // tokenId dibaca dari event Transfer(0x0 -> wallet) di receipt mint sendiri.
  // JANGAN pakai tokenOfOwnerByIndex(bal-1): urutan index ERC721 berubah-ubah
  // saat ada NFT lain di-burn — pernah menyebabkan record menunjuk NFT lama.
  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const pmAddr = String(positionManager.target).toLowerCase();
  let tokenId: bigint | null = null;
  for (const log of receipt.logs ?? []) {
    if (
      log.address.toLowerCase() === pmAddr &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics.length === 4 &&
      BigInt(log.topics[1]) === 0n && // from = 0x0 (mint)
      BigInt(log.topics[2]) === BigInt(wallet.address)
    ) {
      tokenId = BigInt(log.topics[3]);
      break;
    }
  }
  if (tokenId === null) {
    // Fallback terakhir (seharusnya tak pernah terjadi).
    notes.push('⚠️ Mint event not found in receipt — falling back to last index.');
    const bal: bigint = await positionManager.balanceOf(wallet.address);
    tokenId = BigInt(await positionManager.tokenOfOwnerByIndex(wallet.address, bal - 1n));
  }
  return { tokenId: tokenId!.toString(), notes };
}

/** Batas leg per multicall — jaga di bawah block gas limit (~400k gas/mint). */
export const MAX_LEGS_PER_MULTICALL = 25;

/**
 * BATCH mint ladder via multicall: N leg (sisi base) dalam SATU tx atomik per
 * chunk. Approve+wrap base SEKALI untuk total, lalu multicall([mint,mint,…]).
 * Tutup kelemahan "N tx" v3 — 69 leg jadi ~3 tx (chunk 25), bukan 69. tokenId
 * tiap leg dibaca dari event Transfer(0x0→wallet) berurutan di receipt.
 */
export async function executeAddBatch(
  plans: AddPlan[],
  tokenAddress: string,
  fee: number,
  ctx: ChainCtx = getChain(),
): Promise<{ tokenIds: string[]; notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const base = baseOf(ctx, plans[0].baseKind);
  const totalBase = plans.reduce((s, p) => s + p.baseAmountWei, 0n);
  const notes = await ensureBaseReady(base, totalBase, ctx); // wrap+approve total sekali
  const iface = positionManager.interface;
  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const pmAddr = String(positionManager.target).toLowerCase();
  const tokenIds: string[] = [];

  for (let off = 0; off < plans.length; off += MAX_LEGS_PER_MULTICALL) {
    const chunk = plans.slice(off, off + MAX_LEGS_PER_MULTICALL);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const calls = chunk.map((plan) => {
      const withSlip = plan.position.mintAmountsWithSlippage(SLIPPAGE);
      const params = {
        token0: plan.baseIsToken0 ? base.address : tokenAddress,
        token1: plan.baseIsToken0 ? tokenAddress : base.address,
        fee,
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        amount0Desired: BigInt(plan.position.mintAmounts.amount0.toString()),
        amount1Desired: BigInt(plan.position.mintAmounts.amount1.toString()),
        amount0Min: BigInt(withSlip.amount0.toString()),
        amount1Min: BigInt(withSlip.amount1.toString()),
        recipient: wallet.address,
        deadline,
        ...(ctx.slipstream ? { sqrtPriceX96: 0n } : {}),
      };
      return iface.encodeFunctionData('mint', [params]);
    });
    // PRE-FLIGHT: simulasi multicall dulu (saldo & approval sudah siap dari
    // ensureBaseReady di atas). Kalau ada leg yang bakal revert, gagal DI SINI dengan
    // alasan asli (bukan 'require(false)' opaque saat kirim), dan SEBELUM tx dikirim.
    try {
      await positionManager.multicall.staticCall(calls);
    } catch (e) {
      throw new Error(`Ladder batch would revert (${chunk.length} legs): ${(e as Error).message.slice(0, 140)}`);
    }
    const tx = await sendTxNonceSafe(wallet as ethers.Wallet, await positionManager.multicall.populateTransaction(calls));
    const receipt = await tx.wait();
    if (!receipt) throw new Error('batch mint tx has no receipt');
    // Semua Transfer(0x0→wallet) di receipt = tokenId tiap leg, urut eksekusi.
    for (const log of receipt.logs ?? []) {
      if (
        log.address.toLowerCase() === pmAddr &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length === 4 &&
        BigInt(log.topics[1]) === 0n &&
        BigInt(log.topics[2]) === BigInt(wallet.address)
      ) {
        tokenIds.push(BigInt(log.topics[3]).toString());
      }
    }
    notes.push(`Batch mint ${chunk.length} legs (tx ${receipt.hash})`);
  }
  return { tokenIds, notes };
}

/**
 * BATCH remove+collect+burn ladder via multicall: seluruh leg dikosongkan &
 * di-burn dalam ~1 tx per chunk. Aset (base + token) mendarat di wallet; swap
 * token→base dilakukan pemanggil SEKALI (agregat), bukan per-leg.
 */
export async function executeRemoveBatch(
  tokenIds: string[],
  ctx: ChainCtx = getChain(),
): Promise<{ notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const iface = positionManager.interface;
  const notes: string[] = [];
  for (let off = 0; off < tokenIds.length; off += MAX_LEGS_PER_MULTICALL) {
    const chunk = tokenIds.slice(off, off + MAX_LEGS_PER_MULTICALL);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const calls: string[] = [];
    let live = 0;
    for (const tokenId of chunk) {
      // Leg yang sudah hangus (positions() revert 'Invalid token ID') → LEWATI, jangan
      // masukkan ke multicall (burn ganda me-revert seluruh batch & bikin close macet).
      //
      // TAPI hanya untuk revert itu. Dulu `catch {}` menelan SEMUA kegagalan, termasuk
      // RPC yang putus — dan itu berakhir bencana: 28 Agu 2026 delapan leg (214 USDT)
      // gagal dibaca karena ECONNRESET, semuanya dilewati, daftar panggilan jadi kosong,
      // dan bot melaporkan "LADDER CLOSED" padahal tak satu tx pun dikirim. Posisinya
      // masih hidup di chain tapi sudah dihapus dari catatan. Gagal baca ≠ posisi hilang.
      let liquidity: bigint;
      try {
        liquidity = BigInt((await positionManager.positions(tokenId)).liquidity);
      } catch (e) {
        if (isGoneErr(e)) continue;
        throw new Error(
          `Could not read position #${tokenId} (${(e as Error).message.slice(0, 80)}). ` +
            'Nothing was closed. Try again when the network settles.',
        );
      }
      if (liquidity > 0n) {
        const { unprotected, ...mins } = await withdrawMins(positionManager, tokenId, liquidity, deadline, ctx);
        if (unprotected) notes.push(WITHDRAW_UNPROTECTED_NOTE(tokenId));
        calls.push(iface.encodeFunctionData('decreaseLiquidity', [{ tokenId, liquidity, ...mins, deadline }]));
      }
      calls.push(
        iface.encodeFunctionData('collect', [
          { tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
        ]),
      );
      calls.push(iface.encodeFunctionData('burn', [tokenId]));
      live++;
    }
    if (calls.length === 0) {
      // Sampai di sini artinya SETIAP leg benar-benar revert 'Invalid token ID' —
      // kegagalan baca sudah dilempar di atas, jadi ini memang sudah tertutup.
      notes.push('Batch close: all legs already closed on-chain.');
      continue;
    }
    // PRE-FLIGHT: simulasi dulu → gagal dengan alasan asli sebelum kirim tx.
    try {
      await positionManager.multicall.staticCall(calls);
    } catch (e) {
      throw new Error(`Ladder close batch would revert (${live} legs): ${(e as Error).message.slice(0, 140)}`);
    }
    const tx = await sendTxNonceSafe(wallet as ethers.Wallet, await positionManager.multicall.populateTransaction(calls));
    const receipt = await tx.wait();
    notes.push(`Batch close ${live} legs (tx ${receipt?.hash ?? tx.hash})`);
  }
  return { notes };
}

export type PositionInfo = {
  tokenId: string;
  token0: string; // alamat (untuk deteksi base/ca saat sinkron)
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  inRange: boolean;
};

/** Daftar semua posisi LP milik dompet bot (per chain). */
export async function listPositions(ctx: ChainCtx = getChain()): Promise<PositionInfo[]> {
  const { positionManager, wallet } = ctx;
  const n: bigint = await positionManager.balanceOf(wallet.address);
  const out: PositionInfo[] = [];
  for (let i = 0n; i < n; i++) {
    const tokenId: bigint = await positionManager.tokenOfOwnerByIndex(wallet.address, i);
    const p = await positionManager.positions(tokenId);
    const [m0, m1] = await Promise.all([getTokenMeta(p.token0, ctx), getTokenMeta(p.token1, ctx)]);
    let inRange = false;
    try {
      const poolAddr: string = await ctx.factory.getPool(p.token0, p.token1, p.fee);
      const pool = new ethers.Contract(
        poolAddr,
        [slot0Abi(ctx)],
        ctx.provider,
      );
      const slot0 = await pool.slot0();
      const cur = Number(slot0[1]);
      inRange = cur >= Number(p.tickLower) && cur < Number(p.tickUpper);
    } catch {
      /* biarkan inRange = false kalau pool tak terbaca */
    }
    out.push({
      tokenId: tokenId.toString(),
      token0: p.token0,
      token1: p.token1,
      token0Symbol: m0.symbol,
      token1Symbol: m1.symbol,
      fee: Number(p.fee),
      tickLower: Number(p.tickLower),
      tickUpper: Number(p.tickUpper),
      liquidity: BigInt(p.liquidity),
      inRange,
    });
  }
  return out;
}

/**
 * Panen fee TANPA menutup posisi: `collect` saja, tanpa decreaseLiquidity dan
 * tanpa burn. Nilai yang tertarik = fee yang belum diklaim (pokok tetap di pool).
 * Kembalian dalam satuan token0/token1 mentah + hash tx.
 */
export async function collectFeesOnly(
  tokenId: string,
  ctx: ChainCtx = getChain(),
): Promise<{ txHash: string; amount0: bigint; amount1: bigint }> {
  const { positionManager, wallet } = ctx;
  const params = {
    tokenId,
    recipient: wallet.address,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };
  // staticCall dulu: angka yang dilaporkan ke user harus angka yang benar-benar
  // akan tertarik, bukan tebakan dari kartu sebelumnya.
  const owed = await positionManager.collect.staticCall(params);
  const tx = await positionManager.collect(params);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, amount0: BigInt(owed[0]), amount1: BigInt(owed[1]) };
}

/**
 * Tarik SEBAGIAN likuiditas (1–99%) lalu collect. Posisi TIDAK di-burn dan tetap
 * hidup — dipakai /remove_lp 25/50/75%. Untuk 100% pakai executeRemove (burn +
 * jurnal + cashout), supaya tak ada dua jalur penutupan yang bisa menyimpang.
 */
/**
 * Lantai slippage untuk decreaseLiquidity.
 *
 * amount0Min/amount1Min adalah SATU-SATUNYA proteksi harga yang dimiliki
 * decreaseLiquidity. Dengan 0, penarikan bisa disandwich: harga didorong ke tepi
 * rentang, posisi keluar ~100% sebagai aset yang sedang ditekan, lalu harga
 * dikembalikan — dan tx-nya tetap "sukses" sehingga tak ada yang menandai.
 *
 * Angka harapannya dibaca lewat staticCall (harga saat ini), lantainya 99.5% dari
 * situ. Kalau harga digeser antara pembacaan dan eksekusi, tx REVERT — itu hasil
 * yang benar: gas hangus jauh lebih murah daripada ditutup di harga sembarang.
 */
const WITHDRAW_SLIPPAGE_BPS = 50n; // 0.5%

/** Catatan yang ikut ke kartu hasil close saat penarikan terpaksa tanpa lantai harga. */
const WITHDRAW_UNPROTECTED_NOTE = (tokenId: string) =>
  `⚠️ #${tokenId} withdrawn WITHOUT a price floor — the pool could not be priced, so sandwich protection was off for this close.`;

/** Ekspektasi jumlah token0/token1 dari burn `liquidity`, dihitung dari HARGA POOL
 *  saat ini via SDK (tanpa simulasi decreaseLiquidity). Dipakai sebagai lantai
 *  slippage cadangan bila staticCall PM tak tersedia. */
async function expectedBurnAmounts(
  tokenId: string,
  liquidity: bigint,
  ctx: ChainCtx,
): Promise<{ amount0: bigint; amount1: bigint }> {
  const p = await ctx.positionManager.positions(tokenId);
  const fee = Number(p.fee);
  const [m0, m1] = await Promise.all([getTokenMeta(p.token0, ctx), getTokenMeta(p.token1, ctx)]);
  const poolAddr: string = await ctx.factory.getPool(p.token0, p.token1, fee);
  const pool = new ethers.Contract(
    poolAddr,
    [slot0Abi(ctx), 'function liquidity() view returns (uint128)'],
    ctx.provider,
  );
  const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const t0 = new Token(ctx.chainId, ethers.getAddress(p.token0), m0.decimals, m0.symbol);
  const t1 = new Token(ctx.chainId, ethers.getAddress(p.token1), m1.decimals, m1.symbol);
  const sdkPool = new Pool(t0, t1, sdkFee(fee, ctx), slot0[0].toString(), liq.toString(), Number(slot0[1]));
  const pos = new Position({ pool: sdkPool, liquidity: liquidity.toString(), tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper) });
  return { amount0: BigInt(pos.amount0.quotient.toString()), amount1: BigInt(pos.amount1.quotient.toString()) };
}

async function withdrawMins(
  positionManager: ethers.Contract,
  tokenId: string,
  liquidity: bigint,
  deadline: number,
  ctx: ChainCtx,
): Promise<{ amount0Min: bigint; amount1Min: bigint; unprotected: boolean }> {
  const floor = (v: bigint) => (BigInt(v) * (10000n - WITHDRAW_SLIPPAGE_BPS)) / 10000n;
  // Retry: kegagalan staticCall paling lazim TRANSIEN (RPC rewel sesaat) — bukan
  // alasan menutup tanpa proteksi. Coba 3x sebelum menyerah ke jalur cadangan.
  for (let i = 0; i < 3; i++) {
    try {
      const [a0, a1] = await positionManager.decreaseLiquidity.staticCall({ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline });
      return { amount0Min: floor(a0), amount1Min: floor(a1), unprotected: false };
    } catch {
      if (i < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
  // Cadangan: hitung lantai dari harga pool + SDK. Proteksi sandwich TETAP ADA
  // walau PM tak bisa disimulasikan — dulu di sini langsung {0,0} (bocor senyap).
  try {
    const exp = await expectedBurnAmounts(tokenId, liquidity, ctx);
    console.log(`[withdraw] staticCall gagal, pakai lantai dari harga pool (#${tokenId})`);
    return { amount0Min: floor(exp.amount0), amount1Min: floor(exp.amount1), unprotected: false };
  } catch {
    // Benar-benar tak bisa hitung → jangan blokir penarikan (dana user > risiko MEV).
    // Ini SATU-SATUNYA jalur yang menarik tanpa lantai harga. Dulu hanya masuk log
    // server, jadi user menutup posisi tanpa pernah tahu ronde itu tak terlindungi.
    // `unprotected` dibawa ke atas supaya muncul di kartu hasil close.
    console.log(`[withdraw] ⚠️ lantai slippage TAK tersedia (#${tokenId}) — tarik tanpa proteksi harga`);
    return { amount0Min: 0n, amount1Min: 0n, unprotected: true };
  }
}

export async function removeLiquidityPct(
  tokenId: string,
  pct: number,
  ctx: ChainCtx = getChain(),
): Promise<{ notes: string[]; txHash: string }> {
  if (!(pct > 0 && pct < 100)) throw new Error(`withdraw percentage must be 1–99 (got ${pct})`);
  const { positionManager, wallet } = ctx;
  const p = await positionManager.positions(tokenId);
  const liquidity: bigint = BigInt(p.liquidity);
  if (liquidity === 0n) throw new Error('position has no liquidity to withdraw');

  // Pembagian bilangan bulat: sisa pembagian tertinggal di pool (bukan hilang).
  const part = (liquidity * BigInt(Math.round(pct))) / 100n;
  if (part === 0n) throw new Error('withdraw amount rounds to 0 — use 100% instead');

  const iface = positionManager.interface;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const { unprotected, ...mins } = await withdrawMins(positionManager, tokenId, part, deadline, ctx);
  const calls = [
    iface.encodeFunctionData('decreaseLiquidity', [
      { tokenId, liquidity: part, ...mins, deadline },
    ]),
    iface.encodeFunctionData('collect', [
      { tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
    ]),
  ];
  const tx = await positionManager.multicall(calls);
  const receipt = await tx.wait();
  return {
    txHash: receipt.hash,
    notes: [
      `Withdraw ${pct}% of position #${tokenId} liquidity + harvest fees (tx ${receipt.hash})`,
      ...(unprotected ? [WITHDRAW_UNPROTECTED_NOTE(tokenId)] : []),
    ],
  };
}

/** Tarik SELURUH likuiditas, kumpulkan token, lalu burn NFT-nya.
 *  Menangani posisi kosong (likuiditas 0): skip decrease, langsung collect+burn. */
export async function executeRemove(
  tokenId: string,
  ctx: ChainCtx = getChain(),
): Promise<{ notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const p = await positionManager.positions(tokenId);
  const liquidity: bigint = BigInt(p.liquidity);

  const iface = positionManager.interface;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const calls: string[] = [];
  let unprotected = false;
  if (liquidity > 0n) {
    const r = await withdrawMins(positionManager, tokenId, liquidity, deadline, ctx);
    unprotected = r.unprotected;
    const mins = { amount0Min: r.amount0Min, amount1Min: r.amount1Min };
    calls.push(
      iface.encodeFunctionData('decreaseLiquidity', [{ tokenId, liquidity, ...mins, deadline }]),
    );
  }
  calls.push(
    iface.encodeFunctionData('collect', [
      { tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
    ]),
  );
  calls.push(iface.encodeFunctionData('burn', [tokenId]));

  const tx = await positionManager.multicall(calls);
  const receipt = await tx.wait();
  return {
    notes: [
      `Close position #${tokenId}${liquidity === 0n ? ' (empty → burn directly)' : ''} (tx ${receipt.hash})`,
      ...(unprotected ? [WITHDRAW_UNPROTECTED_NOTE(tokenId)] : []),
    ],
  };
}

export type PoolOption = {
  fee: number;
  poolAddress: string;
  base: BaseKind; // 'weth' | 'usdg'
  baseSymbol: string;
  baseDecimals: number;
  baseReserve: bigint; // base tersimpan di pool (proksi kedalaman likuiditas)
};

/** Pool base/token di seluruh fee tier, urut kedalaman (base reserve) terbesar. */
async function poolsForBase(
  tokenAddress: string,
  base: BaseAsset,
  ctx: ChainCtx,
): Promise<PoolOption[]> {
  const baseC = base.wrappable ? ctx.weth : new ethers.Contract(base.address, ERC20_ABI, ctx.provider);
  // Semua fee tier diperiksa serentak (round-trip RPC diparalel + auto-batch ethers).
  const perFee = await Promise.all(
    ctx.feeTiers.map(async (fee): Promise<PoolOption | null> => {
      const poolAddress: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) return null;
      // Dulu ikut memanggil priceInfo (= loadPool penuh) per fee tier hanya untuk
      // mengisi field yang tak pernah dibaca siapa pun: ~55 RPC terbuang tiap discovery.
      const baseReserve: bigint = await baseC.balanceOf(poolAddress);
      return {
        fee,
        poolAddress,
        base: base.kind,
        baseSymbol: base.symbol,
        baseDecimals: base.decimals,
        baseReserve,
      };
    }),
  );
  const out = perFee.filter((p): p is PoolOption => p !== null);
  out.sort((a, b) => (b.baseReserve > a.baseReserve ? 1 : b.baseReserve < a.baseReserve ? -1 : 0));
  return out;
}

/** Pool WETH/token — dipakai jalur uang (swap fallback & valuasi USD holdings). */
export async function discoverPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  return poolsForBase(tokenAddress, baseOf(ctx, 'weth'), ctx);
}

/** Pool untuk SEMUA base (WETH + USDG bila tersedia) — dipakai wizard /add. */
export async function discoverAllPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  const perBase = await Promise.all(basesFor(ctx).map((b) => poolsForBase(tokenAddress, b, ctx)));
  return perBase.flat();
}


/** Info harga & sisi base untuk sebuah pool. */
export async function priceInfo(tokenAddress: string, fee: number, base: BaseAsset, ctx: ChainCtx = getChain()) {
  const st = await loadPool(tokenAddress, fee, base, ctx);
  const priceTokenInBase = st.sdkPool.priceOf(st.tokenOther).toSignificant(6);
  return {
    otherSymbol: st.tokenOther.symbol!,
    baseIsToken0: st.baseIsToken0,
    currentTick: st.currentTick,
    priceTokenInBase,
    poolAddress: st.poolAddress,
  };
}

export type PositionDetail = {
  tokenId: string;
  fee: number;
  otherSymbol: string;
  inRange: boolean;
  liquidity: bigint;
  baseKind: BaseKind;
  baseSymbol: string;
  baseDecimals: number;
  currentPrice: string; // harga token sekarang dalam base (formula sama dgn AddPlan.currentPrice → basis alert anjlok)
  priceLower: string; // batas bawah rentang (harga token dalam base)
  priceUpper: string; // batas atas rentang
  valueBaseWei: bigint; // nilai pokok posisi (dalam base: WETH/USDG)
  feesBaseWei: bigint; // fee belum diklaim (dalam base)
  side: 'above' | 'in' | 'below'; // harga token vs rentang (above=belum mulai, below=terkonversi penuh)
  baseAmountWei: bigint; // komposisi pokok: sisi base
  otherAmountWei: bigint; // komposisi pokok: sisi token (raw, desimal token)
  otherDecimals: number;
  otherAddress: string; // alamat token non-base
  baseIsToken0: boolean;
  currentTick: number; // tick pool saat ini (utk hitung jarak range live)
  tickLower: number;
  tickUpper: number;
};

/** Hitung nilai pokok + fee belum diklaim sebuah posisi, dalam base-nya (auto-deteksi
 *  WETH/USDG dari token pool). Posisi lama (token pasangan = WETH) → base = WETH. */
export async function getPositionDetail(
  tokenId: string,
  ctx: ChainCtx = getChain(),
): Promise<PositionDetail> {
  const { positionManager, wallet } = ctx;
  const p = await positionManager.positions(tokenId);
  const fee = Number(p.fee);
  const base = detectBase(ctx, p.token0, p.token1) ?? baseOf(ctx, 'weth');
  const baseIsToken0 = p.token0.toLowerCase() === base.address.toLowerCase();
  const liquidity = BigInt(p.liquidity);
  const tickLower = Number(p.tickLower);
  const tickUpper = Number(p.tickUpper);

  const [m0, m1] = await Promise.all([getTokenMeta(p.token0, ctx), getTokenMeta(p.token1, ctx)]);
  const poolAddress: string = await ctx.factory.getPool(p.token0, p.token1, fee);
  const pool = new ethers.Contract(
    poolAddress,
    [
      slot0Abi(ctx),
      'function liquidity() view returns (uint128)',
    ],
    ctx.provider,
  );
  const [slot0, poolLiq] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const sqrtPriceX96: bigint = slot0[0];
  const currentTick = Number(slot0[1]);

  const sdkToken0 = new Token(ctx.chainId, ethers.getAddress(p.token0), m0.decimals, m0.symbol);
  const sdkToken1 = new Token(ctx.chainId, ethers.getAddress(p.token1), m1.decimals, m1.symbol);
  const sdkPool = new Pool(sdkToken0, sdkToken1, sdkFee(fee, ctx), sqrtPriceX96.toString(), poolLiq.toString(), currentTick);
  const position = new Position({ pool: sdkPool, liquidity: liquidity.toString(), tickLower, tickUpper });

  const tokenOther = baseIsToken0 ? sdkToken1 : sdkToken0;
  const priceOther = sdkPool.priceOf(tokenOther);

  // Nilai pokok dalam base.
  const amt0 = position.amount0;
  const amt1 = position.amount1;
  const baseAmt = baseIsToken0 ? amt0 : amt1;
  const otherAmt = baseIsToken0 ? amt1 : amt0;
  const baseAmountWei = BigInt(baseAmt.quotient.toString());
  const otherAmountWei = BigInt(otherAmt.quotient.toString());
  const valueBaseWei = baseAmountWei + BigInt(priceOther.quote(otherAmt).quotient.toString());

  // Fee belum diklaim: collect.staticCall memicu update fee lalu mengembalikan jumlahnya.
  let feesBaseWei = 0n;
  try {
    const owed = await positionManager.collect.staticCall({
      tokenId,
      recipient: wallet.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    const owedBase = baseIsToken0 ? BigInt(owed[0]) : BigInt(owed[1]);
    const owedOther = baseIsToken0 ? BigInt(owed[1]) : BigInt(owed[0]);
    feesBaseWei = owedBase;
    if (owedOther > 0n) {
      const oa = CurrencyAmount.fromRawAmount(tokenOther, owedOther.toString());
      feesBaseWei += BigInt(priceOther.quote(oa).quotient.toString());
    }
  } catch {
    /* biarkan fee 0 kalau simulasi gagal */
  }

  // Arah dalam istilah HARGA TOKEN: tergantung sisi base di pool.
  const inR = currentTick >= tickLower && currentTick < tickUpper;
  let side: 'above' | 'in' | 'below' = 'in';
  if (!inR) {
    if (baseIsToken0) side = currentTick < tickLower ? 'above' : 'below';
    else side = currentTick >= tickUpper ? 'above' : 'below';
  }

  return {
    tokenId,
    fee,
    otherSymbol: tokenOther.symbol!,
    inRange: inR,
    side,
    liquidity,
    baseKind: base.kind,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    currentPrice: priceOther.toSignificant(8),
    // Batas rentang dalam harga token (kartu /positions menampilkan target range).
    priceLower: tickToPrice(tokenOther, baseIsToken0 ? sdkToken0 : sdkToken1, tickLower).toSignificant(6),
    priceUpper: tickToPrice(tokenOther, baseIsToken0 ? sdkToken0 : sdkToken1, tickUpper).toSignificant(6),
    valueBaseWei,
    feesBaseWei,
    baseAmountWei,
    otherAmountWei,
    otherDecimals: tokenOther.decimals,
    otherAddress: baseIsToken0 ? p.token1 : p.token0,
    baseIsToken0,
    currentTick,
    tickLower,
    tickUpper,
  };
}
