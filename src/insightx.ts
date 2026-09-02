/**
 * Metrik klaster holder dari InsightX (https://api.insightx.network).
 *
 * Satu panggilan `dex-metrics overview` mengembalikan enam angka sekaligus
 * (~180 byte). Endpoint rincinya — /clusters, /bundlers, /insiders — mengirim
 * 300-400 KB per token; itu bukan untuk kartu Telegram, jadi tak dipakai.
 *
 * SEMUA kegagalan fail-open (null), sama seperti gmgn.ts: ini data TAMBAHAN.
 */

const BASE = 'https://api.insightx.network/dex-metrics/v1';
const TIMEOUT_MS = 4_000;

/**
 * PHILIPS key → nama chain InsightX. Tak ada di peta = tak dipanggil sama sekali.
 *
 * `robinhood` SENGAJA tidak ada: API-nya menolaknya dengan 422 ("Input should be
 * 'eth', 'sol', 'base', 'bsc' or 'sui'"). Memetakannya cuma membakar kuota.
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
      // Token yang chain-nya belum terindeks tetap dijawab 200 — dengan SEMUA
      // field 0, bukan error. Dibaca apa adanya, kartu menulis "cluster 0% ✅"
      // untuk token yang sebenarnya tak diperiksa siapa pun: audit yang berbohong
      // ke arah aman. Penanda palsunya adalah top10_pct — mustahil 0 pada token
      // yang punya holder. Nol di situ = TAK ADA DATA, jadi null.
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
    /* fail-open */
  } finally {
    clearTimeout(t);
  }

  cache.set(cacheKey, { t: Date.now(), v });
  return v;
}
