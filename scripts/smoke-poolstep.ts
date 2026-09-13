/**
 * OPEN LP, step 1. The pool rows no longer repeat the pair name (the buttons
 * below carry it), so the ORDER of the rows must match the order of the buttons.
 * Otherwise the user taps a pool other than the one they just read.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { msgPoolStep } from '../src/messages.js';

const pools = [
  { pair: 'GG / USDG', ver: 'V4', feeLabel: '3.85%', tvl: '$507.2K', vol: '$2.77M', apr: '~7671%', tight: '4%' },
  { pair: 'GG / WETH', ver: 'V3', feeLabel: '1.00%', tvl: '$78.0K', vol: '$1.72M', apr: '~6706%', tight: '2%' },
];
const card = msgPoolStep('$GG (Robinhood)', pools);

assert.match(card, /AVAILABLE POOLS :/);
// Rows are numbered now, matching the numbered buttons beside them.
const rows = card.split('\n').filter((l) => /^\d+\. /.test(l));
assert.equal(rows.length, pools.length, 'satu rows per pool');
rows.forEach((l, i) => {
  assert.ok(l.startsWith(`${i + 1}. `), `row ${i} is not numbered in order`);
  assert.ok(l.includes(pools[i].ver) && l.includes(pools[i].feeLabel), `row ${i} does not match the pool order`);
  assert.ok(!l.includes(pools[i].pair), 'the pair is not repeated in the row; the button carries it');
});
for (const p of pools) {
  const detail = card.split('\n').find((l) => l.includes(p.tvl))!;
  for (const v of [p.tvl, p.vol, p.apr, p.tight]) assert.ok(detail.includes(v), `the figure ${v} is missing`);
}

// Rows and buttons are sliced from the SAME list with the SAME limit: change one
// and the other drifts out of step without a sound.
const idx = readFileSync('src/index.ts', 'utf8');
const sum = idx.slice(idx.indexOf('const poolSummaries'), idx.indexOf('const poolSummaries') + 400);
const kb = idx.slice(idx.indexOf('function poolKeyboard'), idx.indexOf('function poolKeyboard') + 400);
for (const [name, block] of [['poolSummaries', sum], ['poolKeyboard', kb]] as const)
  assert.match(block, /slice\(0, POOL_PICK_MAX\)/, `${name} must slice with the same limit`);

// An APR or volume that failed to read must never become an invented number.
const blank = msgPoolStep('$X (BSC)', [{ pair: 'X / USDT', ver: 'V3', feeLabel: '1.00%', tvl: '$1.0K', apr: '?', tight: '5%' }]);
assert.match(blank, /Vol 24h: \?/);
assert.match(blank, /APR: \?/);

console.log('smoke-poolstep OK');
