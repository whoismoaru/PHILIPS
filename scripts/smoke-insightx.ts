import assert from 'node:assert/strict';
import { insightxMetrics } from '../src/insightx.js';

/**
 * Guard against InsightX failing silently.
 *
 * An unindexed chain does NOT come back as an error — it comes back 200 with
 * every field 0. Taken at face value, the audit card prints "Cluster 0% ✅" for a
 * token nobody ever checked. That is a lie in the safe direction, the most
 * expensive kind this card can tell. So: an all-zero payload MUST become null
 * ('?'), never zero.
 */
const asli = globalThis.fetch;
const jawab = (body: unknown) =>
  ((async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch);

process.env.INSIGHTX_API_KEY = 'test-key';

try {
  // 1. All-zero payload (unindexed chain) -> null, NOT zero.
  globalThis.fetch = jawab({
    cluster_pct: 0, snipers_pct: 0, bundlers_pct: 0, dev_pct: 0, insiders_pct: 0, top10_pct: 0,
  });
  assert.equal(await insightxMetrics('0x1111111111111111111111111111111111111111', 'bsc'), null,
    'payload semua-nol harus dibaca sebagai TAK ADA DATA');

  // 2. Real payload -> parsed. cluster_pct 0 is legitimate here because
  //    top10_pct is populated.
  globalThis.fetch = jawab({
    cluster_pct: 0, snipers_pct: 0.19, bundlers_pct: 45.9, dev_pct: 0, insiders_pct: 40.7, top10_pct: 33.5,
  });
  const v = await insightxMetrics('0x2222222222222222222222222222222222222222', 'bsc');
  assert.ok(v, 'payload dengan top10_pct terisi harus terbaca');
  assert.equal(v.clusterPct, 0, 'cluster 0% yang SAH tak boleh ikut dibuang');
  assert.equal(v.bundlersPct, 45.9);

  // 3. Robinhood is unmapped -> no call at all, so no quota burned.
  globalThis.fetch = (() => assert.fail('robinhood tak boleh memanggil InsightX')) as unknown as typeof fetch;
  assert.equal(await insightxMetrics('0x3333333333333333333333333333333333333333', 'robinhood'), null);

  // 4. No API key -> stays quiet, makes no call.
  delete process.env.INSIGHTX_API_KEY;
  assert.equal(await insightxMetrics('0x4444444444444444444444444444444444444444', 'bsc'), null);
} finally {
  globalThis.fetch = asli;
}

console.log('smoke-insightx: OK');
