import { ethers } from 'ethers';
import sdkCore from '@uniswap/sdk-core';
import {
  Pool,
  Position,
  TICK_SPACINGS,
  TickMath,
  nearestUsableTick,
  tickToPrice,
  type FeeAmount,
} from '@uniswap/v3-sdk';
import type { Token as TToken } from '@uniswap/sdk-core';
import type { Pool as TPool, Position as TPosition } from '@uniswap/v3-sdk';
// The Uniswap SDK is still CommonJS, so import the default and unpack it.
const { Token, Percent, CurrencyAmount } = sdkCore;

// The Uniswap SDK does not know fee tier 2500 (a PancakeSwap v3 speciality):
// Pool.tickSpacing returns undefined, and the Position invariant then fails or the
// range width comes out NaN. Register the spacing once here — the number is verified
// on-chain via factory.feeAmountTickSpacing(2500) = 50.
(TICK_SPACINGS as Record<number, number>)[2500] = 50;
import { ERC20_ABI, approveExact } from './chain.js';
import { sendTxNonceSafe, isGoneErr } from './core.js';
import { withdrawFloors } from './lpmath.js';
import { getChain, baseOf, basesFor, detectBase, type ChainCtx, type BaseAsset, type BaseKind } from './chains.js';

const MAX_UINT128 = (1n << 128n) - 1n;
const SLIPPAGE = new Percent(50, 10_000); // 0.5%

/** Valid Uniswap v3 fee tiers. */
/** A fee tier's tick spacing on this chain. Throws when the tier is unregistered:
 *  better to stop than to compute a range width with `undefined` spacing (NaN gives
 *  garbage ticks). */
function spacingOf(fee: number, ctx: ChainCtx): number {
  const s = ctx.tickSpacing[fee] ?? TICK_SPACINGS[fee as FeeAmount];
  if (!s) throw new Error(`Fee tier ${fee} is not available on ${ctx.label}.`);
  return s;
}

/** The fee value for Uniswap SDK objects. Slipstream uses arbitrary tick spacings
 *  absent from the SDK's TICK_SPACINGS, so force 100 (spacing 1). Token-amount maths
 *  does NOT use tickSpacing, and our ticks (multiples of the real spacing) are still
 *  multiples of 1, so the Position invariant (tick % spacing === 0) holds and the
 *  amounts stay correct. */
const sdkFee = (fee: number, ctx: ChainCtx): FeeAmount => (ctx.slipstream ? 100 : fee) as FeeAmount;

/** The slot0() fragment. Velodrome Slipstream's CLPool returns 6 fields (without
 *  Uniswap v3's `feeProtocol uint8`), so a 7-field decode fails. Both put
 *  sqrtPriceX96 at [0] and tick at [1], so the reading code is unchanged. */
const slot0Abi = (ctx: ChainCtx): string =>
  ctx.slipstream
    ? 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)'
    : 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)';

// Per-chain token metadata cache (the same address can exist on several chains).
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

/** Turn a token address into an SDK Token object (needs decimals and symbol). */
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

/** Read the base/token pool's on-chain state and build an SDK Pool object. */
export async function loadPool(
  tokenAddress: string,
  fee: number,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<PoolState> {
  // The fee tier and tick spacing belong to the CHAIN: PancakeSwap uses 2500
  // (spacing 50) and has no 3000 at all. Using Uniswap's table there gives a NaN width.
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

/** Convert a range width (a percentage FALL in token price) into ticks.
 *  Target: the far edge is exactly X% down. factor = 1 - X/100, so
 *  width = |ln(1-X/100)| / ln(1.0001). Rounded OUTWARD (ceil) to a multiple of the
 *  spacing, so the range covers at least the X% asked for. */
function widthInTicks(rangePercent: number, spacing: number): number {
  const frac = Math.min(Math.max(rangePercent, 0.1), 95) / 100;
  const raw = Math.abs(Math.log(1 - frac)) / Math.log(1.0001);
  return Math.max(spacing, Math.ceil(raw / spacing) * spacing);
}

/** Range width for an X% price RISE: width = ln(1+X/100)/ln(1.0001). */
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
  currentPrice: string; // the token's current price, denominated in the base
  pctLow: number; // the far end as a % of the current price (the most negative)
  pctHigh: number; // the near end as a % of the current price
  side: 'base' | 'token'; // the asset being deposited
  tokenAmountWei: bigint; // the token-side deposit (0 on the base side)
  tokenDecimals: number;
  position: TPosition;
};

/**
 * Plan a SINGLE-SIDED position (base only: WETH or USDG):
 *  - base = token0 means the range must sit ABOVE the current price;
 *  - base = token1 means it must sit BELOW.
 * Either way the other token is needed in ~zero quantity. The base amount uses
 * parseUnits(base.decimals), which is MANDATORY (USDG has 6, WETH has 18).
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
    // A range ABOVE the current tick needs only token0 (the base). Take the nearest
    // spacing multiple above current (ceil) to sit tight against the price.
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
    // A range BELOW the current tick needs only token1 (the base).
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

  // The token price (in base terms) at both range edges, for display.
  const pLower = tickToPrice(st.tokenOther, st.sdkBase, tickLower).toSignificant(6);
  const pUpper = tickToPrice(st.tokenOther, st.sdkBase, tickUpper).toSignificant(6);
  const [priceLower, priceUpper] =
    Number(pLower) <= Number(pUpper) ? [pLower, pUpper] : [pUpper, pLower];

  // The range as a percentage relative to the token's current price.
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

/** Ladder capital distribution. spot spreads evenly; bidask concentrates at the furthest (lowest) price. */
export type LadderShape = 'spot' | 'bidask';

/** Per-leg weights (index 0 nearest the price, N-1 furthest down). They sum to 1. */
export function ladderWeights(n: number, shape: LadderShape): number[] {
  if (n <= 1) return [1];
  // bidask is linear: weight scales with (index+1), so the furthest leg is heaviest. spot is even.
  const raw = shape === 'bidask' ? Array.from({ length: n }, (_, i) => i + 1) : Array.from({ length: n }, () => 1);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * Plan a single-sided LADDER on the BASE side (buy-the-dip): split the range [now
 * ... -X%] into N adjacent legs, each its own concentrated position with weighted
 * capital. spot spreads capital evenly; bidask puts more of it at lower prices. Each
 * leg is a full AddPlan, minted through the ordinary executeAdd (one tokenId per leg,
 * tied together by groupId in the store). Base side only — the token side stays a
 * single SPOT position.
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
  // Auto-cap: every leg needs at least one tick spacing. A coarse pool (large
  // spacing) cannot fit many legs in the range, so N is cut to the spacings
  // available (max 69).
  const maxLegs = Math.max(1, Math.floor(fullWidth / spacing));
  const n = Math.max(1, Math.min(legs, 69, maxLegs));
  // Each leg's width is its share of the spacings, at least one spacing.
  const legWidth = Math.max(spacing, Math.round(fullWidth / n / spacing) * spacing);
  const weights = ladderWeights(n, shape);
  const totalWei = ethers.parseUnits(totalAmount, base.decimals);
  const currentPrice = st.sdkPool.priceOf(st.tokenOther).toSignificant(8);
  const cur = Number(currentPrice);

  // The anchor tick (flush against the current price), same as planAddSingleSided.
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
  // Leg capital is weight x total; the last leg sweeps the remainder to avoid rounding dust.
    const legWei = k === n - 1 ? totalWei - allocated : (totalWei * BigInt(Math.round(weights[k] * 1e9))) / 1_000_000_000n;
    allocated += legWei;

    let tickLower: number;
    let tickUpper: number;
    let position: TPosition;
    if (st.baseIsToken0) {
      // Range ABOVE: the further leg k goes up, the further the token price falls.
      tickLower = anchor + k * legWidth;
      tickUpper = tickLower + legWidth;
      position = Position.fromAmount0({ pool: st.sdkPool, tickLower, tickUpper, amount0: legWei.toString(), useFullPrecision: true });
    } else {
      // Range BELOW: the further leg k goes down, the further the token price falls.
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
 * Plan a SINGLE-SIDED position on the TOKEN side: deposit the token alone into a
 * range ABOVE the current price. It behaves like a passive limit sell — the token
 * converts gradually into base as price rises through the range, harvesting fees on
 * the way.
 *
 * A mirror of planAddSingleSided with the tick side reversed, because a position
 * holds 100% token0 when price is BELOW its range and 100% token1 when price is
 * ABOVE it.
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
    // Token is token1, so the position must hold only token1: range BELOW the tick.
    let upper = Math.floor(st.currentTick / spacing) * spacing;
    if (upper >= st.currentTick) upper -= spacing;
    tickUpper = upper;
    tickLower = upper - width;
    position = Position.fromAmount1({ pool: st.sdkPool, tickLower, tickUpper, amount1: tokenWei.toString() });
  } else {
    // Token is token0, so the position must hold only token0: range ABOVE the tick.
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

/** Make sure the BASE balance and the Position Manager allowance are both in place.
 *  WETH (wrappable): wrap native ETH as needed. USDG (non-wrappable): must already be
 *  held, since it cannot be wrapped. Every amount is formatted with base.decimals. */
/** Estimated gas units to open an LP (wrap + approve + mint). Also used by the cost preview. */
export const ADD_GAS_UNITS = 700_000n;

/**
 * Gas reserve when wrapping. This used to be a flat 0.0005 ETH, which on an
 * expensive chain is 10x too small: ETH went entirely into the wrap, the mint then
 * failed with "insufficient funds", and the money sat trapped as WETH. It is now
 * derived from the real gas price (+20% headroom), keeping the old value as a floor.
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
    /* fall back to the floor */
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
      // USDG and friends: ordinary ERC20s that must ALREADY be in the wallet.
      throw new Error(
        `Not enough ${base.symbol} on ${ctx.label}: need ${ethers.formatUnits(amountWei, base.decimals)}, ` +
          `available ${ethers.formatUnits(bal, base.decimals)}. ${base.symbol} cannot be wrapped from ETH — ` +
          `top up with ${base.symbol} first, or lower the amount.`,
      );
    }
    // WETH: wrap native ETH as needed, keeping the gas reserve intact.
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
    // RPCs often have not refreshed the balance right after a tx lands. Re-read a few
    // times BEFORE concluding there is a shortfall: a stale read of 0 used to trigger
    // a SECOND wrap of the FULL amountWei — but the ETH had already gone into the
    // first wrap, so the node refused with "insufficient funds" and the entire wrapped
    // amount was left behind as WETH. It happened on 2 Aug 2026: 0.12 WETH stranded.
    for (let i = 0; i < 5 && bal < amountWei; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      bal = await baseC.balanceOf(wallet.address);
    }
    if (bal < amountWei) {
      // Only the shortfall, and only when the remaining ETH actually covers it.
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

/** Make sure an ERC20 (an ordinary token) balance and Position Manager approval are
 *  in place. No wrapping here: an ordinary token has to be held already. */
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

/** Execute a single-sided LP add. Returns the new position's tokenId plus notes. */
export async function executeAdd(
  plan: AddPlan,
  tokenAddress: string,
  fee: number,
  ctx: ChainCtx = getChain(),
): Promise<{ tokenId: string; notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const base = baseOf(ctx, plan.baseKind);
  // Token side: it is the token that needs preparing, not the base (nothing is wrapped).
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
    // Slipstream: mint needs a sqrtPriceX96 (0 means the pool exists, do not create
    // one). The `fee` field in these params is the tickSpacing (Slipstream's ABI calls
    // it `fee`). Uniswap v3's ABI ignores the extra key, so it is safe to always set.
    ...(ctx.slipstream ? { sqrtPriceX96: 0n } : {}),
  };

  let receipt;
  try {
    const tx = await positionManager.mint(params);
    receipt = await tx.wait();
  } catch (e) {
    // STF means the base transfer failed (balance or allowance). Recover once, then retry.
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

  // The tokenId is read from the Transfer(0x0 -> wallet) event in the mint's own
  // receipt. Do NOT use tokenOfOwnerByIndex(bal-1): ERC721 index order shifts when
  // another NFT is burned, which once left a record pointing at an older NFT.
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
    // Last-ditch fallback (should never happen).
    notes.push('⚠️ Mint event not found in receipt — falling back to last index.');
    const bal: bigint = await positionManager.balanceOf(wallet.address);
    tokenId = BigInt(await positionManager.tokenOfOwnerByIndex(wallet.address, bal - 1n));
  }
  return { tokenId: tokenId!.toString(), notes };
}

/** Legs per multicall, kept under the block gas limit (~400k gas per mint). */
export const MAX_LEGS_PER_MULTICALL = 25;

/**
 * BATCH mint a ladder through multicall: N legs (base side) in ONE atomic tx per
 * chunk. Approve and wrap the base ONCE for the total, then multicall([mint,mint,...]).
 * This closes v3's "N transactions" weakness — 69 legs become ~3 txs at a chunk size
 * of 25, not 69. Each leg's tokenId is read from the consecutive
 * Transfer(0x0 -> wallet) events in the receipt.
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
    // PRE-FLIGHT: simulate the multicall first (balance and approval are already in
    // place from ensureBaseReady above). If any leg is going to revert, it fails HERE
    // with the real reason — not an opaque 'require(false)' on send — and BEFORE any
    // tx goes out.
    try {
      await positionManager.multicall.staticCall(calls);
    } catch (e) {
      throw new Error(`Ladder batch would revert (${chunk.length} legs): ${(e as Error).message.slice(0, 140)}`);
    }
    const tx = await sendTxNonceSafe(wallet as ethers.Wallet, await positionManager.multicall.populateTransaction(calls));
    const receipt = await tx.wait();
    if (!receipt) throw new Error('batch mint tx has no receipt');
    // Every Transfer(0x0 -> wallet) in the receipt is one leg's tokenId, in execution order.
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
 * BATCH remove+collect+burn a ladder through multicall: every leg is emptied and
 * burned in roughly one tx per chunk. The assets (base plus token) land in the
 * wallet; the caller does the token->base swap ONCE in aggregate, not per leg.
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

    /**
     * Build the multicall with FRESHLY COMPUTED price floors.
     *
     * Split into its own function so it can be repeated: the floor is derived from
     * the price at that moment, and on a fast-moving token the price can have moved
     * on before the simulation finishes. Rebuilding uses the newest price; it does
     * NOT loosen the floor.
     */
    const build = async () => {
      const deadline = Math.floor(Date.now() / 1000) + 600;
      // Legs are computed in PARALLEL. They used to run in series: 8 legs x
      // (staticCall + retry) could take seconds, and every bit of that delay widened
      // the gap between the price the floor used and the price at simulation time —
      // exactly what triggered "Price slippage check".
      const parts = await Promise.all(
        chunk.map(async (tokenId) => {
          // A leg already gone (reverting 'Invalid token ID') is SKIPPED. Only that
          // revert: a read failing on a dropped RPC once had the bot report "closed"
          // without sending a single tx (28 Aug 2026), so every other failure MUST
          // be rethrown.
          let liquidity: bigint;
          try {
            liquidity = BigInt((await positionManager.positions(tokenId)).liquidity);
          } catch (e) {
            if (isGoneErr(e)) return null;
            throw new Error(
              `Could not read position #${tokenId} (${(e as Error).message.slice(0, 80)}). ` +
                'Nothing was closed. Try again when the network settles.',
            );
          }
          const calls: string[] = [];
          const legNotes: string[] = [];
          if (liquidity > 0n) {
            const { unprotected, ...mins } = await withdrawMins(positionManager, tokenId, liquidity, deadline, ctx);
            if (unprotected) legNotes.push(WITHDRAW_UNPROTECTED_NOTE(tokenId));
            calls.push(iface.encodeFunctionData('decreaseLiquidity', [{ tokenId, liquidity, ...mins, deadline }]));
          }
          calls.push(
            iface.encodeFunctionData('collect', [
              { tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
            ]),
          );
          calls.push(iface.encodeFunctionData('burn', [tokenId]));
          return { calls, legNotes };
        }),
      );
      const live = parts.filter((p): p is NonNullable<typeof p> => p !== null);
      return {
        calls: live.flatMap((p) => p.calls),
        legNotes: live.flatMap((p) => p.legNotes),
        live: live.length,
      };
    };

    let built = await build();
    if (built.calls.length === 0) {
      // Reaching here means EVERY leg genuinely reverted with 'Invalid token ID'.
      // Read failures were rethrown above, so these really are already closed.
      notes.push('Batch close: all legs already closed on-chain.');
      continue;
    }

    // PRE-FLIGHT: simulate first, so a failure comes with its real reason before any
    // tx is sent. A revert on the price floor is NOT a reason to give up: the price
    // moved, nothing is wrong. Rebuild with the newest price and retry, up to 3 times.
    const MAX_REBUILD = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        await positionManager.multicall.staticCall(built.calls);
        break;
      } catch (e) {
        const emsg = (e as Error).message ?? '';
        const movedPrice = /price slippage check/i.test(emsg);
        if (!movedPrice || attempt >= MAX_REBUILD) {
          throw new Error(
            movedPrice
              ? `Price moved faster than the withdrawal floor could be set (${built.live} legs), so nothing was sent. ` +
                'Your positions are untouched — try again in a moment.'
              : `Ladder close batch would revert (${built.live} legs): ${emsg.slice(0, 140)}`,
          );
        }
        console.log(`[close batch] the price floor was missed (attempt ${attempt}/${MAX_REBUILD}), rebuilding`);
        built = await build();
      }
    }

    notes.push(...built.legNotes);
    const tx = await sendTxNonceSafe(wallet as ethers.Wallet, await positionManager.multicall.populateTransaction(built.calls));
    const receipt = await tx.wait();
    notes.push(`Batch close ${built.live} legs (tx ${receipt?.hash ?? tx.hash})`);
  }
  return { notes };
}

export type PositionInfo = {
  tokenId: string;
  token0: string; // the address, used to detect base/ca during a sync
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  inRange: boolean;
};

/** Every LP position the bot's wallet holds (per chain). */
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
      /* leave inRange false when the pool cannot be read */
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
 * Harvest fees WITHOUT closing the position: `collect` alone, no decreaseLiquidity
 * and no burn. What comes out is the unclaimed fees; the principal stays in the pool.
 * Returns raw token0/token1 amounts plus the tx hash.
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
  // staticCall first: the number reported to the user has to be the number that will
  // actually be withdrawn, not a guess carried over from an earlier card.
  const owed = await positionManager.collect.staticCall(params);
  const tx = await positionManager.collect(params);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, amount0: BigInt(owed[0]), amount1: BigInt(owed[1]) };
}

/**
 * Withdraw PART of the liquidity (1-99%) and collect. The position is NOT burned and
 * stays alive — used by the 25/50/75% partial withdrawals. For 100% use executeRemove
 * (burn + journal + cash-out), so there are never two closing paths that can diverge.
 */
/**
 * Slippage floor for decreaseLiquidity.
 *
 * amount0Min/amount1Min are the ONLY price protection decreaseLiquidity has. At 0 a
 * withdrawal can be sandwiched: price is pushed to a range edge, the position exits
 * ~100% as the asset being suppressed, and price is then restored — with the tx still
 * reporting success, so nothing flags it.
 *
 * The expected amounts come from the pool price, and the floor from a price band
 * around it. If price is shoved between the read and execution, the tx REVERTS —
 * which is the right outcome: burnt gas is far cheaper than closing at an arbitrary
 * price.
 */
/** The FALLBACK floor (a per-side percentage), used only when the pool price cannot
 *  be read. Deliberately loose: this path has no position ticks, so a tight threshold
 *  would fail healthy withdrawals — exactly the bug just fixed. */
const WITHDRAW_FALLBACK_BPS = 200n; // 2%

/** Note attached to the close card when a withdrawal had to run without a price floor. */
const WITHDRAW_UNPROTECTED_NOTE = (tokenId: string) =>
  `⚠️ #${tokenId} withdrawn WITHOUT a price floor — the pool could not be priced, so sandwich protection was off for this close.`;

/** Expected token0/token1 out of burning `liquidity`, computed from the CURRENT POOL
 *  PRICE via the SDK (no decreaseLiquidity simulation). Also supplies the price band
 *  its floors are built from. */
async function expectedBurnAmounts(
  tokenId: string,
  liquidity: bigint,
  ctx: ChainCtx,
): Promise<{ amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; sqrtLower: bigint; sqrtUpper: bigint }> {
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
  return {
    amount0: BigInt(pos.amount0.quotient.toString()),
    amount1: BigInt(pos.amount1.quotient.toString()),
    // Ingredients for the price-band floor: the current pool price plus both range edges.
    sqrtPriceX96: BigInt(slot0[0].toString()),
    sqrtLower: BigInt(TickMath.getSqrtRatioAtTick(Number(p.tickLower)).toString()),
    sqrtUpper: BigInt(TickMath.getSqrtRatioAtTick(Number(p.tickUpper)).toString()),
  };
}

async function withdrawMins(
  positionManager: ethers.Contract,
  tokenId: string,
  liquidity: bigint,
  deadline: number,
  ctx: ChainCtx,
): Promise<{ amount0Min: bigint; amount1Min: bigint; unprotected: boolean }> {
  // Retry: the most common read failure is TRANSIENT (a momentarily grumpy RPC), and
  // not a reason to withdraw unprotected. Try 3 times before giving up.
  //
  // The floor comes from a PRICE BAND rather than a percentage off the current
  // amounts — see `withdrawFloors`. The old way failed in narrow ranges on entirely
  // ordinary price movement (0.2% was enough), and v4 hit exactly that until closes
  // failed over and over.
  for (let i = 0; i < 3; i++) {
    try {
      const exp = await expectedBurnAmounts(tokenId, liquidity, ctx);
      const f = withdrawFloors(exp.sqrtPriceX96, exp.sqrtLower, exp.sqrtUpper, liquidity);
      return { amount0Min: f.min0, amount1Min: f.min1, unprotected: false };
    } catch {
      if (i < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
  try {
    // Fallback: let the PM itself supply the amounts. Without the position's ticks a
    // price band cannot be computed here, so a percentage is used — and deliberately
    // a LOOSER one (2%), so the fallback path does not fail withdrawals the way the
    // old floor did. It only runs when the pool read has failed three times running.
    const [a0, a1] = await positionManager.decreaseLiquidity.staticCall({ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline });
    const longgar = (v: bigint) => (BigInt(v) * (10_000n - WITHDRAW_FALLBACK_BPS)) / 10_000n;
    console.log(`[withdraw] the pool price could not be read, using the loose staticCall floor (#${tokenId})`);
    return { amount0Min: longgar(a0), amount1Min: longgar(a1), unprotected: false };
  } catch {
    // Genuinely uncomputable: do not block the withdrawal (the user's funds outrank
    // the MEV risk). This is the ONLY path that withdraws without a price floor. It
    // used to go to the server log alone, so positions were closed without anyone
    // knowing that round was unprotected. `unprotected` is carried up so it lands on
    // the close card.
    console.log(`[withdraw] ⚠️ no slippage floor available (#${tokenId}), withdrawing without price protection`);
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

  // Integer division: the remainder stays in the pool, it is not lost.
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

/** Withdraw ALL liquidity, collect the tokens, then burn the NFT.
 *  Handles an empty position (zero liquidity): skip the decrease, go straight to
 *  collect and burn. */
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
  baseReserve: bigint; // the base held in the pool, a proxy for liquidity depth
};

/** base/token pools across every fee tier, deepest (by base reserve) first. */
async function poolsForBase(
  tokenAddress: string,
  base: BaseAsset,
  ctx: ChainCtx,
): Promise<PoolOption[]> {
  const baseC = base.wrappable ? ctx.weth : new ethers.Contract(base.address, ERC20_ABI, ctx.provider);
  // Every fee tier checked at once (RPC round-trips run in parallel, plus ethers auto-batching).
  const perFee = await Promise.all(
    ctx.feeTiers.map(async (fee): Promise<PoolOption | null> => {
      const poolAddress: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) return null;
      // This used to call priceInfo (a full loadPool) per fee tier just to fill
      // fields nobody ever read: ~55 RPCs wasted on every discovery.
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

/** The WETH/token pool — used on money paths (swap fallback, USD holdings valuation). */
export async function discoverPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  return poolsForBase(tokenAddress, baseOf(ctx, 'weth'), ctx);
}

/** Pools for EVERY base (WETH plus USDG when available) — used by the /add wizard. */
export async function discoverAllPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  const perBase = await Promise.all(basesFor(ctx).map((b) => poolsForBase(tokenAddress, b, ctx)));
  return perBase.flat();
}


/** Price and base-side info for a pool. */
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
  currentPrice: string; // the token's current price in the base; the same formula as AddPlan.currentPrice, which the drop alert builds on
  priceLower: string; // the lower bound of the range, as a token price in the base
  priceUpper: string; // the upper bound of the range
  valueBaseWei: bigint; // the position's principal value, in the base: WETH or USDG
  feesBaseWei: bigint; // unclaimed fees, in the base
  side: 'above' | 'in' | 'below'; // the token price against the range: above means not started, below means fully converted
  baseAmountWei: bigint; // komposisi pokok: sisi base
  otherAmountWei: bigint; // komposisi pokok: sisi token (raw, desimal token)
  otherDecimals: number;
  otherAddress: string; // alamat token non-base
  baseIsToken0: boolean;
  currentTick: number; // the pool's current tick, used for the live range distance
  tickLower: number;
  tickUpper: number;
};

/** A position's principal plus unclaimed fees, in its own base (WETH/USDG detected
 *  automatically from the pool's tokens). An older position paired with WETH gets
 *  base = WETH. */
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

  // Principal value in base terms.
  const amt0 = position.amount0;
  const amt1 = position.amount1;
  const baseAmt = baseIsToken0 ? amt0 : amt1;
  const otherAmt = baseIsToken0 ? amt1 : amt0;
  const baseAmountWei = BigInt(baseAmt.quotient.toString());
  const otherAmountWei = BigInt(otherAmt.quotient.toString());
  const valueBaseWei = baseAmountWei + BigInt(priceOther.quote(otherAmt).quotient.toString());

  // Unclaimed fees: collect.staticCall triggers a fee update and returns the amounts.
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
    /* leave fees at 0 when the simulation fails */
  }

  // Direction in TOKEN PRICE terms, which depends on which side the base sits on.
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
    // Range bounds in token price (the /positions card shows the target range).
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
