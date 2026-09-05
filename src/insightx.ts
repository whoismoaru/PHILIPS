/**
 * Holder-cluster metrics from InsightX (https://api.insightx.network).
 *
 * A single `dex-metrics overview` call returns all six numbers at once (~180
 * bytes). The detailed endpoints — /clusters, /bundlers, /insiders — ship 300-400
 * KB per token, which is not something a Telegram card should be pulling, so they
 * are left alone.
 *
 * EVERY failure fails open (null), same as gmgn.ts: this is supplementary data.
 */

const BASE = 'https://api.insightx.network/dex-metrics/v1';
const TIMEOUT_MS = 4_000;

/**
 * PHILIPS key -> InsightX chain name. Not in the map means no call is made.
 *
 * `robinhood` is absent DELIBERATELY: the API rejects it with 422 ("Input should
 * be 'eth', 'sol', 'base', 'bsc' or 'sui'"). Mapping it would only burn quota.
 */
const CHAIN: Record<string, string> = { bsc: 'bsc' };

export type InsightXMetrics = {
  clusterPct: number | null;
  bundlersPct: number | null;
  insidersPct: number | null;
  snipersPct: number | null;
};

const cache = new Map<string, { t: number; v: InsightXMetrics | null }>();
const TTL = 60_000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function insightxMetrics(
  tokenAddress: string,
  chainKey: string,
): Promise<InsightXMetrics | null> {
  const net = CHAIN[chainKey];
  const key = process.env.INSIGHTX_API_KEY;
  if (!net || !key) return null;

  const cacheKey = `${net}:${tokenAddress.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  let v: InsightXMetrics | null = null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${net}/${tokenAddress}`, {
      headers: { 'X-API-Key': key },
      signal: ctrl.signal,
    });
    if (res.ok) {
      const d: any = await res.json();
      // A token on an unindexed chain still comes back 200 — with EVERY field 0,
      // not an error. Taken at face value the card prints "cluster 0% ✅" for a
      // token nobody checked: an audit lying in the safe direction. The tell is
      // top10_pct, which cannot be 0 for a token that has holders. Zero there
      // means NO DATA, so null.
      if (num(d?.top10_pct)) {
        v = {
          clusterPct: num(d.cluster_pct),
          bundlersPct: num(d.bundlers_pct),
          insidersPct: num(d.insiders_pct),
          snipersPct: num(d.snipers_pct),
        };
      }
    }
  } catch {
    /* fail open */
  } finally {
    clearTimeout(t);
  }

  cache.set(cacheKey, { t: Date.now(), v });
  return v;
}
