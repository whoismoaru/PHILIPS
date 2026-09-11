import { ethers } from 'ethers';
import { CHAINS, DEFAULT_CHAIN, ERC20_ABI, isStableBase, type BaseAsset, type ChainCtx } from './chains.js';
import { getEthUsd } from './screening.js';
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

// ─── gas pocket: one ETH balance on Base pays gas on every chain ───────────────

/**
 * Gas is budgeted separately from trading capital, on purpose.
 *
 * Taking gas out of the stablecoin treasury would shrink the trading balance on every
 * transaction, so a flat week would still read as a slow loss and PnL would mix market
 * moves with network costs. Instead one native balance on ONE chain -- ETH on Base by
 * default -- funds gas everywhere, and the stablecoin side moves only when a position
 * is opened or closed.
 *
 * Base is also the chain that signs the outbound bridge, so the pocket keeps a reserve
 * for its own transactions: a pocket that bridges itself dry cannot refill anything.
 */
export const GAS_CHAIN_KEY = process.env.GAS_CHAIN ?? 'base';
/** Held back on the gas chain so the pocket can always pay for its own outbound tx. */
export const GAS_KEEP_WEI = ethers.parseEther(process.env.GAS_KEEP_ETH ?? '0.0015');

/**
 * Dollars to bridge to cover `shortWei` of the destination native.
 *
 * 3% margin: the arrival is measured, and a fill that lands exactly on the nose after
 * bridge fees would still leave the transaction one wei short of its own gas.
 */
export const gasUsdNeeded = (shortWei: bigint, toUsd: number): number =>
  Number(ethers.formatEther(shortWei)) * toUsd * 1.03;

/** What the pocket may send away, keeping its own outbound gas back. Never negative. */
export const gasSpendable = (pocketWei: bigint): bigint =>
  pocketWei > GAS_KEEP_WEI ? pocketWei - GAS_KEEP_WEI : 0n;

export const gasChain = (): ChainCtx => CHAINS[GAS_CHAIN_KEY] ?? CHAINS[DEFAULT_CHAIN];

/**
 * Top the destination chain's native balance up to `needWei`, paid from the gas pocket.
 *
 * Returns null when nothing was needed, or when the destination IS the pocket -- there
 * is no chain behind Base to refill it from, and `ensureGasForLegs` reports an empty
 * pocket with a far clearer message than a failed bridge would.
 *
 * The destination native is not always ETH (BSC pays in BNB, HyperEVM in HYPE), so the
 * size is set through USD rather than assumed one-to-one.
 */
export async function fundGasFromPocket(
  to: ChainCtx,
  needWei: bigint,
  notify: (text: string) => Promise<void>,
): Promise<string | null> {
  const from = gasChain();
  if (to.chainId === from.chainId) return null;

  const have = await balanceOn(to, NATIVE);
  if (have >= needWei) return null;
  const shortWei = needWei - have;

  const [toUsd, fromUsd] = await Promise.all([
    getEthUsd(to.wethAddress, to).catch(() => null),
    getEthUsd(from.wethAddress, from).catch(() => null),
  ]);
  if (!toUsd || !fromUsd) {
    throw new Error(`cannot price ${to.nativeSymbol} or ${from.nativeSymbol} — refusing to bridge gas blind.`);
  }

  const usd = gasUsdNeeded(shortWei, toUsd);
  const srcWei = ethers.parseEther((usd / fromUsd).toFixed(18));

  const spendable = gasSpendable(await balanceOn(from, NATIVE));
  if (srcWei > spendable) {
    throw new Error(
      `Gas pocket too small: need ~$${usd.toFixed(2)} of ${from.nativeSymbol} on ${from.label} for gas on ` +
        `${to.label}, spendable ${ethers.formatEther(spendable)} ${from.nativeSymbol}. Top up ${from.label}.`,
    );
  }

  await notify(`bridging ~$${usd.toFixed(2)} ${from.nativeSymbol} from ${from.label} for gas on ${to.label}…`);
  const { provider, quote } = await bestBridgeQuote(from, to, srcWei, {
    originCurrency: NATIVE,
    destinationCurrency: NATIVE,
  });
  const minOut = (quote.outWei * 97n) / 100n;
  if (minOut < shortWei) {
    throw new Error(
      `Bridging $${usd.toFixed(2)} would deliver only ${quote.outLabel}, below the gas still needed on ${to.label}.`,
    );
  }
  const before = await balanceOn(to, NATIVE);
  const r = await executeBridgeVia(provider, from, to, srcWei, minOut, {
    originCurrency: NATIVE,
    destinationCurrency: NATIVE,
  });
  const arr = await awaitArrival(to, NATIVE, before, minOut);
  const line =
    `${from.nativeSymbol} ${ethers.formatEther(srcWei)} @ ${from.label} → ` +
    `${ethers.formatEther(arr.received)} ${to.nativeSymbol} @ ${to.label} (${Math.round(arr.waitedMs / 1000)}s)`;
  console.log(`[xgas] ${line} · ${r.txHashes.join(',')}`);
  return line;
}
