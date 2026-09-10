import { ethers } from 'ethers';
import { CHAINS, ERC20_ABI, isStableBase, type BaseAsset, type ChainCtx } from './chains.js';
import { bestBridgeQuote, executeBridgeVia } from './bridgeRoute.js';
import { NATIVE, type BridgeQuote } from './relay.js';

/**
 * Cross-chain funding: hold the treasury in a dollar stablecoin on ONE chain and let
 * every entry reach the token's own chain by itself.
 *
 * The bot's normal safety rule is that a swap must be proven by a balance that really
 * moved inside the SAME transaction (see `lifiVerified` in relay.ts). That rule cannot
 * hold here: the source transaction only pays a bridge, and the fill on the destination
 * chain lands seconds to minutes later. So the proof is moved rather than dropped --
 * `awaitArrival` measures the destination balance delta after the fact and holds it to
 * the same minimum the user confirmed. Nothing here trusts a quote's word for what
 * arrived.
 */

/** A stablecoin balance the treasury can actually spend, on one chain. */
export type StableFund = {
  ctx: ChainCtx;
  base: BaseAsset;
  balWei: bigint;
  /** Balance normalised to whole dollars -- the only sane way to compare 6- and 18-decimal stables. */
  usd: number;
};

/**
 * Every dollar-stablecoin balance the wallet holds, across every chain, richest first.
 *
 * Decimals come from the base asset, never assumed: USDG on Robinhood is 6 while USDT
 * on BSC is 18, and treating them alike shifts the figure by 10^12.
 */
export async function stableFunds(minUsd = 1): Promise<StableFund[]> {
  const jobs: Array<Promise<StableFund | null>> = [];
  for (const ctx of Object.values(CHAINS)) {
    for (const base of ctx.bases) {
      if (!isStableBase(base.kind)) continue;
      jobs.push(
        new ethers.Contract(base.address, ERC20_ABI, ctx.provider)
          .balanceOf(ctx.wallet.address)
          .then((balWei: bigint) => ({
            ctx,
            base,
            balWei,
            usd: Number(ethers.formatUnits(balWei, base.decimals)),
          }))
          .catch(() => null),
      );
    }
  }
  const all = (await Promise.all(jobs)).filter((f): f is StableFund => f !== null);
  return all.filter((f) => f.usd >= minUsd).sort((a, b) => b.usd - a.usd);
}

/**
 * Pick the fund to spend for a trade worth `wantUsd`.
 *
 * Prefer a fund on the destination chain itself -- that turns the trade back into an
 * ordinary same-chain swap with the in-transaction proof intact, and costs no bridge.
 * Otherwise take the richest chain that can cover the whole amount; falling back to the
 * richest overall lets the caller report a shortfall with a real number.
 */
export function pickFund(funds: StableFund[], wantUsd: number, destChainId?: number): StableFund | null {
  if (funds.length === 0) return null;
  const local = funds.find((f) => f.ctx.chainId === destChainId && f.usd >= wantUsd);
  if (local) return local;
  return funds.find((f) => f.usd >= wantUsd) ?? funds[0];
}

export type XQuote = {
  fund: StableFund;
  quote: BridgeQuote;
  provider: 'relay' | 'lifi';
  /** true when no bridge is involved -- source and destination are the same chain. */
  sameChain: boolean;
};

/**
 * Quote stablecoin -> `toToken` on `to`, crossing chains when needed.
 *
 * `lifiBridgeQuote` is already a generic any-token/any-chain route (its name predates
 * this use), so a cross-chain buy is one quote, not a bridge followed by a swap.
 */
export async function xQuote(
  fund: StableFund,
  to: ChainCtx,
  toToken: string,
  amountWei: bigint,
): Promise<XQuote> {
  const { provider, quote } = await bestBridgeQuote(fund.ctx, to, amountWei, {
    originCurrency: fund.base.address,
    destinationCurrency: toToken === NATIVE ? NATIVE : ethers.getAddress(toToken),
  });
  return { fund, quote, provider, sameChain: fund.ctx.chainId === to.chainId };
}

/** Balance of `token` on `ctx` for this wallet; NATIVE reads the coin balance. */
export async function balanceOn(ctx: ChainCtx, token: string): Promise<bigint> {
  if (token === NATIVE) return ctx.provider.getBalance(ctx.wallet.address);
  return new ethers.Contract(token, ERC20_ABI, ctx.provider).balanceOf(ctx.wallet.address) as Promise<bigint>;
}

export type Arrival = { received: bigint; waitedMs: number };

/**
 * Wait for a cross-chain fill to actually land, and prove it by balance.
 *
 * Resolves once the destination balance has risen by at least `minOutWei`. A fill that
 * lands SHORT of the confirmed minimum is not silently accepted: the balance keeps
 * being polled until the deadline, and the shortfall is thrown with the real figure so
 * the caller can show what arrived instead of claiming success.
 *
 * ponytail: fixed 4s polling, no provider status API. Bridges here quote 1-3s ETAs, so
 * this costs a handful of RPC calls; switch to the provider's status endpoint only if a
 * route with a multi-minute ETA is ever added.
 */
export async function awaitArrival(
  ctx: ChainCtx,
  token: string,
  beforeWei: bigint,
  minOutWei: bigint,
  timeoutMs = 300_000,
): Promise<Arrival> {
  const started = Date.now();
  let last = 0n;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4000));
    const now = await balanceOn(ctx, token).catch(() => null);
    if (now === null) continue;
    last = now > beforeWei ? now - beforeWei : 0n;
    if (last >= minOutWei) return { received: last, waitedMs: Date.now() - started };
  }
  if (last > 0n) {
    throw new Error(`arrived short: got ${last}, confirmed minimum was ${minOutWei}`);
  }
  throw new Error(`nothing arrived on ${ctx.label} after ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Spend a stablecoin on one chain, receive `toToken` on another, proven on arrival.
 *
 * Returns only after the destination balance has really risen -- callers may record a
 * position from `received` without re-reading anything.
 */
export async function xExecute(
  q: XQuote,
  to: ChainCtx,
  toToken: string,
  amountWei: bigint,
  minOutWei: bigint,
): Promise<{ txHashes: string[]; received: bigint; waitedMs: number }> {
  const before = await balanceOn(to, toToken);
  const r = await executeBridgeVia(q.provider, q.fund.ctx, to, amountWei, minOutWei, {
    originCurrency: q.fund.base.address,
    destinationCurrency: toToken === NATIVE ? NATIVE : ethers.getAddress(toToken),
  });
  const arr = await awaitArrival(to, toToken, before, minOutWei);
  return { txHashes: r.txHashes, received: arr.received, waitedMs: arr.waitedMs };
}
