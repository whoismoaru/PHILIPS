import { ethers } from 'ethers';
import { type ChainCtx } from './chains.js';
import { getBridgeQuote, executeBridge, lifiPreferred, NATIVE, type BridgeQuote } from './relay.js';
import { lifiBridgeQuote, lifiSupports } from './lifi.js';
import { cctpRoute, cctpTransfer, cctpQuote } from './cctp.js';

export type BridgeAssets = { originCurrency?: string; destinationCurrency?: string };

/**
 * Picks a BRIDGE route automatically between the aggregators (Relay and LI.FI/Jumper).
 * The highest output wins, since that is the deepest value; within 0.5% they are treated as
 * a tie and the faster ETA takes it. Execution REQUESTS A FRESH QUOTE from the chosen
 * provider -- bridge calldata is short-lived -- and refuses anything below the minimum the
 * user confirmed.
 */

export type BridgeProvider = 'relay' | 'lifi' | 'cctp';

/** Race both providers and return the better quote. Throws when neither has a route. */
export async function bestBridgeQuote(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  assets: BridgeAssets = {},
): Promise<{ provider: BridgeProvider; quote: BridgeQuote }> {
  const tasks: Array<Promise<{ provider: BridgeProvider; quote: BridgeQuote }>> = [
    getBridgeQuote(from, to, amountWei, assets).then((quote) => ({ provider: 'relay' as const, quote })),
  ];
  if (lifiSupports(from) && lifiSupports(to)) {
    tasks.push(lifiBridgeQuote(from, to, amountWei, assets).then((quote) => ({ provider: 'lifi' as const, quote })));
  }
  // CCTP is only a candidate for USDC-to-USDC. It is Circle burning and minting its own
  // token, so there is no pool to price against: the amount that arrives is the amount that
  // left, and the only cost is gas on both ends. That makes it the best possible "quote"
  // whenever it applies -- and on Arc it is the ONLY one, since no aggregator routes there.
  const cctpUsdc = await cctpUsdcRoute(from, to, assets);
  if (cctpUsdc) {
    // The figures come from Circle, not from an assumption: a fast transfer costs a few
    // hundredths of a basis point and lands in seconds, a standard one is free and waits
    // for source finality.
    const q = (await cctpQuote(from, to, amountWei).catch(() => null)) ?? {
      outWei: amountWei,
      feeWei: 0n,
      fast: false,
      etaSec: 15 * 60,
    };
    tasks.push(
      Promise.resolve({
        provider: 'cctp' as const,
        quote: {
          inLabel: `${ethers.formatUnits(amountWei, 6)} USDC`,
          outLabel: `${ethers.formatUnits(q.outWei, 6)} USDC`,
          outWei: q.outWei, // burn-and-mint: no pool, so the only difference is Circle's fee
          impactPct: 0,
          feeUsd: Number(ethers.formatUnits(q.feeWei, 6)),
          etaSec: q.etaSec,
          steps: [], // executed through cctpTransfer, not as calldata
        },
      }),
    );
  }
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter((s): s is PromiseFulfilledResult<{ provider: BridgeProvider; quote: BridgeQuote }> => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length === 0) {
    const why = settled.map((s) => (s.status === 'rejected' ? (s.reason as Error).message?.slice(0, 80) : '')).filter(Boolean);
    throw new Error(why.join(' | ') || 'no bridge route available');
  }
  ok.sort((a, b) => {
    // Highest output first; within 0.5% counts as a tie, and the faster ETA wins.
    const hi = a.quote.outWei > b.quote.outWei ? a : b;
    const near = (hi.quote.outWei - (a === hi ? b : a).quote.outWei) * 1000n <= hi.quote.outWei * 5n;
    if (near) {
      const ea = a.quote.etaSec ?? Number.MAX_SAFE_INTEGER;
      const eb = b.quote.etaSec ?? Number.MAX_SAFE_INTEGER;
      if (ea !== eb) return ea - eb;
    }
    return b.quote.outWei > a.quote.outWei ? 1 : b.quote.outWei < a.quote.outWei ? -1 : 0;
  });
  // LI.FI is the PRIMARY provider here too, as on the swap side: it goes first while its
  // output is no worse than Relay's beyond the tolerance. Without this the bridge would be
  // purely "highest output", and a fraction of a percent would be enough to move it.
  // CCTP first when it is on the table: 1:1 with no counterparty beats any quote that
  // routes through a pool, and it is the only thing that reaches Arc at all.
  const cctp = ok.find((o) => o.provider === 'cctp');
  if (cctp) return cctp;
  const lifi = ok.find((o) => o.provider === 'lifi');
  const relay = ok.find((o) => o.provider === 'relay');
  if (lifi && (!relay || lifiPreferred(lifi.quote.outWei, relay.quote.outWei))) return lifi;
  return ok[0];
}

/** Execute a bridge through the chosen provider: the quote is re-requested and held to minOut. */
/**
 * Is this a USDC transfer that CCTP can carry? Both ends must be enabled, and BOTH
 * currencies must be the chain's own CCTP USDC -- bridging USDG or USDT through it is not
 * a thing, and silently swapping the asset would be worse than having no route.
 */
async function cctpUsdcRoute(from: ChainCtx, to: ChainCtx, assets: BridgeAssets) {
  const route = await cctpRoute(from, to).catch(() => null);
  if (!route) return null;
  const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  if (!same(assets.originCurrency, route.src.usdc) || !same(assets.destinationCurrency, route.dst.usdc)) return null;
  // CCTP MINTS on the destination, and that transaction is ours to pay for. With no gas
  // there the burn would land and the mint could not follow -- the funds stay safe and
  // claimable, but they do not arrive, which is not what "bridge" means. Measured on Arc,
  // where gas is USDC and a fresh wallet holds none: an aggregator route delivers without
  // us paying anything on the far side, so let that win instead.
  const gas = await mintGasAffordable(to);
  return gas ? route : null;
}

/** Can the wallet pay for one mint on this chain? ~250k gas is a generous ceiling. */
async function mintGasAffordable(to: ChainCtx): Promise<boolean> {
  try {
    const [bal, fee] = await Promise.all([to.provider.getBalance(to.wallet.address), to.provider.getFeeData()]);
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    if (price === 0n) return bal > 0n;
    return bal >= price * 250_000n;
  } catch {
    return false; // unreadable means unproven, and this decides whether money can arrive
  }
}

export async function executeBridgeVia(
  provider: BridgeProvider,
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  minOutWei: bigint,
  assets: BridgeAssets = {},
): Promise<{ txHashes: string[]; outWei: bigint }> {
  // Relay includes the token approval as a step of its own.
  if (provider === 'relay') return executeBridge(from, to, amountWei, minOutWei, assets);
  if (provider === 'cctp') {
    const q = await cctpQuote(from, to, amountWei).catch(() => null);
    const r = await cctpTransfer(from, to, amountWei, { dryRun: false });
    // There is no pool to slip against; the only deduction is Circle's own fee, already in
    // the quote. Both hashes are returned so the card shows the whole journey.
    return { txHashes: [r.burnTx!, r.mintTx!].filter(Boolean), outWei: q?.outWei ?? amountWei };
  }
  // LI.FI: re-quote (target and spender are already pinned to the diamond in lifiBridgeQuote) and check minOut.
  const fresh = await lifiBridgeQuote(from, to, amountWei, assets);
  if (fresh.outWei < minOutWei) {
    throw new Error(`Route moved: now ${fresh.outLabel}, below the confirmed minimum. Nothing was sent. Try again.`);
  }
  const txHashes: string[] = [];
  const origin = assets.originCurrency ?? NATIVE;
  // ERC20 tokens: approve the EXACT amount to the diamond, whose spender is already verified as pinned.
  if (origin !== NATIVE) {
    const spender = fresh.steps[0]?.approvalAddress;
    if (!spender) throw new Error('LI.FI returned no spender to approve the token to');
    const erc = new ethers.Contract(
      ethers.getAddress(origin),
      ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
      from.wallet,
    );
    const allowance: bigint = await erc.allowance(from.wallet.address, spender);
    if (allowance < amountWei) {
      const atx = await erc.approve(spender, amountWei);
      await atx.wait();
      txHashes.push(atx.hash);
    }
  }
  for (const st of fresh.steps) {
    const tx = await from.wallet.sendTransaction({ to: st.to, data: st.data, value: st.value ? BigInt(st.value) : 0n });
    const rc = await tx.wait();
    if (rc) txHashes.push(rc.hash);
  }
  return { txHashes, outWei: fresh.outWei };
}
