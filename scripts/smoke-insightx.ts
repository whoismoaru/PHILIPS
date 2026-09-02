import assert from 'node:assert/strict';
import { insightxMetrics } from '../src/insightx.js';

/**
 * Penjaga kegagalan-senyap InsightX.
 *
 * Chain yang belum diindeks TIDAK dijawab error — dijawab 200 dengan semua field
 * 0. Dibaca apa adanya, kartu audit menulis "Cluster 0% ✅" untuk token yang tak
 * pernah diperiksa siapa pun. Itu bohong ke arah aman, kesalahan termahal di
 * kartu ini. Tesnya: payload nol WAJIB jadi null ('?'), bukan nol.
 */
const asli = globalThis.fetch;
const jawab = (body: unknown) =>
  ((async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch);

process.env.INSIGHTX_API_KEY = 'test-key';

try {
  // 1. Payload nol (chain tak terindeks) -> null, BUKAN nol.
  globalThis.fetch = jawab({
    cluster_pct: 0, snipers_pct: 0, bundlers_pct: 0, dev_pct: 0, insiders_pct: 0, top10_pct: 0,
  });
  assert.equal(await insightxMetrics('0x1111111111111111111111111111111111111111', 'bsc'), null,
    'payload semua-nol harus dibaca sebagai TAK ADA DATA');

  // 2. Payload nyata -> terbaca. cluster_pct 0 di sini sah, karena top10_pct terisi.
  globalThis.fetch = jawab({
    cluster_pct: 0, snipers_pct: 0.19, bundlers_pct: 45.9, dev_pct: 0, insiders_pct: 40.7, top10_pct: 33.5,
  });
  const v = await insightxMetrics('0x2222222222222222222222222222222222222222', 'bsc');
  assert.ok(v, 'payload dengan top10_pct terisi harus terbaca');
  assert.equal(v.clusterPct, 0, 'cluster 0% yang SAH tak boleh ikut dibuang');
  assert.equal(v.bundlersPct, 45.9);

  // 3. Robinhood tak dipetakan -> tak ada panggilan sama sekali (kuota tak terbakar).
  globalThis.fetch = (() => assert.fail('robinhood tak boleh memanggil InsightX')) as unknown as typeof fetch;
  assert.equal(await insightxMetrics('0x3333333333333333333333333333333333333333', 'robinhood'), null);

  // 4. Tanpa API key -> diam, tak memanggil.
  delete process.env.INSIGHTX_API_KEY;
  assert.equal(await insightxMetrics('0x4444444444444444444444444444444444444444', 'bsc'), null);
} finally {
  globalThis.fetch = asli;
}

console.log('smoke-insightx: OK');
