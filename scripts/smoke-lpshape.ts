import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The SPOT / BID-ASK choice moved from the wizard into /settings.
 *
 * Two things must hold for that to be safe: the wizard reads the stored default instead
 * of asking, and only the BASE side can ladder — the token side has always been a single
 * spot position, and laddering it would open legs the wallet cannot fund.
 */
const idx = readFileSync('src/index.ts', 'utf8');
const wal = readFileSync('src/commands/wallet.ts', 'utf8');
const pct = readFileSync('src/pctPresets.ts', 'utf8');

assert.ok(!/renderShapeStep/.test(idx), 'the shape step must be gone from the wizard');
assert.ok(/pctPresets\.shape\(\) === 'bidask'/.test(idx), 'the wizard must read the shape setting');
assert.ok(/flow\.strategy === 'base' && pctPresets\.shape\(\)/.test(idx),
  'only the base side may ladder; the token side must stay a single spot');

assert.ok(/bot\.action\('lpshape'/.test(wal), 'the shape toggle is missing from /settings');
assert.ok(/LP shape: \$\{sh === 'bidask'/.test(wal), 'the toggle must name the value currently set');

// A missing or corrupt file must read as SPOT, never crash a deposit mid-flow.
assert.ok(/return 'spot'; \/\/ one position/.test(pct), 'a failed read must fall back to spot');
assert.ok(/v === 'bidask' \? 'bidask' : 'spot'/.test(pct), 'an unknown value must be treated as spot');

console.log('ok: the LP shape is a setting, the wizard reads it, and the token side stays spot');

// --- the deposit amount is the LAST step, and it opens the position ---
// Reordered so the money question is the final one: range and legs are decided first,
// then the amount fires the deposit. What the Confirm button used to guard still runs,
// because the direct path calls the SAME execAdd.
assert.equal((idx.match(/async function execAdd\(/g) ?? []).length, 1, 'execAdd must exist exactly once');
assert.ok(/bot\.action\('addok'/.test(idx), 'the old Confirm button must stay registered');
assert.ok(/await planThenOpen\(ctx, flow\)/.test(idx), 'the deposit amount must trigger the open');
assert.equal((idx.match(/await planThenOpen\(ctx, flow\)/g) ?? []).length, 2,
  'both amount paths, the percentage buttons and a typed number, must trigger the same thing');
const plan = idx.slice(idx.indexOf('async function planThenOpen'), idx.indexOf('async function planThenOpen') + 1800);
// No confirmation card between the amount and the deposit: the plan is computed silently
// so execAdd still has the range, the legs and the v4 leg list to work from.
assert.ok(/renderPlanStep\(point, flow, false, true\)/.test(plan), 'the plan must be computed silently, not shown');
assert.ok(/msgProgress/.test(plan), 'there must be one progress bubble for the edits to target');
assert.ok(/config\.safety\.dryRun/.test(plan), 'a dry run must never open a position');
assert.ok(/return execAdd\(point\)/.test(plan), 'the open must go through execAdd, not a copy of it');
// execAdd edits the card it was tapped on. A typed amount has no such card, so the plan
// card's id must be captured and every edit pointed at it -- otherwise the deposit runs
// but its progress and result are never shown.
assert.ok(/point\.editMessageText/.test(plan), 'the edits must be aimed at the progress bubble');

// Order: strategy -> range -> (legs) -> amount. Stepping back to the amount must not
// wipe the range, which is now chosen before it.
assert.ok(/Range first, amount last/.test(idx), 'the step order must be documented in the code');
const backAmt = idx.slice(idx.indexOf("bot.action('back:amount'"), idx.indexOf("bot.action('back:amount'") + 500);
assert.ok(!/flow\.rangePct = undefined/.test(backAmt), 'stepping back to the amount must not clear the range');

console.log('ok: the amount is the last step and opens the position through execAdd');
