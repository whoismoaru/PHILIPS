/**
 * One runnable check on the rule that a v4 close must be PROVEN, not assumed.
 *
 * On 20 Sep 2026 a BSC v4 position was closed from the
 * bot. The card said "✅ POSITION CLOSED" and carried transaction
 * its hash. That transaction
 * REVERTED: receipt status 0x0, gasUsed 166492 of a 324974 limit, so not out of gas. The
 * simulation before it had passed, which is the signature of a price floor being crossed
 * between simulating and landing.
 *
 * The position was dropped from tracking anyway, because the close function returned
 * without throwing, and returning was treated as evidence. It was still owned by the
 * wallet afterwards and still held 9179886438878373473743 units of liquidity: real money
 * in a live LP the bot could no longer see.
 *
 * The rule this guards: liquidity still present means the close did not happen, whatever
 * the receipt said, and nothing may be journalled or untracked until that is checked.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const v4 = readFileSync('src/uniswapV4.ts', 'utf8');
const idx = readFileSync('src/index.ts', 'utf8');

// --- The check exists, and is one function rather than two copies ---
assert.ok(v4.includes('export async function v4StillOpen'), 'v4StillOpen went missing');
assert.equal(
  (v4.match(/export async function v4StillOpen/g) ?? []).length,
  1,
  'v4StillOpen is declared more than once',
);

// --- Only liquidity PRESENT may be read as failure ---
// An unreadable position (a burn makes getPositionLiquidity revert, and so does a dead
// RPC) must not be judged either way, or a flaky endpoint would start reporting healthy
// closes as failures.
const body = v4.slice(v4.indexOf('export async function v4StillOpen'));
assert.ok(/r\.liq > 0n/.test(body), 'the check must key on liquidity still being present');
assert.ok(!/r\.liq < 0n\s*\)\s*\.map/.test(body), 'an unreadable position must not be reported as still open');

// --- Both close paths verify, and BEFORE they untrack ---
for (const [label, marker] of [
  ['single position', 'const alive = await v4StillOpen(cc, [tokenId])'],
  ['ladder', 'const aliveLegs = await v4StillOpen(cc, tokenIds)'],
] as const) {
  assert.ok(idx.includes(marker), `the ${label} close path does not verify the burn`);
  const at = idx.indexOf(marker);
  const untrack = idx.indexOf('v4store.removeV4', at);
  assert.ok(untrack > at, `the ${label} path untracks before it verifies`);
}

// The verification must be able to STOP the flow. A check whose failure only logs would
// have changed nothing on 20 Sep.
for (const marker of ['const alive = await v4StillOpen', 'const aliveLegs = await v4StillOpen']) {
  const at = idx.indexOf(marker);
  const window = idx.slice(at, at + 900);
  assert.ok(/throw new Error/.test(window), `${marker} does not throw when the position is still open`);
  assert.ok(/still hold|still holds/.test(window), 'the error must say the position is still the owner\'s');
}

// --- The error has to name the position, so it can be found again ---
const single = idx.slice(idx.indexOf('const alive = await v4StillOpen'), idx.indexOf('const alive = await v4StillOpen') + 900);
assert.ok(/#\$\{tokenId\}/.test(single), 'the failure must name the position id');

console.log('smoke-closeverify OK');
