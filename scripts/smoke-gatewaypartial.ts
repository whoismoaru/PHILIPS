/**
 * One runnable check for the GraphQL gateway's PARTIAL responses.
 *
 * On Robinhood every v4 pool answers "external API error" for cumulativeVolume
 * while the pool itself arrives intact. Treating a non-empty errors[] as total
 * failure threw away 37 good pools on every /add and fell through to the slow
 * on-chain fallback. Both directions matter, so both are asserted: partial data
 * must survive, and a genuinely empty error response must still throw.
 */
import assert from 'node:assert';
import * as explore from '../src/explore.js';
import { getChain } from '../src/chains.js';

const cc = getChain('robinhood');
const CA = '0x78b96280C3347E0f58a7147B73eb0EC5fFFf025d';
const asli = globalThis.fetch;
const balas = (body: unknown) =>
  (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof globalThis.fetch;

const pool = {
  protocolVersion: 'V4',
  feeTier: 50000,
  totalLiquidity: { value: 196206 },
  cumulativeVolume: null, // the field the gateway failed on
  token0: { symbol: 'USDG', address: '0x' + '1'.repeat(40) },
  token1: { symbol: 'RSTR', address: CA },
  tickSpacing: 60,
  hook: null,
};

async function main() {
  // 1. Partial: errors[] populated, data intact -> the pool must come through.
  globalThis.fetch = balas({
    data: { topV3Pools: [], topV4Pools: [pool] },
    errors: [{ message: 'external API error', path: ['topV4Pools', 0, 'cumulativeVolume'] }],
  });
  const parsial = await explore.poolsForToken(cc, CA);
  assert.equal(parsial.length, 1, 'balasan parsial dibuang — bug 9 Sep kambuh');
  assert.equal(parsial[0].vol24hUsd ?? 0, 0, 'volume yang hilang harus terbaca 0, bukan NaN');

  // 2. Empty: errors[] populated, no payload -> still a real failure.
  globalThis.fetch = balas({ data: { topV3Pools: [], topV4Pools: [] }, errors: [{ message: 'external API error' }] });
  await assert.rejects(() => explore.poolsForToken(cc, CA), /external API error/, 'balasan kosong harus tetap melempar');

  globalThis.fetch = asli;
  console.log('ok: balasan parsial lolos, balasan kosong tetap melempar');
}
main();
