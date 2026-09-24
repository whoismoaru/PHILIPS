import { ethers } from 'ethers';
import { approveExact } from './chain.js';
import { getChain, type ChainCtx } from './chains.js';

/**
 * Swap a token into native ETH on the same chain through Relay (relay.link).
 * Relay returns a list of transaction steps, which are executed in order,
 * including the approval where one is needed.
 */

const RELAY_API = 'https://api.relay.link/quote';
export const NATIVE = '0x0000000000000000000000000000000000000000';

/** Swap same-chain lewat Relay: token → currency tujuan. */
export async function swapTokenViaRelay(
  tokenAddress: string,
  amountWei: bigint,
  destinationCurrency: string,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outWei: bigint }> {
  const wallet = ctx.wallet;
  const body = {
    user: wallet.address,
    recipient: wallet.address,
    originChainId: ctx.chainId,
    destinationChainId: ctx.chainId,
    originCurrency: ethers.getAddress(tokenAddress),
    destinationCurrency,
    amount: amountWei.toString(),
    tradeType: 'EXACT_INPUT',
  };

  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Relay quote failed (${res.status}): ${await res.text()}`);
  }
  const quote: any = await res.json();

  const txHashes: string[] = [];
  for (const step of quote.steps ?? []) {
    for (const item of step.items ?? []) {
      const d = item?.data;
      if (!d?.to) continue;
      // Selling a token on one chain means ERC20 in and NO native. A step carrying
      // value > 0 is an anomaly -- unexpected relay calldata could drain the native
      // balance -- so refuse it. The caller has a Uniswap fallback, which makes refusing
      // here safe rather than fatal.
      const value = d.value ? BigInt(d.value) : 0n;
      if (value > 0n) {
        throw new Error(`relay step unexpectedly requires ${value} native on a token sell: aborted for safety`);
      }
      const tx = await sendTxNonceSafe(wallet as ethers.Wallet, { to: d.to, data: d.data, value });
      const rc = await tx.wait();
      if (rc) txHashes.push(rc.hash);
    }
  }

  // The estimated output from the quote, when it carries one.
  let outWei = 0n;
  try {
    const raw = quote?.details?.currencyOut?.amount;
    if (raw) outWei = BigInt(raw);
  } catch {
    /* ignored */
  }

  return { txHashes, outWei };
}

export async function swapTokenToEthViaRelay(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const r = await swapTokenViaRelay(tokenAddress, amountWei, NATIVE, ctx);
  return { txHashes: r.txHashes, outEthWei: r.outWei };
}

/** A Relay quote only, same chain, from -> to. Never executes. null when there is no route. */
export async function relayQuoteOut(
  fromCurrency: string,
  toCurrency: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<bigint | null> {
  try {
    const res = await fetch(RELAY_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: ctx.wallet.address,
        recipient: ctx.wallet.address,
        originChainId: ctx.chainId,
        destinationChainId: ctx.chainId,
        originCurrency: fromCurrency === NATIVE ? NATIVE : ethers.getAddress(fromCurrency),
        destinationCurrency: toCurrency === NATIVE ? NATIVE : ethers.getAddress(toCurrency),
        amount: amountWei.toString(),
        tradeType: 'EXACT_INPUT',
      }),
    });
    if (!res.ok) return null;
    const q: any = await res.json();
    const raw = q?.details?.currencyOut?.amount;
    return raw ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a transaction, recovering from a NONCE collision. A swap route that fails has
 * sometimes already SENT a transaction (consuming a nonce) before reverting, so the next
 * send reuses it and dies with "nonce has already been used" -- taking the whole cash-out
 * with it and leaving the token behind, which then reports the wrong PnL (see LIGER
 * #774283). On a nonce error, read a fresh nonce from the chain and retry, a few times
 * with a short pause so the RPC can catch up.
 */
async function sendTxNonceSafe(
  wallet: ethers.Wallet,
  req: { to: string; data: string; value: bigint },
): Promise<ethers.TransactionResponse> {
  let nonce: number | undefined;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await wallet.sendTransaction(nonce === undefined ? req : { ...req, nonce });
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (attempt < 3 && /nonce|already been used|nonce too low|replacement/i.test(msg)) {
        await sleep(800);
        nonce = await wallet.provider!.getTransactionCount(wallet.address, 'pending');
        continue;
      }
      throw e;
    }
  }
  throw new Error('unreachable');
}

// Two shapes of exactInputSingle are in the wild. Uniswap's SwapRouter02 dropped
// `deadline`; the original v3 SwapRouter, which PancakeSwap uses, still takes it. Calling
// with the wrong shape reverts with no data -- expensive and baffling.
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const ROUTER_ABI_DEADLINE = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

/** The router contract plus exactInputSingle parameters shaped for this chain's struct. */
function routerCall(
  ctx: ChainCtx,
  wallet: ethers.Signer,
  p: { tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint },
): { router: ethers.Contract; params: Record<string, unknown> } {
  const router = new ethers.Contract(
    ctx.routerAddress,
    ctx.routerHasDeadline ? ROUTER_ABI_DEADLINE : ROUTER_ABI,
    wallet,
  );
  return {
    router,
    params: {
      ...p,
      ...(ctx.routerHasDeadline ? { deadline: BigInt(Math.floor(Date.now() / 1000) + 600) } : {}),
      sqrtPriceLimitX96: 0n,
    },
  };
}
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];

/**
 * The slippage band for EVERY swap the bot sends: start at 1%, step to 2%, then 3%,
 * and never past it. 3 is a hard ceiling -- a caller asking for more is clamped down,
 * not honoured. This replaced a 5%-then-15% ladder that close and sweep used
 * uncapped, on the reasoning that a failed sell means a stuck token; the trade is
 * deliberate, a swap that will not fill inside 3% now fails and is retried later
 * rather than filling 15% down.
 *
 * Relay is left out of this: its own default is already 1% (verified 2 Aug 2026 -- sending
 * slippageTolerance=300 actually loosened it to 3%), so it is left alone.
 */
export const SLIP_MAX_PCT = 3;
export function slipLadder(max: number = SLIP_MAX_PCT): number[] {
  const cap = Math.min(max, SLIP_MAX_PCT);
  return [...new Set([1, 2, 3].map((s) => Math.min(s, cap)))].filter((s) => s > 0);
}

/** Fallback: swap the token straight into WETH through Uniswap's SwapRouter02, on the deepest pool. */
async function swapViaUniswap(
  tokenAddress: string,
  amountWei: bigint,
  slippagePct: number,
  ctx: ChainCtx,
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const { ethers: e } = await import('ethers');
  const { discoverPools } = await import('./uniswap.js');
  const { wallet, weth } = ctx;

  // This route is specifically token -> WETH/WBNB. A token whose only liquidity is in a
  // stablecoin pool fails HERE, and that is correct: route 3 (the stable hop) recovers it.
  const pools = (await discoverPools(tokenAddress, ctx)).filter((p) => p.baseReserve > 0n);
  if (pools.length === 0)
    throw new Error(`no ${ctx.bases.find((b) => b.kind === 'weth')?.symbol ?? 'WETH'} pool for the fallback swap`);
  const fee = pools[0].fee;

  const txHashes: string[] = [];
  const routerAddr = ctx.routerAddress;
  txHashes.push(...(await approveExact(tokenAddress, routerAddr, amountWei, wallet)));

  // minOut comes from the quoter, less slippage. If the quoter fails or returns 0, ABORT
  // this route -- never swap with minOut=0, which is bait for a sandwich.
  // swapTokenToEthRobust will try the others; if they all fail the token is held as a
  // leftover and the sweep retries later, which beats selling at any price at all.
  let minOut: bigint;
  try {
    const quoter = new e.Contract(ctx.quoterAddress, QUOTER_ABI, wallet);
    const q = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenAddress,
      tokenOut: ctx.wethAddress,
      amountIn: amountWei,
      fee,
      sqrtPriceLimitX96: 0n,
    });
    minOut = (BigInt(q[0]) * BigInt(Math.floor((100 - slippagePct) * 100))) / 10000n;
  } catch (err) {
    throw new Error(`quoter failed (${(err as Error).message.slice(0, 60)}). Swap cancelled to avoid minOut=0`);
  }
  if (minOut <= 0n) {
    throw new Error('quoter returned 0. Swap cancelled (sandwich protection)');
  }

  const { router, params } = routerCall(ctx, wallet as unknown as ethers.Signer, {
    tokenIn: tokenAddress,
    tokenOut: ctx.wethAddress,
    fee,
    recipient: wallet.address,
    amountIn: amountWei,
    amountOutMinimum: minOut,
  });
  const beforeWeth: bigint = await weth.balanceOf(wallet.address);
  const tx = await router.exactInputSingle(params);
  await tx.wait();
  txHashes.push(tx.hash);

  // Unwrap the WETH the swap produced into native ETH.
  const gotWeth: bigint = (await weth.balanceOf(wallet.address)) - beforeWeth;
  if (gotWeth > 0n) {
    const wtx = await weth.withdraw(gotWeth);
    await wtx.wait();
    txHashes.push(wtx.hash);
  }
  return { txHashes, outEthWei: gotWeth };
}

/**
 * A token -> ETH swap built to survive:
 *  1. Relay, retried 3 times (2s/5s backoff), which holds up when the network or API is busy.
 *  2. The Uniswap router as a fallback: slippage 1% -> 2% -> 3%, never beyond.
 * This throws only when every route has failed.
 */
async function tokenBalance(tokenAddress: string, ctx: ChainCtx): Promise<bigint> {
  const c = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    ctx.provider,
  );
  return (await c.balanceOf(ctx.wallet.address)) as bigint;
}

/** Relay, plus a CHECK that the token balance really fell: Relay sometimes "succeeds" without swapping. */
async function relayVerified(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx,
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const before = await tokenBalance(tokenAddress, ctx);
  const ethBefore = await ctx.provider.getBalance(ctx.wallet.address).catch(() => null);
  const r = await swapTokenToEthViaRelay(tokenAddress, amountWei, ctx);
  const after = await tokenBalance(tokenAddress, ctx);
  // The balance must fall by at least 90% of what was asked; otherwise Relay did nothing.
  if (before - after < (amountWei * 9n) / 10n) {
    throw new Error(`relay did not reduce the token balance (before=${before} after=${after})`);
  }
  // The quote's outEthWei is an ESTIMATE, sometimes 0 -- and that number is recorded as
  // the close result in the journal. Measure it from the native balance delta instead.
  const ethAfter = await ctx.provider.getBalance(ctx.wallet.address).catch(() => null);
  const measured = ethBefore !== null && ethAfter !== null && ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
  return { ...r, outEthWei: measured > 0n ? measured : r.outEthWei };
}

/**
 * LI.FI is the primary router everywhere (swap in, swap out, bridge). A backup is
 * only used when LI.FI's rate is genuinely worse -- more than this tolerance below
 * the best alternative -- or when LI.FI cannot quote at all. Kept here so the swap
 * and bridge selectors cannot drift apart.
 */
export const LIFI_TOL = 0.015; // 1.5%
export const lifiPreferred = (lifi: bigint, bestOther: bigint): boolean =>
  lifi > 0n && lifi * 1000n >= bestOther * BigInt(Math.floor((1 - LIFI_TOL) * 1000));

/** LI.FI's deadline: a quote or transaction not finished within this counts as "slow" and
 *  falls back to Relay/Uniswap. The same figure covers the sell side and the preview. */
const LIFI_TIMEOUT_MS = 12_000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out (${ms}ms)`)), ms)),
  ]);
}

/**
 * LI.FI token → `toAddr`, verified: the token balance must really drop, and the
 * output is measured from the destination balance rather than trusted from the
 * quote. `toAddr` = NATIVE swaps to the chain's native coin; any other address is
 * an ERC20 (the stablecoin side uses this too).
 */
async function lifiVerified(
  tokenAddress: string,
  toAddr: string,
  amountWei: bigint,
  ctx: ChainCtx,
  maxSlipPct?: number,
): Promise<{ txHashes: string[]; outWei: bigint }> {
  const { swapViaLifi } = await import('./lifi.js'); // dynamic → hindari circular import
  const isNative = toAddr === NATIVE;
  const outBal = () =>
    isNative ? ctx.provider.getBalance(ctx.wallet.address) : tokenBalance(toAddr, ctx);
  const before = await tokenBalance(tokenAddress, ctx);
  const outBefore = await outBal().catch(() => null);
  const r = await withTimeout(swapViaLifi(tokenAddress, toAddr, amountWei, ctx, Math.min(maxSlipPct ?? SLIP_MAX_PCT, SLIP_MAX_PCT)), LIFI_TIMEOUT_MS, 'lifi');
  const after = await tokenBalance(tokenAddress, ctx);
  if (before - after < (amountWei * 9n) / 10n) {
    throw new Error(`lifi did not reduce the token balance (before=${before} after=${after})`);
  }
  const outAfter = await outBal().catch(() => null);
  const measured = outBefore !== null && outAfter !== null && outAfter > outBefore ? outAfter - outBefore : 0n;
  return { txHashes: r.txHashes, outWei: measured > 0n ? measured : r.outWei };
}

export async function swapTokenToEthRobust(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
  maxSlipPct?: number,
): Promise<{ txHashes: string[]; outEthWei: bigint; route: string }> {
  const errors: string[] = [];

  // Route 0 (PRIMARY): LI.FI, the deepest and fastest DEX aggregator here. Relay and
  // Uniswap are the fallbacks when LI.FI does not cover the chain, quotes worse than both,
  // or takes too long. The rate is compared first rather than trusted blindly: "primary"
  // means it goes first while its price holds, not that it is used whatever the price.
  const { lifiQuoteOut } = await import('./lifi.js'); // dynamic → hindari circular import
  const [lifiOutEth, relayOutEth] = await Promise.all([
    lifiQuoteOut(tokenAddress, NATIVE, amountWei, ctx).catch(() => null),
    relayQuoteOut(tokenAddress, NATIVE, amountWei, ctx).catch(() => null),
  ]);
  let lifiEthTried = false;
  const tryLifiEth = async () => {
    lifiEthTried = true;
    try {
      const r = await lifiVerified(tokenAddress, NATIVE, amountWei, ctx, maxSlipPct);
      return { txHashes: r.txHashes, outEthWei: r.outWei, route: 'lifi' };
    } catch (e) {
      errors.push(`lifi: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  };
  // A failed quote on both sides leaves nothing to compare, and LI.FI still goes first.
  if (lifiOutEth === null && relayOutEth === null ? true : lifiPreferred(lifiOutEth ?? 0n, relayOutEth ?? 0n)) {
    const r = await tryLifiEth();
    if (r) return r;
  }

  // Path 1: Relay, an aggregator paying out native ETH directly, and verified.
  try {
    const r = await relayVerified(tokenAddress, amountWei, ctx);
    return { ...r, route: 'relay' };
  } catch (e) {
    errors.push(`relay: ${(e as Error).message.slice(0, 80)}`);
  }

  // Route 2: the Uniswap router directly (exactInputSingle over the full amountIn), with
  // slippage stepping up. On Slipstream (Ink/Velodrome) the DEX router and quoter are not
  // used at all -- skip it and lean on the aggregators.
  for (const slip of ctx.slipstream ? [] : slipLadder(maxSlipPct)) {
    try {
      const r = await swapViaUniswap(tokenAddress, amountWei, slip, ctx);
      return { ...r, route: `uniswap(slip ${slip}%)` };
    } catch (e) {
      errors.push(`uniswap${slip}%: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Every fallback failed and LI.FI was never attempted, because its quote lost. Try it
  // now: a worse rate still beats a token stuck in the wallet.
  if (!lifiEthTried) {
    const r = await tryLifiEth();
    if (r) return r;
  }

  // Route 3: a two-hop token -> stablecoin -> native. Required for tokens whose liquidity
  // lives ONLY in a stablecoin pool (GME/USDG on Robinhood, 币安城/USDT on BSC): they have
  // no WETH/WBNB pool, so routes 1 and 2 always fail and the token stays stuck for good.
  // The stablecoin FOLLOWS THE CHAIN -- this was once gated on `ctx.usdgAddress` alone, so
  // BSC, which has USDT rather than USDG, skipped the route entirely.
  const stableAddr = ctx.usdgAddress ?? ctx.usdtAddress ?? ctx.usdcAddress;
  if (stableAddr && tokenAddress.toLowerCase() !== stableAddr.toLowerCase()) {
    try {
      const u = await swapTokenToUsdgRobust(tokenAddress, amountWei, stableAddr, ctx, maxSlipPct);
      const eth = await swapTokenToEthRobust(stableAddr, u.outWei, ctx, maxSlipPct); // stable→native
      return {
        txHashes: [...u.txHashes, ...eth.txHashes],
        outEthWei: eth.outEthWei,
        route: `stable-hop(${u.route}→${eth.route})`,
      };
    } catch (e) {
      errors.push(`stable-hop: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Path 4: Relay one more time, in case that outage was transient.
  await sleep(2000);
  try {
    const r = await relayVerified(tokenAddress, amountWei, ctx);
    return { ...r, route: 'relay(retry)' };
  } catch (e) {
    errors.push(`relay-retry: ${(e as Error).message.slice(0, 80)}`);
  }
  throw new Error('All swap routes failed:\n' + errors.join('\n'));
}

/**
 * Swap a token to the chain's stablecoin, for closing a stablecoin-paired position. It
 * takes the deepest stable/token pool and calls exactInputSingle through the Uniswap
 * router with minOut from the quoter -- the same floor as the WETH route, so a failed or
 * zero quote ABORTS rather than inviting a sandwich. Slippage steps 1% -> 2% -> 3% and no
 * further. The stablecoin is never unwrapped; it stays a stablecoin.
 */
export async function swapTokenToUsdgRobust(
  tokenAddress: string,
  amountWei: bigint,
  usdgAddress: string,
  ctx: ChainCtx = getChain(),
  maxSlipPct?: number,
): Promise<{ txHashes: string[]; outWei: bigint; route: string }> {
  const { wallet } = ctx;
  const usdg = new ethers.Contract(
    usdgAddress,
    ['function balanceOf(address) view returns (uint256)'],
    ctx.provider,
  );
  const token = new ethers.Contract(
    tokenAddress,
    [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
    ],
    wallet,
  );

  // Pool USDG/token terlikuid (USDG reserve terbesar).
  let bestFee = 0;
  let bestReserve = -1n;
  for (const fee of ctx.feeTiers) {
    const pool: string = await ctx.factory.getPool(usdgAddress, tokenAddress, fee);
    if (!pool || pool === ethers.ZeroAddress) continue;
    const r: bigint = await usdg.balanceOf(pool);
    if (r > bestReserve) {
      bestReserve = r;
      bestFee = fee;
    }
  }
  // No direct pool is not a reason to give up: Relay below can route through WETH and
  // others. This used to `throw` here, so the Relay fallback was NEVER reached and selling
  // into a stablecoin base always failed for tokens paired only with WETH. Skip the
  // direct-pool section instead of stopping.
  // On Slipstream there is no DEX quoter, so force the aggregator path (hasDirectPool=false).
  const hasDirectPool = !ctx.slipstream && bestReserve >= 0n;

  // LI.FI is the primary router here too. This path used to go straight to the single
  // most liquid USDG/token pool, so every sell into a stablecoin -- most positions on
  // Robinhood -- was locked to one pool and never saw an aggregated route.
  // Quote all three first: a backup only wins when LI.FI's rate is actually worse.
  const { lifiQuoteOut } = await import('./lifi.js');
  const [lifiOut, uniOut, relayOut] = await Promise.all([
    lifiQuoteOut(tokenAddress, usdgAddress, amountWei, ctx).catch(() => null),
    hasDirectPool
      ? new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, wallet)
          .quoteExactInputSingle.staticCall({
            tokenIn: tokenAddress, tokenOut: usdgAddress, amountIn: amountWei,
            fee: bestFee, sqrtPriceLimitX96: 0n,
          })
          .then((q: any) => BigInt(q[0]))
          .catch(() => null)
      : Promise.resolve(null),
    relayQuoteOut(tokenAddress, usdgAddress, amountWei, ctx).catch(() => null),
  ]);
  const bestOther = (uniOut ?? 0n) > (relayOut ?? 0n) ? (uniOut ?? 0n) : (relayOut ?? 0n);
  const lifiFirst = lifiPreferred(lifiOut ?? 0n, bestOther);
  let lifiTried = false;
  const tryLifi = async (): Promise<{ txHashes: string[]; outWei: bigint; route: string } | null> => {
    lifiTried = true;
    try {
      const r = await lifiVerified(tokenAddress, usdgAddress, amountWei, ctx, maxSlipPct);
      return { ...r, route: 'lifi-usdg' };
    } catch (e) {
      console.log(`[swap] lifi->usdg failed, falling back to uniswap/relay: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  };
  if (lifiFirst) {
    const r = await tryLifi();
    if (r) return r;
  }

  const routerAddr = ctx.routerAddress;
  const txHashes: string[] = [];
  if (hasDirectPool) {
    txHashes.push(...(await approveExact(tokenAddress, routerAddr, amountWei, wallet)));
  }

  const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, wallet);
  let lastErr = hasDirectPool ? '' : 'no direct token→USDG pool';
  for (const slip of hasDirectPool ? slipLadder(maxSlipPct) : []) {
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenAddress,
        tokenOut: usdgAddress,
        amountIn: amountWei,
        fee: bestFee,
        sqrtPriceLimitX96: 0n,
      });
      const minOut = (BigInt(q[0]) * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      if (minOut <= 0n) throw new Error('quoter returned 0 (sandwich protection)');
      const before: bigint = await usdg.balanceOf(wallet.address);
      const call = routerCall(ctx, wallet as unknown as ethers.Signer, {
        tokenIn: tokenAddress,
        tokenOut: usdgAddress,
        fee: bestFee,
        recipient: wallet.address,
        amountIn: amountWei,
        amountOutMinimum: minOut,
      });
      const tx = await call.router.exactInputSingle(call.params);
      await tx.wait();
      txHashes.push(tx.hash);
      const outWei = (await usdg.balanceOf(wallet.address)) - before;
      return { txHashes, outWei, route: `uniswap-usdg(slip ${slip}%)` };
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 80);
    }
  }

  // Fallback: Relay token -> stablecoin, which can route through WETH when the direct
  // stable pool is thin or the impact is high. The token balance is verified to have
  // fallen by at least 90% (Relay sometimes "succeeds" without swapping) and the stablecoin
  // received is measured from the balance delta. This gives the stablecoin path the same
  // resilience as the ETH one, so those positions no longer get stuck without an auto-swap.
  try {
    const beforeTok = await tokenBalance(tokenAddress, ctx);
    const beforeUsdg: bigint = await usdg.balanceOf(wallet.address);
    const r = await swapTokenViaRelay(tokenAddress, amountWei, usdgAddress, ctx);
    const afterTok = await tokenBalance(tokenAddress, ctx);
    if (beforeTok - afterTok < (amountWei * 9n) / 10n) {
      throw new Error('relay did not reduce the token balance');
    }
    const outWei = (await usdg.balanceOf(wallet.address)) - beforeUsdg;
    return { txHashes: r.txHashes, outWei, route: 'relay-usdg' };
  } catch (e) {
    lastErr = `${lastErr} | relay: ${(e as Error).message.slice(0, 60)}`;
  }

  // LI.FI quoted worse than a backup, but every backup has now failed. Try it anyway
  // before the 2-hop: a worse rate beats a stuck token.
  if (!lifiTried) {
    const r = await tryLifi();
    if (r) return r;
  }

  // Route 3: a two-hop token -> WETH -> stablecoin. The mirror of the stable hop in
  // swapTokenToEthRobust, and not a theory: measured on 2 Aug 2026 for SESTRI and IF, where
  // the token/WETH pool existed (1% fee), the token/stable pool did not, and Relay had no
  // route either (a null quote). Without this hop, selling and closing into a stablecoin
  // failed outright for most tokens, which are only ever paired with WETH.
  //
  // If the first leg lands and the second fails, the wallet holds WETH rather than the
  // token -- still progress, since the monitor's sweep can unwrap it.
  const wethLower = ctx.wethAddress.toLowerCase();
  const tokLower = tokenAddress.toLowerCase();
  if (tokLower !== wethLower && tokLower !== usdgAddress.toLowerCase()) {
    try {
      // Imported dynamically: swapRoute.ts imports THIS module, so a static import would
      // close a module cycle. Called at runtime, it is safe.
      const { swapExactInBest } = await import('./swapRoute.js');
      const leg1 = await swapExactInBest(tokenAddress, ctx.wethAddress, amountWei, ctx, Math.min(maxSlipPct ?? SLIP_MAX_PCT, SLIP_MAX_PCT), maxSlipPct);
      const leg2 = await swapExactInBest(ctx.wethAddress, usdgAddress, leg1.outWei, ctx, Math.min(maxSlipPct ?? SLIP_MAX_PCT, SLIP_MAX_PCT), maxSlipPct);
      return {
        txHashes: [...txHashes, ...leg1.txHashes, ...leg2.txHashes],
        outWei: leg2.outWei,
        route: `weth-hop(${leg1.route}→${leg2.route})`,
      };
    } catch (e) {
      lastErr = `${lastErr} | weth-hop: ${(e as Error).message.slice(0, 60)}`;
    }
  }

  throw new Error(`token→USDG swap failed: ${lastErr}`);
}

// ─── cross-chain bridging (Relay) ───────────────────────────────────
//
// Relay is a bridge aggregator: the same-chain swaps above are just the special case where
// origin equals destination. Crossing chains simply means giving it two different ids.

export type BridgeQuote = {
  inLabel: string; // "0.01 ETH"
  outLabel: string; // "0.0319 BNB"
  outWei: bigint;
  impactPct: number | null; // the difference in USD value between what went in and what came out
  feeUsd: number | null; // biaya relayer
  etaSec: number | null;
  steps: Array<{ to: string; data: string; value: string; approvalAddress?: string }>;
};

/**
 * A native -> native bridge quote. Its calldata is SHORT-LIVED: never execute the `steps`
 * from the quote that rendered a card. Ask for a fresh quote right before sending (see
 * executeBridge).
 */
export async function getBridgeQuote(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  opts: { originCurrency?: string; destinationCurrency?: string } = {},
): Promise<BridgeQuote> {
  const originCurrency = opts.originCurrency ?? NATIVE;
  const destinationCurrency = opts.destinationCurrency ?? NATIVE;
  const body = {
    user: from.wallet.address,
    recipient: from.wallet.address, // the same wallet on both chains, since they are EVM
    originChainId: from.chainId,
    destinationChainId: to.chainId,
    originCurrency: originCurrency === NATIVE ? NATIVE : ethers.getAddress(originCurrency),
    destinationCurrency: destinationCurrency === NATIVE ? NATIVE : ethers.getAddress(destinationCurrency),
    amount: amountWei.toString(),
    tradeType: 'EXACT_INPUT',
  };
  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Relay quote failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const q: any = await res.json();
  const d = q?.details ?? {};
  const steps: BridgeQuote['steps'] = [];
  for (const st of q?.steps ?? []) {
    for (const it of st?.items ?? []) {
      if (it?.data?.to) steps.push({ to: it.data.to, data: it.data.data, value: it.data.value ?? '0' });
    }
  }
  if (steps.length === 0) throw new Error('Relay returned no executable step for this route.');
  const outWei = BigInt(d?.currencyOut?.amount ?? '0');
  if (outWei <= 0n) throw new Error('Relay quote returned zero output: route unusable right now.');
  // Relay returns full precision (18 decimal places). Six is enough to decide on, and does
  // not fill a phone screen.
  const trim = (v: unknown, fallback: bigint): string =>
    Number(v ?? ethers.formatEther(fallback)).toFixed(6);
  return {
    inLabel: `${trim(d?.currencyIn?.amountFormatted, amountWei)} ${d?.currencyIn?.currency?.symbol ?? from.nativeSymbol}`,
    outLabel: `${trim(d?.currencyOut?.amountFormatted, outWei)} ${d?.currencyOut?.currency?.symbol ?? to.nativeSymbol}`,
    outWei,
    impactPct: d?.totalImpact?.percent != null ? Number(d.totalImpact.percent) : null,
    // Value in minus value out, as on every bridge card; the relayer fee alone left out the
    // swap spread on a native-to-native route.
    feeUsd: (() => {
      const i = Number(d?.currencyIn?.amountUsd), o = Number(d?.currencyOut?.amountUsd);
      if (isFinite(i) && isFinite(o) && i > 0) return Math.max(0, i - o);
      return q?.fees?.relayer?.amountUsd != null ? Number(q.fees.relayer.amountUsd) : null;
    })(),
    etaSec: d?.timeEstimate != null ? Number(d.timeEstimate) : null,
    steps,
  };
}

/**
 * Send the bridge. The quote is REQUESTED AGAIN here: Relay's calldata is short-lived, and
 * executing stale calldata means funds leaving on figures the user never saw. `minOutWei`
 * keeps the fill from landing far below what was confirmed.
 */
export async function executeBridge(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  minOutWei: bigint,
  opts: { originCurrency?: string; destinationCurrency?: string } = {},
): Promise<{ txHashes: string[]; outWei: bigint }> {
  const fresh = await getBridgeQuote(from, to, amountWei, opts);
  if (fresh.outWei < minOutWei) {
    throw new Error(
      `Route moved: now ${fresh.outLabel}, below the confirmed minimum. Nothing was sent. Try again.`,
    );
  }
  const txHashes: string[] = [];
  for (const st of fresh.steps) {
    const tx = await sendTxNonceSafe(from.wallet as ethers.Wallet, {
      to: st.to,
      data: st.data,
      value: st.value ? BigInt(st.value) : 0n,
    });
    const rc = await tx.wait();
    if (rc) txHashes.push(rc.hash);
  }
  return { txHashes, outWei: fresh.outWei };
}
