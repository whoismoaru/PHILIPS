/**
 * Concentrated-liquidity maths shared by v3 and v4.
 *
 * Kept standalone (no RPC, no ChainCtx) for two reasons: it can be tested
 * directly, and uniswap.ts no longer has to import uniswapV4.ts just to reach
 * formulas that belong to both.
 */

const Q96 = 1n << 96n;

function amount0Delta(a: bigint, b: bigint, L: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  if (a === 0n) return 0n;
  return (((L << 96n) * (b - a)) / b) / a;
}

function amount1Delta(a: bigint, b: bigint, L: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (L * (b - a)) / Q96;
}

/** A position's token0/token1 amounts at price `sqrtP`. */
export function amountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  L: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return { amount0: amount0Delta(sqrtA, sqrtB, L), amount1: 0n };
  if (sqrtP < sqrtB) return { amount0: amount0Delta(sqrtP, sqrtB, L), amount1: amount1Delta(sqrtA, sqrtP, L) };
  return { amount0: 0n, amount1: amount1Delta(sqrtA, sqrtB, L) };
}

/** Width of the PRICE BAND tolerated when withdrawing liquidity (0.5%). */
export const WITHDRAW_BAND_BPS = 50n;

/** Integer-rounding cushion; without it a floor can land 1 wei too high. */
const ROUNDING_BPS = 1n;

/** Integer square root (Newton). */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrtPriceX96 at price x (bps/10000). Price moves, its root moves by the root. */
const SQRT_SCALE = 1_000_000n;
export const shiftSqrt = (sqrtP: bigint, bps: bigint): bigint =>
  (sqrtP * isqrt((bps * SQRT_SCALE * SQRT_SCALE) / 10_000n)) / SQRT_SCALE;

/**
 * amount0Min/amount1Min for a liquidity withdrawal, v3 and v4 alike.
 *
 * The OLD way, and why it broke: `min = current_amount x 99.5%` applied to BOTH
 * sides at once. For concentrated liquidity that guards the wrong thing. Each
 * side's amount moves far faster than price does, so in a narrow range a
 * perfectly ordinary 0.2% price move already cuts one side by more than 0.5% —
 * `MinimumAmountInsufficient` fires with no attack anywhere in sight. Worse, a
 * per-side floor pins COMPOSITION, which is meant to move, instead of VALUE.
 *
 * The way it works now: token amounts are a deterministic function of price as
 * long as liquidity is fixed. So the floor comes from a PRICE BAND of +/-0.5% —
 * compute the amounts at both edges and take the smaller of each side. Since
 * amount0 falls as price rises and amount1 rises with it, that lands on amount0
 * at the upper edge and amount1 at the lower one. Ordinary movement inside the
 * band passes; shoving the price outside it, which is the attacker's actual
 * tool, still gets rejected.
 */
export function withdrawFloors(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { min0: bigint; min1: bigint } {
  // Amounts are monotonic in price, so each side's minimum has to sit at one of
  // the band's edges. Two points is enough; no need to sweep.
  const bawah = amountsForLiquidity(shiftSqrt(sqrtP, 10_000n - WITHDRAW_BAND_BPS), sqrtA, sqrtB, liquidity);
  const atas = amountsForLiquidity(shiftSqrt(sqrtP, 10_000n + WITHDRAW_BAND_BPS), sqrtA, sqrtB, liquidity);
  const kecil = (a: bigint, b: bigint) => (a < b ? a : b);
  const floor = (v: bigint) => (v * (10_000n - ROUNDING_BPS)) / 10_000n;
  return {
    min0: floor(kecil(bawah.amount0, atas.amount0)),
    min1: floor(kecil(bawah.amount1, atas.amount1)),
  };
}
