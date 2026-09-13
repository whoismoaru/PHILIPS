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
assert.ok(chains.length > 0, 'there are no v4 chains at all');

const seen = new Map<string, string>(); // tokenId → chain
for (const c of chains) {
  for (const p of await listPositionsV4(c).catch(() => [])) seen.set(p.tokenId, c.key);
}
console.log(`chain v4: ${chains.map((c) => c.key).join(', ')} · enumerated: ${seen.size} positions`);

// The point of the test: records off the default chain must NOT go missing.
const luar = allV4().filter((r) => (r.chain ?? DEFAULT_CHAIN) !== DEFAULT_CHAIN);
console.log(`v4store di luar ${DEFAULT_CHAIN}: ${luar.length} record`);
for (const r of luar) {
  const where = seen.get(r.tokenId);
  assert.ok(
    where !== undefined,
    `v4 position ${r.tokenId} (${r.chain}) was not enumerated: the list is reading only the default chain again`,
  );
  assert.equal(where, r.chain, `position ${r.tokenId} was read on chain ${where}, expected ${r.chain}`);
}

// Source guard: if either path reverts to a single chain, the test above only
// fails when a cross-chain position happens to be live. This fails right away.
const src = (await import('node:fs')).readFileSync('src/index.ts', 'utf8');
for (const [name, pattern] of [
  ['/positions', /const v4 = \(\s*\n\s*await Promise\.all\(\s*\n\s*Object\.values\(CHAINS\)/],
  ['/portfolio', /const v4P = Promise\.all\(\s*\n\s*Object\.values\(CHAINS\)/],
] as const)
  assert.match(src, pattern, `${name} no longer sweeps every v4 chain`);

// Every path that acts on a single v4 tokenId must resolve the POSITION's chain. Using
// getChain() there asks the default chain about another chain's id: ownerOf reverts
// NOT_MINTED and a close reports failure for a position it never touched.
for (const [name, pattern] of [
  // The close handler became a named executor (reused by Close All), so the anchor is
  // the function rather than its registration line.
  ['close v4', /async function execCloseV4\(ctx: any\) \{[\s\S]{0,900}?v4ChainOf\(tokenId\)/],
  ['v4 card refresh', /posv4:\(\\d\+\)\$\/[\s\S]{0,200}?v4ChainOf\(ctx\.match\[1\]\)/],
  ['detail v4', /Object\.values\(CHAINS\)\.filter\(\(x\) => v4Supported\(x\)\)/],
] as const)
  assert.match(src, pattern, `${name} no longer resolves its own position's chain`);

console.log('ok — v4 terbaca lintas chain di /positions, /portfolio, detail, refresh & close');
