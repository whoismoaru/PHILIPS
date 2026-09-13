import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';
import { approveExact } from './chain.js';
import { NATIVE, SLIP_MAX_PCT, lifiPreferred, relayQuoteOut, slipLadder, swapTokenViaRelay } from './relay.js';
import { lifiQuoteOut, swapViaLifi } from './lifi.js';

/**
 * A generic exact-in swap from -> to (ERC20 -> ERC20) over the BEST route:
 *   1. Quote Uniswap (its deepest pool) and Relay (an aggregator), take the higher output.
 *   2. Execute that route; if it fails, fall through to the others.
 *
 * The safety rules hold throughout: minOut comes from the quoter and is never 0, the
 * balance is verified to have really moved, and the fallback chain is complete. This is
 * the BUY side (base -> token); the sell side keeps the proven swapTokenTo{Eth,Usdg}Robust.
 */

// The struct shape follows the chain: PancakeSwap (the original v3 SwapRouter) takes a
// `deadline`, Uniswap's SwapRouter02 does not. The wrong shape reverts with no data.
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const ROUTER_ABI_DEADLINE = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];

const bal = (token: string, ctx: ChainCtx): Promise<bigint> =>
  new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], ctx.provider)
    .balanceOf(ctx.wallet.address) as Promise<bigint>;

// LI.FI is the PRIMARY router. It is used as long as its rate is no worse than the best
// alternative by more than LIFI_TOL, and its quote arrives inside LIFI_TIMEOUT_MS. Worse
// or slower, and the best-of between Relay and Uniswap takes over.
const LIFI_TIMEOUT_MS = 12_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
/** An exact-in Uniswap quote in the deepest from/to pool. null when there is no pool. */
export async function quoteUniswap(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ out: bigint; fee: number } | null> {
  // Pick the fee tier holding the largest `to` reserve, which is the deepest one.
  const toC = new ethers.Contract(toAddr, ['function balanceOf(address) view returns (uint256)'], ctx.provider);
  let bestFee = 0;
  let bestReserve = -1n;
  await Promise.all(
    ctx.feeTiers.map(async (fee) => {
      try {
        const pool: string = await ctx.factory.getPool(fromAddr, toAddr, fee);
        if (!pool || pool === ethers.ZeroAddress) return;
        const r: bigint = await toC.balanceOf(pool);
        if (r > bestReserve) {
          bestReserve = r;
          bestFee = fee;
        }
      } catch {
        /* no pool at this fee tier */
      }
    }),
  );
  if (bestReserve < 0n) return null;
  try {
    const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, ctx.wallet);
    const q = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: fromAddr,
      tokenOut: toAddr,
      amountIn: amountInWei,
      fee: bestFee,
      sqrtPriceLimitX96: 0n,
    });
    const out = BigInt(q[0]);
    return out > 0n ? { out, fee: bestFee } : null;
  } catch {
    return null;
  }
}

/** The best output across Uniswap, Relay and LI.FI, for the preview card. null if none quote. */
export async function previewSwapOut(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ route: 'uniswap' | 'relay' | 'lifi'; out: bigint } | null> {
  const [uni, relay, lifi] = await Promise.all([
    quoteUniswap(fromAddr, toAddr, amountInWei, ctx),
    relayQuoteOut(fromAddr, toAddr, amountInWei, ctx),
    withTimeout(lifiQuoteOut(fromAddr, toAddr, amountInWei, ctx), LIFI_TIMEOUT_MS),
  ]);
  const uniOut = uni?.out ?? 0n;
  const rOut = relay ?? 0n;
  const lOut = lifi ?? 0n;
  const bestOther = uniOut > rOut ? uniOut : rOut;
  // LI.FI leads while its rate holds up; worse or slower, the best-of takes over.
  if (lifiPreferred(lOut, bestOther)) return { route: 'lifi', out: lOut };
  const cands: Array<{ route: 'uniswap' | 'relay' | 'lifi'; out: bigint }> = [
    { route: 'uniswap' as const, out: uniOut },
    { route: 'relay' as const, out: rOut },
    { route: 'lifi' as const, out: lOut },
  ].sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  return cands[0].out > 0n ? cands[0] : null;
}

async function uniExec(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  fee: number,
  minOut: bigint,
  ctx: ChainCtx,
): Promise<{ outWei: bigint; txHashes: string[] }> {
  if (minOut <= 0n) throw new Error('quoter returned 0 — swap cancelled (sandwich protection)');
  const txHashes: string[] = [];
  txHashes.push(...(await approveExact(fromAddr, ctx.routerAddress, amountInWei, ctx.wallet)));
  const router = new ethers.Contract(
    ctx.routerAddress,
    ctx.routerHasDeadline ? ROUTER_ABI_DEADLINE : ROUTER_ABI,
    ctx.wallet,
  );
  const before = await bal(toAddr, ctx);
  const tx = await router.exactInputSingle({
    tokenIn: fromAddr,
    tokenOut: toAddr,
    fee,
    recipient: ctx.wallet.address,
    ...(ctx.routerHasDeadline ? { deadline: BigInt(Math.floor(Date.now() / 1000) + 600) } : {}),
    amountIn: amountInWei,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  });
  await tx.wait();
  txHashes.push(tx.hash);
  const outWei = (await bal(toAddr, ctx)) - before;
  return { outWei, txHashes };
}

async function relayExec(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx,
): Promise<{ outWei: bigint; txHashes: string[] }> {
  const beforeFrom = await bal(fromAddr, ctx);
  const beforeTo = await bal(toAddr, ctx);
  const r = await swapTokenViaRelay(fromAddr, amountInWei, ethers.getAddress(toAddr), ctx);
  const afterFrom = await bal(fromAddr, ctx);
  if (beforeFrom - afterFrom < (amountInWei * 9n) / 10n) {
    throw new Error('relay did not reduce the input balance');
  }
  const outWei = (await bal(toAddr, ctx)) - beforeTo;
  return { outWei, txHashes: r.txHashes };
}

async function lifiExec(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx,
  slipPct: number,
): Promise<{ outWei: bigint; txHashes: string[] }> {
  const beforeFrom = await bal(fromAddr, ctx);
  const beforeTo = await bal(toAddr, ctx);
  const r = await swapViaLifi(fromAddr, toAddr, amountInWei, ctx, slipPct);
  const afterFrom = await bal(fromAddr, ctx);
  if (beforeFrom - afterFrom < (amountInWei * 9n) / 10n) {
    throw new Error('LI.FI did not reduce the input balance');
  }
  const outWei = (await bal(toAddr, ctx)) - beforeTo;
  return { outWei, txHashes: r.txHashes };
}

/**
 * Execute a from -> to swap over the best route. The slippage floor comes from Uniswap's
 * quoter, every route is verified against the balance, and this throws only if they all fail.
 */
export async function swapExactInBest(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
  slipPct = SLIP_MAX_PCT,
  maxSlipPct?: number,
): Promise<{ outWei: bigint; route: string; txHashes: string[] }> {
  const [uni, relayOut, lifiOut] = await Promise.all([
    quoteUniswap(fromAddr, toAddr, amountInWei, ctx),
    relayQuoteOut(fromAddr, toAddr, amountInWei, ctx),
    withTimeout(lifiQuoteOut(fromAddr, toAddr, amountInWei, ctx), LIFI_TIMEOUT_MS),
  ]);
  const uniOut = uni?.out ?? 0n;
  const rOut = relayOut ?? 0n;
  const lOut = lifiOut ?? 0n;
  const errors: string[] = [];

  const tryUni = async (slip: number) => {
    if (!uni) throw new Error('no Uniswap pool for this pair');
    const minOut = (uni.out * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
    return { ...(await uniExec(fromAddr, toAddr, amountInWei, uni.fee, minOut, ctx)), route: `uniswap(slip ${slip}%)` };
  };
  const tryRelay = async () => ({ ...(await relayExec(fromAddr, toAddr, amountInWei, ctx)), route: 'relay' });
  const tryLifi = async () => ({ ...(await lifiExec(fromAddr, toAddr, amountInWei, ctx, maxSlipPct ?? slipPct)), route: 'lifi' });

  // One band for every swap: 1% -> 2% -> 3%, clamped by `maxSlipPct` when the caller
  // set a tighter one. Never above 3, so a route can no longer fill far below the
  // number shown on the confirmation card.
  const uniSlips = slipLadder(maxSlipPct);
  const uniSteps = uniSlips.map((s) => () => tryUni(s));
  // Providers are ordered by quoted output, highest first, which is the deepest liquidity.
  // A route quoting 0 or nothing is dropped: there is no point attempting it. Uniswap with
  // a positive quote brings its whole slippage ladder; Relay and LI.FI get one attempt each.
  const providers: Array<{ out: bigint; steps: Array<() => Promise<{ outWei: bigint; txHashes: string[]; route: string }>> }> = [
    { out: uniOut, steps: uniOut > 0n ? uniSteps : [] },
    { out: rOut, steps: rOut > 0n ? [tryRelay] : [] },
    { out: lOut, steps: lOut > 0n ? [tryLifi] : [] },
  ].sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  // LI.FI is the PRIMARY router: if its rate is within tolerance and it quoted in time, it
  // moves to the front and the rest become fallbacks. Worse or slower, the ordinary
  // best-of order stands.
  const bestOther = uniOut > rOut ? uniOut : rOut;
  if (lifiPreferred(lOut, bestOther)) {
    const idx = providers.findIndex((p) => p.out === lOut && p.steps.length && p.steps[0] === tryLifi);
    if (idx > 0) providers.unshift(providers.splice(idx, 1)[0]);
  }
  const order = providers.flatMap((p) => p.steps);
  if (order.length === 0) throw new Error('no route quoted a positive output for this pair');

  for (const step of order) {
    try {
      return await step();
    } catch (e) {
      const why = (e as Error).message.slice(0, 70);
      // A route that fails and is covered by the next one still has to be visible. Reported
      // only when they ALL fail, a repeated failure that the fallback keeps rescuing never
      // shows up in the log until the day it becomes a total failure.
      console.log(`[swap] route failed, trying the next one: ${why}`);
      errors.push(why);
    }
  }
  throw new Error('All swap routes failed:\n' + errors.join('\n'));
}
