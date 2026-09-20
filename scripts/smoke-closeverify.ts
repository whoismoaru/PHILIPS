/**
 * One runnable check on the rule that a close must be PROVEN, not assumed, on EVERY path.
 *
 * On 20 Sep 2026 a BSC v4 position was closed from the
 * bot. The card said "✅ POSITION CLOSED" and carried transaction
 * its hash. That transaction
 * REVERTED: receipt status 0x0, gasUsed 166492 of a 324974 limit, so not out of gas. The
 * simulation before it had passed, which is the signature of a price floor being crossed
 * between simulating and landing.
 *
 * The position was dropped from tracking anyway, because the close function returned
 * without throwing, and returning was treated as evidence. It stayed owned by the wallet
 * with 9179886438878373473743 units of liquidity, and on BSC nothing could find it again:
 * LOGS_RPC carries only Robinhood, so v4store is the single source of v4 positions there.
 * Real money in a live LP the bot no longer knew about. The journal also recorded a close
 * that never happened, which would have counted a phantom trade in /pnl.
 *
 * All FOUR close paths had the same shape, so all four are checked here: v3 single, v3
 * ladder, v4 single, v4 ladder.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const v4 = readFileSync('src/uniswapV4.ts', 'utf8');
const v3 = readFileSync('src/uniswap.ts', 'utf8');
const idx = readFileSync('src/index.ts', 'utf8');

// --- One helper per protocol, declared once ---
for (const [file, src, fn] of [
  ['src/uniswapV4.ts', v4, 'v4StillOpen'],
  ['src/uniswap.ts', v3, 'v3StillOpen'],
] as const) {
  const decls = (src.match(new RegExp(`export async function ${fn}`, 'g')) ?? []).length;
  assert.equal(decls, 1, `${fn} is declared ${decls} times in ${file}; it belongs there exactly once`);

  // Only liquidity PRESENT may be read as failure. A burn makes the read revert, and so
  // does a dead RPC, so "unreadable" cannot be told apart from "closed" and must not
  // decide anything -- otherwise a flaky endpoint reports healthy closes as failures.
  const body = src.slice(src.indexOf(`export async function ${fn}`));
  assert.ok(/r\.liq > 0n/.test(body), `${fn} must key on liquidity still being present`);
  assert.ok(!/r\.liq < 0n[\s\S]{0,40}\.map/.test(body), `${fn} treats an unreadable position as still open`);
}

// --- Every close path verifies, BEFORE it mutates tracking, and can stop the flow ---
const PATHS = [
  { label: 'v4 single', marker: 'const alive = await v4StillOpen(cc, [tokenId])', drops: 'v4store.removeV4' },
  { label: 'v4 ladder', marker: 'const aliveLegs = await v4StillOpen(cc, tokenIds)', drops: 'v4store.removeV4' },
  { label: 'v3 single', marker: 'const aliveV3 = await v3StillOpen(ccClose, [tokenId])', drops: 'finalizeClose' },
  { label: 'v3 ladder', marker: 'const aliveLegsV3 = await v3StillOpen(cc, legs.map', drops: 'finalizeClose' },
] as const;

/** The body of the function containing `at`, so ordering is judged inside ONE function.
 *  Searching the whole file forward is useless: it always finds some later call in another
 *  function and passes, which is exactly how an earlier version of this guard missed a
 *  verification moved to AFTER the untrack. */
function enclosingFn(src: string, at: number): string {
  const start = src.lastIndexOf('\nasync function ', at);
  const from = start < 0 ? src.lastIndexOf('\nfunction ', at) : start;
  const next = src.indexOf('\nasync function ', at);
  const alt = src.indexOf('\nfunction ', at);
  const to = Math.min(next < 0 ? src.length : next, alt < 0 ? src.length : alt);
  return src.slice(from < 0 ? 0 : from, to);
}

for (const { label, marker, drops } of PATHS) {
  const at = idx.indexOf(marker);
  assert.ok(at > 0, `the ${label} close path does not verify the position is gone`);

  // The check must come before anything is journalled or untracked, IN ITS OWN FUNCTION.
  // The tracking mutation this close performs must come AFTER the verification. Asserting
  // "no drop appears earlier" would be wrong: execCloseV4 legitimately drops a position
  // first when its chain cannot be resolved, which means it was already closed.
  const fn = enclosingFn(idx, at);
  const vAt = fn.indexOf(marker);
  const dAt = fn.indexOf(drops, vAt);
  assert.ok(
    dAt > vAt,
    `the ${label} path performs no ${drops} after verifying; the check cannot be guarding anything`,
  );

  // And it must be able to STOP. A check whose failure only logs would have changed
  // nothing on 20 Sep.
  const window = idx.slice(at, at + 900);
  assert.ok(/throw new Error/.test(window), `${label} does not throw when the position is still open`);
  assert.ok(/still hold/.test(window), `${label} must say the position is still the owner's`);
  // Naming the position is what makes it findable again after a failure.
  assert.ok(/#\$\{tokenId\}|#\$\{aliveLegs/.test(window), `${label} must name the position id`);
}

console.log(`smoke-closeverify OK (${PATHS.length} close paths verified)`);
