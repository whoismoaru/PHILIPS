/**
 * Solana priority fee at the "high" level, from the OFFICIAL public RPC: the 75th percentile
 * of what recent transactions touching `account` paid, in micro-lamports per compute unit.
 * No ceiling (the owner's call, 23 Sep 2026). The configured RPC is the fallback when the
 * public one does not answer.
 *
 * Asked with no account the RPC returns each slot's MINIMUM, almost always 0, so a busy pool
 * stands in when the caller has no better account (Raydium SOL/USDC).
 */
import { solRpc } from './rpc.js';

export const SOL_OFFICIAL_RPC = 'https://api.mainnet-beta.solana.com';
export const BUSY_ACCOUNT = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

const p75 = (list: any[]): number => {
  const fees = (list ?? []).map((x: any) => Number(x?.prioritizationFee)).filter((f) => f > 0).sort((a, b) => a - b);
  return fees.length ? fees[Math.floor(fees.length * 0.75)] : 0;
};

export async function highPriorityMicro(account: string = BUSY_ACCOUNT): Promise<{ micro: number; official: boolean } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(SOL_OFFICIAL_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [[account]] }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const j = r.ok ? await r.json() : null;
    if (Array.isArray(j?.result)) return { micro: p75(j.result), official: true };
  } catch {
    /* fall through to the configured RPC */
  }
  const own = await solRpc<any[]>('getRecentPrioritizationFees', [[account]]).catch(() => null);
  return own ? { micro: p75(own), official: false } : null;
}

/**
 * Hand the same signed bytes to the official RPC too. One provider that fails to forward
 * lets a transaction die unseen (24 Sep 2026: a DLMM open bid 0.00095 SOL and still never
 * landed); two independent paths to the leader make that much rarer. Same signature, so it
 * can land at most once. Fire-and-forget: the configured RPC stays the one that confirms.
 */
export function broadcastOfficial(base64: string): void {
  fetch(SOL_OFFICIAL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [base64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
  }).catch(() => {});
}
