/**
 * /positions and /portfolio must see v4 on EVERY chain, not just the default one.
 *
 * Three BSC v4 positions sat recorded in v4store yet never showed up on any card,
 * because both paths only ever asked `getChain()` — Robinhood. This reads the
 * real chains and demands that every v4store record still alive on-chain gets
 * enumerated.
 */
import assert from 'node:assert/strict';
import { CHAINS, DEFAULT_CHAIN } from '../src/chains.js';
import { listPositionsV4, v4Supported } from '../src/uniswapV4.js';
import { allV4 } from '../src/v4store.js';

const chains = Object.values(CHAINS).filter((c) => v4Supported(c));
assert.ok(chains.length > 0, 'tak ada chain v4 sama sekali');

const terlihat = new Map<string, string>(); // tokenId → chain
for (const c of chains) {
  for (const p of await listPositionsV4(c).catch(() => [])) terlihat.set(p.tokenId, c.key);
}
console.log(`chain v4: ${chains.map((c) => c.key).join(', ')} · terenumerasi: ${terlihat.size} posisi`);

// The point of the test: records off the default chain must NOT go missing.
const luar = allV4().filter((r) => (r.chain ?? DEFAULT_CHAIN) !== DEFAULT_CHAIN);
console.log(`v4store di luar ${DEFAULT_CHAIN}: ${luar.length} record`);
for (const r of luar) {
  const dimana = terlihat.get(r.tokenId);
  assert.ok(
    dimana !== undefined,
    `posisi v4 ${r.tokenId} (${r.chain}) tak terenumerasi — daftar hanya membaca chain default lagi`,
  );
  assert.equal(dimana, r.chain, `posisi ${r.tokenId} terbaca di chain ${dimana}, seharusnya ${r.chain}`);
}

// Source guard: if either path reverts to a single chain, the test above only
// fails when a cross-chain position happens to be live. This fails right away.
const src = (await import('node:fs')).readFileSync('src/index.ts', 'utf8');
for (const [nama, pola] of [
  ['/positions', /const v4 = \(\s*\n\s*await Promise\.all\(\s*\n\s*Object\.values\(CHAINS\)/],
  ['/portfolio', /const v4P = Promise\.all\(\s*\n\s*Object\.values\(CHAINS\)/],
] as const)
  assert.match(src, pola, `${nama} tak lagi menyapu semua chain v4`);

console.log('ok — v4 terbaca lintas chain di /positions & /portfolio');
