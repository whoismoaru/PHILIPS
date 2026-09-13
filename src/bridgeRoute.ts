import { ethers } from 'ethers';
import { type ChainCtx } from './chains.js';
import { getBridgeQuote, executeBridge, lifiPreferred, NATIVE, type BridgeQuote } from './relay.js';
import { lifiBridgeQuote, lifiSupports } from './lifi.js';

export type BridgeAssets = { originCurrency?: string; destinationCurrency?: string };

/**
 * Picks a BRIDGE route automatically between the aggregators (Relay and LI.FI/Jumper).
 * The highest output wins, since that is the deepest value; within 0.5% they are treated as
 * a tie and the faster ETA takes it. Execution REQUESTS A FRESH QUOTE from the chosen
 * provider -- bridge calldata is short-lived -- and refuses anything below the minimum the
 * user confirmed.
 */

export type BridgeProvider = 'relay' | 'lifi';

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
  const lifi = ok.find((o) => o.provider === 'lifi');
  const relay = ok.find((o) => o.provider === 'relay');
  if (lifi && (!relay || lifiPreferred(lifi.quote.outWei, relay.quote.outWei))) return lifi;
  return ok[0];
}

/** Execute a bridge through the chosen provider: the quote is re-requested and held to minOut. */
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
  // LI.FI: re-quote (target and spender are already pinned to the diamond in lifiBridgeQuote) and check minOut.
  const fresh = await lifiBridgeQuote(from, to, amountWei, assets);
  if (fresh.outWei < minOutWei) {
    throw new Error(`Route moved: now ${fresh.outLabel}, below the confirmed minimum. Nothing was sent — try again.`);
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
