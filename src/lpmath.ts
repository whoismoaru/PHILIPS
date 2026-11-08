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

/**
 * Width of the PRICE BAND tolerated when withdrawing liquidity: 3%, the same limit as
 * slippage and price impact everywhere else.
 *
 * It was 0.5%. On 23 Sep 2026 a BSC v4 close passed its simulation, then
 * the token moved more than 0.5% in the ~1s before inclusion and the burn reverted with
 * MinimumAmountInsufficient (it landed at once on the high gas price, so the
 * gas was not the problem). The retry at a fresh price succeeded 9s later. A meme token
 * moves 0.5% between two blocks routinely; 3% still stops a sandwich that would push the
 * price to a range edge.
 */
export const WITHDRAW_BAND_BPS = 300n;

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
 * long as liquidity is fixed. So the floor comes from a PRICE BAND of +/-3% (WITHDRAW_BAND_BPS) —
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
  const lower = amountsForLiquidity(shiftSqrt(sqrtP, 10_000n - WITHDRAW_BAND_BPS), sqrtA, sqrtB, liquidity);
  const upper = amountsForLiquidity(shiftSqrt(sqrtP, 10_000n + WITHDRAW_BAND_BPS), sqrtA, sqrtB, liquidity);
  const smaller = (a: bigint, b: bigint) => (a < b ? a : b);
  const floor = (v: bigint) => (v * (10_000n - ROUNDING_BPS)) / 10_000n;
  return {
    min0: floor(smaller(lower.amount0, upper.amount0)),
    min1: floor(smaller(lower.amount1, upper.amount1)),
  };
}

/**
 * Where a single-sided base range sits, in ticks: `near` is the edge closest to the price,
 * `far` the edge furthest from it. The base as token0 puts the range ABOVE the current
 * tick (a rising tick is a falling token price), the base as token1 puts it BELOW.
 *
 * Without `target` the near edge is flush against the current price: the first spacing
 * multiple strictly past it. With `target` (a limit entry: the target price as a raw tick,
 * see tickAtRatio) the range hangs from the target as if the price were already there, so
 * the position starts buying only at the target. Both edges are fixed by the target, which
 * is what keeps a limit from being dragged: if the price has already passed the target the
 * near edge falls back to flush, but the far edge stays `width` past the target.
 */
export function rangeEdges(
  current: number,
  spacing: number,
  baseIsToken0: boolean,
  width: number,
  target?: number,
): { near: number; far: number } {
  const flush = (t: number) => {
    if (baseIsToken0) {
      const up = Math.ceil(t / spacing) * spacing;
      return up <= t ? up + spacing : up;
    }
    const down = Math.floor(t / spacing) * spacing;
    return down >= t ? down - spacing : down;
  };
  const dir = baseIsToken0 ? 1 : -1;
  const now = flush(current);
  if (target === undefined) return { near: now, far: now + dir * width };
  const at = flush(target);
  const near = baseIsToken0 ? Math.max(now, at) : Math.min(now, at);
  const far = at + dir * width;
  if ((far - near) * dir < spacing) throw new Error('The price has already fallen through the whole range of this limit entry.');
  return { near, far };
}

/**
 * The raw tick at which the token's price is `ratio` times what it is at `current`.
 * The token price per base is 1.0001^(sgn*tick), sgn = -1 when the base is token0, the
 * same convention as monitor.ts dropPctFromTick.
 */
export function tickAtRatio(current: number, baseIsToken0: boolean, ratio: number): number {
  return current + ((baseIsToken0 ? -1 : 1) * Math.log(ratio)) / Math.log(1.0001);
}
