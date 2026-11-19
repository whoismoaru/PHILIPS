import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rangeEdges, tickAtRatio } from '../src/lpmath.js';
import { binEdges, binAtRatio } from '../src/solana/lp.js';

/**
 * A limit entry is a range order: the position goes on-chain at once, hung from the target.
 *
 * It used to be a watcher that opened a normal LP once mcap crossed the target. On a fast
 * dump the open landed seconds later, below the target, and the whole range came with it:
 * MAGGIE on 8 Nov 2026 fell 440K -> 329K in the trigger minute and the range opened at
 * ~381K. Now both ends are fixed by the target, so nothing can drag them.
 */

// --- EVM ticks: no target is the old flush behaviour, unchanged ---
assert.deepEqual(rangeEdges(105, 10, false, 100), { near: 100, far: 0 }, 'base token1: flush below');
assert.deepEqual(rangeEdges(100, 10, false, 100), { near: 90, far: -10 }, 'on a spacing multiple: strictly below');
assert.deepEqual(rangeEdges(105, 10, true, 100), { near: 110, far: 210 }, 'base token0: flush above');
assert.deepEqual(rangeEdges(100, 10, true, 100), { near: 110, far: 210 }, 'on a spacing multiple: strictly above');

// --- with a target: the range hangs from it ---
assert.deepEqual(rangeEdges(1000, 10, false, 100, 800.4), { near: 800, far: 700 }, 'near edge at the target, never above it');
assert.deepEqual(rangeEdges(1000, 10, true, 100, 1204.2), { near: 1210, far: 1310 }, 'mirror for base token0');
// The price already fell past the target: the near edge falls back to flush, the far edge stays put.
// (A target on a spacing multiple counts like the price on one: strictly past it, 790.)
assert.deepEqual(rangeEdges(750, 10, false, 100, 800), { near: 740, far: 690 }, 'far edge must not move');
assert.throws(() => rangeEdges(650, 10, false, 100, 800), /fallen through the whole range/, 'past the far edge: refuse');

// tickAtRatio: the token price per base is 1.0001^(sgn*tick), sgn = -1 when the base is token0.
const half1 = tickAtRatio(0, false, 0.5);
const half0 = tickAtRatio(0, true, 0.5);
assert.ok(Math.abs(Math.pow(1.0001, half1) - 0.5) < 1e-9, 'base token1: tick down halves the price');
assert.ok(Math.abs(Math.pow(1.0001, -half0) - 0.5) < 1e-9, 'base token0: tick up halves the price');
// End to end: the near edge's price never sits above the target.
const near1 = rangeEdges(0, 60, false, 6000, half1).near;
assert.ok(Math.pow(1.0001, near1) <= 0.5, 'base token1 near edge is at or below the target');
const near0 = rangeEdges(0, 60, true, 6000, half0).near;
assert.ok(Math.pow(1.0001, -near0) <= 0.5, 'base token0 near edge is at or below the target');

// --- Solana bins: no target is the old layout ---
assert.deepEqual(binEdges(0, false, 10), { minBinId: -10, maxBinId: -1 }, 'base Y: below the active bin');
assert.deepEqual(binEdges(0, true, 10), { minBinId: 1, maxBinId: 10 }, 'base X: above it');
assert.deepEqual(binEdges(0, false, 10, -20), { minBinId: -29, maxBinId: -20 }, 'hung from the target bin itself');
assert.deepEqual(binEdges(0, true, 10, 20), { minBinId: 21, maxBinId: 30 }, 'mirror for base X');
assert.deepEqual(binEdges(-25, false, 10, -20), { minBinId: -29, maxBinId: -26 }, 'price past the target: far end stays');
assert.throws(() => binEdges(-31, false, 10, -20), /fallen through the whole range/, 'past the far end: refuse');

// binAtRatio, bin step 100 (1%). A DLMM bin trades at ONE price, so the near bin's own price is
// at or below the target, and within one bin of it: the edge is not left a bin short (19 Nov 2026).
const tY = binAtRatio(0, 100, false, 0.5);
assert.equal(tY, -70);
const topY = binEdges(0, false, 10, tY).maxBinId;
assert.ok(Math.pow(1.01, topY) <= 0.5, 'base Y: top bin at or below the target');
assert.ok(Math.pow(1.01, topY + 1) > 0.5, 'base Y: top bin within one bin of the target');
const tX = binAtRatio(0, 100, true, 0.5);
const nearX = binEdges(0, true, 10, tX).minBinId;
assert.ok(1 / Math.pow(1.01, nearX) <= 0.5, 'base X: near bin at or below the target');
assert.ok(1 / Math.pow(1.01, nearX - 1) > 0.5, 'base X: near bin within one bin of the target');

// --- wiring: every planner call in the bot carries the limit's target ---
const idx = readFileSync('src/index.ts', 'utf8');
for (const fn of ['planAddSingleSided', 'planLadderSingleSided', 'planLadderV4', 'openPositionV4(cc']) {
  const calls = idx.split('\n').filter((l) => (l.includes(`${fn}(`) || (fn.endsWith('(cc') && l.includes(fn))) && !l.includes('(...args)'));
  assert.ok(calls.length > 0, `${fn} is never called`);
  for (const l of calls) assert.ok(/limitTick/.test(l), `${fn} call without the limit target: ${l.trim()}`);
}
assert.ok(/const args = \[[^\]]*flow\.limitTick\] as const/.test(idx), 'the v3 single open must re-plan with the target');
for (const l of idx.split('\n').filter((x) => /await (planLadder|openPosition|quoteOpenCost)\(f\.pick\.pool/.test(x) && !/legs\[k\]|, l\)/.test(x)))
  assert.ok(/limitBin/.test(l), `Solana call without the limit target: ${l.trim()}`);
// No watcher for new entries: the reply places the position through the amount handlers.
const reply = idx.slice(idx.indexOf('async function handleLimitReply'), idx.indexOf('async function cmdLimits'));
assert.ok(!/limits\.add\(\{ \.\.\.d\.order, targetMcap: target, amount, dir: 'below' \}\)/.test(reply), 'entries must not be saved as watchers');
assert.ok(/handleSolLpAmount\(ctx, amount\)/.test(reply) && /handleAddAmount\(ctx, amount\)/.test(reply), 'the reply must open through the amount handlers');
// The edge is placed against the mcap at the pool's LIVE price, and the dip check uses it too.
const helpers = idx.slice(idx.indexOf('async function evmLimitTick'), idx.indexOf('async function poolMcapNow'));
assert.equal(helpers.split('poolMcapNow(').length - 1, 3, 'v3, v4 and DLMM must each price the target live');
assert.ok(/target >= nowLive/.test(reply), 'the dip check must use the live mcap');
// The take-profit watcher and the /positions range read mcap the same way the edge is placed:
// DexScreener's token mcap against the live price ran up to 9% off in a fast move (19 Nov 2026).
const watch = idx.slice(idx.indexOf('async function limitMcap'), idx.indexOf('async function posPnl'));
assert.ok(/poolMcapNow\(/.test(watch), 'the take-profit watcher must price mcap at the pool live price');
const rows = idx.slice(idx.indexOf('async function solanaRows'), idx.indexOf('async function cmdPositions'));
assert.ok(/poolMcapNow\(/.test(rows) && /anchorMcap = mcPool \?\? mcNow/.test(rows), 'the /positions anchor must price mcap at the pool live price');

console.log('ok: a limit entry is a range order hung from its target, on v3, v4 and DLMM');
