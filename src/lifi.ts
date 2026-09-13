import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';
import { NATIVE, SLIP_MAX_PCT } from './relay.js';

/**
 * LI.FI (mesin di balik Jumper) — agregator swap & bridge lintas ratusan DEX/bridge.
 * Used as an extra QUOTE SOURCE in the best-of (swapRoute.ts) and as an alternative
 * bridge provider (commands/bridge.ts). The route is picked automatically: the highest
 * output means the deepest effective liquidity, and bridges tie-break on the fastest ETA.
 *
 * SECURITY -- LI.FI returns a DYNAMIC target and spender. This hot wallet has no
 * stop-loss, so calldata from an API is never executed against an arbitrary address:
 *  - the transaction's `to` and `approvalAddress` MUST be this chain's official
 *    LiFiDiamond (allowlist below, taken from li.quest/v1/chains). Anything else is refused.
 *  - approve the EXACT amount to the diamond, never MaxUint256.
 *  - the API's `out` is an ESTIMATE; the caller still verifies the balance delta.
 */

const LIFI_API = 'https://li.quest/v1';
const TIMEOUT_MS = 8000;

/** LiFiDiamond per chainId — allowlist target/spender. Sumber: li.quest/v1/chains. */
const DIAMOND: Record<number, string> = {
  4663: '0xB477751B76CF82d00a686A1232f5fCD772414Af3', // Robinhood
  999: '0x0a0758d937d1059c356D4714e57F5df0239bce1A', // HyperEVM
  8453: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', // Base
  56: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', // BSC
};

/** true when LI.FI is available on this chain (its diamond is known). */
export const lifiSupports = (ctx: ChainCtx): boolean => DIAMOND[ctx.chainId] !== undefined;

const isAllowed = (chainId: number, addr: string | undefined): boolean =>
  !!addr && !!DIAMOND[chainId] && addr.toLowerCase() === DIAMOND[chainId].toLowerCase();

/** LI.FI uses 0x000..0 for native, the same sentinel as ours. */
const tok = (a: string) => (a === NATIVE ? NATIVE : ethers.getAddress(a));

async function fetchQuote(params: Record<string, string>): Promise<any | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${LIFI_API}/quote?${new URLSearchParams(params)}`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Quote only, same chain, from -> to. Never executes. null when there is no route. */
export async function lifiQuoteOut(
  fromAddr: string,
  toAddr: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<bigint | null> {
  if (!lifiSupports(ctx)) return null;
  const q = await fetchQuote({
    fromChain: String(ctx.chainId),
    toChain: String(ctx.chainId),
    fromToken: tok(fromAddr),
    toToken: tok(toAddr),
    fromAmount: amountWei.toString(),
    fromAddress: ctx.wallet.address,
    slippage: String(SLIP_MAX_PCT / 100),
  });
  const raw = q?.estimate?.toAmount;
  try {
    return raw ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

/** Execute a same-chain from->to swap through LI.FI. The caller verifies the balance delta. */
export async function swapViaLifi(
  fromAddr: string,
  toAddr: string,
  amountWei: bigint,
  ctx: ChainCtx,
  slipPct = SLIP_MAX_PCT,
): Promise<{ txHashes: string[]; outWei: bigint }> {
  if (!lifiSupports(ctx)) throw new Error('LI.FI does not support this chain');
  const wallet = ctx.wallet;
  const q = await fetchQuote({
    fromChain: String(ctx.chainId),
    toChain: String(ctx.chainId),
    fromToken: tok(fromAddr),
    toToken: tok(toAddr),
    fromAmount: amountWei.toString(),
    fromAddress: wallet.address,
    slippage: String(Math.min(slipPct, SLIP_MAX_PCT) / 100),
  });
  if (!q) throw new Error('the LI.FI quote failed or came back empty');
  const tr = q.transactionRequest;
  const spender: string | undefined = q.estimate?.approvalAddress;
  // PINNED: the transaction target and the spender MUST be this chain's official diamond.
  // Anything else means the API is compromised or wrong -- abort before signing.
  if (!tr?.to || !isAllowed(ctx.chainId, tr.to)) {
    throw new Error(`unknown LI.FI target (${tr?.to}), refused for safety`);
  }
  if (fromAddr !== NATIVE && !isAllowed(ctx.chainId, spender)) {
    throw new Error(`unknown LI.FI spender (${spender}), refused for safety`);
  }
  const txHashes: string[] = [];
  // Approve the EXACT amount to the diamond, never MaxUint256. Native needs no approval.
  if (fromAddr !== NATIVE) {
    const erc = new ethers.Contract(
      fromAddr,
      ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
      wallet,
    );
    const allowance: bigint = await erc.allowance(wallet.address, spender!);
    if (allowance < amountWei) {
      const atx = await erc.approve(spender!, amountWei);
      await atx.wait();
      txHashes.push(atx.hash);
    }
  }
  const tx = await wallet.sendTransaction({
    to: tr.to,
    data: tr.data,
    value: tr.value ? BigInt(tr.value) : 0n,
    ...(tr.gasLimit ? { gasLimit: BigInt(tr.gasLimit) } : {}),
  });
  const rc = await tx.wait();
  if (rc) txHashes.push(rc.hash);
  let outWei = 0n;
  try {
    outWei = BigInt(q.estimate?.toAmount ?? '0');
  } catch {
    /* an estimate only; the caller measures from the balance */
  }
  return { txHashes, outWei };
}

// ─── bridge lintas chain (LI.FI) ────────────────────────────────────
import type { BridgeQuote } from './relay.js';

/** A native -> native bridge quote via LI.FI, shaped like Relay's so the two can be compared. */
export async function lifiBridgeQuote(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  opts: { originCurrency?: string; destinationCurrency?: string } = {},
): Promise<BridgeQuote> {
  if (!lifiSupports(from) || !lifiSupports(to)) throw new Error('LI.FI does not support one of these chains');
  const q = await fetchQuote({
    fromChain: String(from.chainId),
    toChain: String(to.chainId),
    fromToken: tok(opts.originCurrency ?? NATIVE),
    toToken: tok(opts.destinationCurrency ?? NATIVE),
    fromAmount: amountWei.toString(),
    fromAddress: from.wallet.address,
    toAddress: from.wallet.address,
    slippage: String(SLIP_MAX_PCT / 100),
  });
  if (!q) throw new Error('the LI.FI bridge quote failed');
  const tr = q.transactionRequest;
  if (!tr?.to || !isAllowed(from.chainId, tr.to)) {
    throw new Error(`unknown LI.FI bridge target (${tr?.to}), refused`);
  }
  // For an ERC20 the spender must be the diamond too. The approval happens in
  // executeBridgeVia -- a native bridge needs none, a token does -- so it is pinned here.
  if ((opts.originCurrency ?? NATIVE) !== NATIVE && !isAllowed(from.chainId, q.estimate?.approvalAddress)) {
    throw new Error(`unknown LI.FI bridge spender (${q.estimate?.approvalAddress}), refused`);
  }
  const outWei = BigInt(q.estimate?.toAmount ?? '0');
  if (outWei <= 0n) throw new Error('the LI.FI bridge quotes 0 out, so the route is unusable');
  // Decimals and symbol come from the token LI.FI returned. Never assume 18.
  const inTok = q.action?.fromToken ?? {};
  const outTok = q.action?.toToken ?? {};
  const fmt = (wei: bigint, dec: number, sym: string) => `${Number(ethers.formatUnits(wei, dec)).toFixed(6)} ${sym}`;
  const feeUsd = [...(q.estimate?.feeCosts ?? []), ...(q.estimate?.gasCosts ?? [])]
    .reduce((s: number, c: any) => s + Number(c.amountUSD ?? 0), 0);
  return {
    inLabel: fmt(amountWei, Number(inTok.decimals ?? 18), inTok.symbol ?? from.nativeSymbol),
    outLabel: fmt(outWei, Number(outTok.decimals ?? 18), outTok.symbol ?? to.nativeSymbol),
    outWei,
    impactPct: null,
    feeUsd: feeUsd || null,
    etaSec: q.estimate?.executionDuration != null ? Number(q.estimate.executionDuration) : null,
    steps: [{ to: tr.to, data: tr.data, value: tr.value ?? '0', approvalAddress: q.estimate?.approvalAddress }],
  };
}
