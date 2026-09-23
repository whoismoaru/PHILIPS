/**
 * Gas prices for every EVM transaction, from each chain's OFFICIAL RPC, at the "high" level.
 *
 * High = the next block's base fee plus the 75th-percentile tip of recent blocks
 * (eth_feeHistory). No ceiling on top: the owner chose to pay the chain's own high rate
 * whatever it is (23 Sep 2026). Where the official endpoint does not answer, the trading
 * provider's own figures are used, so a dead endpoint never blocks a transaction.
 *
 * Installed as the provider's getFeeData (chains.ts), which ethers consults for every
 * transaction it fills -- contract calls, aggregator txs and plain transfers alike.
 */
import { ethers } from 'ethers';

export const OFFICIAL_RPC: Record<number, string> = {
  4663: 'https://rpc.mainnet.chain.robinhood.com',
  56: 'https://bsc-dataseed.bnbchain.org',
  8453: 'https://mainnet.base.org',
  999: 'https://rpc.hyperliquid.xyz/evm',
  57073: 'https://rpc-gel.inkonchain.com',
};

/** The tip percentile read from fee history: 75 is "high". */
export const HIGH_PCTL = 75;

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message ?? 'rpc error');
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map<number, { v: ethers.FeeData; t: number }>();

/** High fee data from the official endpoint, or null when it cannot be read. */
export async function officialHighFees(chainId: number): Promise<ethers.FeeData | null> {
  const url = OFFICIAL_RPC[chainId];
  if (!url) return null;
  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.t < 10_000) return hit.v;
  try {
    const h = await rpc(url, 'eth_feeHistory', ['0x5', 'latest', [HIGH_PCTL]]);
    const bases: bigint[] = (h?.baseFeePerGas ?? []).map((x: string) => BigInt(x));
    // The last entry is the NEXT block's base fee: what this transaction will actually meet.
    const base = bases.length ? bases[bases.length - 1] : 0n;
    const tips = ((h?.reward ?? []) as string[][]).map((r) => BigInt(r?.[0] ?? '0x0')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let tip = tips.length ? tips[Math.floor(tips.length / 2)] : 0n;
    let v: ethers.FeeData;
    if (base > 0n) {
      // 2x base covers several full blocks of base-fee rise before the tx could be priced out;
      // only base + tip is actually charged.
      v = new ethers.FeeData(null, base * 2n + tip, tip);
    } else {
      // No base fee (BSC): a flat price. The node's own quote if it is higher than the tip.
      const gp = BigInt(await rpc(url, 'eth_gasPrice', []));
      if (gp > tip) tip = gp;
      v = new ethers.FeeData(tip, tip, tip);
    }
    cache.set(chainId, { v, t: Date.now() });
    return v;
  } catch {
    return null;
  }
}
