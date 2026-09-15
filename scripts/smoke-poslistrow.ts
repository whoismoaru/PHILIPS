import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { msgPositionsList } from '../src/messages.js';

/**
 * The /positions row. Two things here are easy to break without noticing:
 *  - a ladder sums its legs' deposits, and it used to do that by PARSING its own printed
 *    label back apart. The moment the label grew a '$' that produced NaN.
 *  - the market-cap range is dropped when the entry values needed to pin it were never
 *    stored; a range that silently wobbles between refreshes is worse than none.
 */
const row = {
  id: '2699428', pair: 'GG/USDG', investLabel: '$1.00 USDG', age: '0m', pnlUsd: 0, pnlPct: -0.04,
  inRange: false, protocol: 'V4', chain: 'Robinhood', feesUsdLabel: '+$0,00', baseSymbol: 'USDG',
  strategy: 'base', mcRange: '$1.68M ⇄ $165.5K / now $1.70M',
};
const card = msgPositionsList({ dryRun: false, activeCount: 1, totalInvestLabel: null, totalPnlUsd: 0, outOfRange: 1, rows: [row] });
const plain = card.replace(/<[^>]+>/g, '');
console.log(plain);

for (const line of ['Chain: Robinhood', 'Strategy: USDG Single Side (buy the dip)', 'Invested: $1.00 USDG',
                    'Total Fees: +$0,00', 'Range: $1.68M ⇄ $165.5K / now $1.70M', 'Status: Waiting (out of range), 0m'])
  assert.ok(plain.includes(line), `the row lost: ${line}`);
// The order is the design: what it is, then what went in, then what it made, then where it sits.
const idx = ['Chain:', 'Strategy:', 'Invested:', 'Total Fees:', 'PnL:', 'Range:', 'Status:'].map((k) => plain.indexOf(k));
for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `the rows are out of order at ${i}`);
// Status closes the block, and nothing else may.
assert.match(plain, /└ Status:/, 'Status must be the last row of the block');
assert.ok(!/└ Range:/.test(plain), 'Range ended the block: the Status row went missing');

// Without a stored entry the Range row is absent entirely -- never printed empty or as '—'.
const bare = msgPositionsList({ dryRun: false, activeCount: 1, totalInvestLabel: null, totalPnlUsd: 0, outOfRange: 1,
  rows: [{ ...row, mcRange: null }] }).replace(/<[^>]+>/g, '');
assert.ok(!/Range:/.test(bare), 'an unpinnable range is still being printed');
assert.match(bare, /└ Status:/, 'the block no longer closes on Status');

// A ladder must sum from the NUMBER it carries, not from its own label.
const src = readFileSync('src/index.ts', 'utf8');
const collapse = src.slice(src.indexOf('function collapseLadderRows'), src.indexOf('function collapseLadderRows') + 1400);
assert.ok(!/parseFloat\(r\.investLabel\)/.test(collapse), 'the ladder is parsing its own label again');
assert.match(collapse, /r\.investNum \?\? 0/, 'the ladder no longer sums the carried figure');

console.log('ok: the /positions row keeps its shape, and a ladder sums figures rather than text');

// ── A ladder sums MONEY, never the text it printed.
//
// On 15 Sep 2026 a five-leg WAIFU ladder five minutes old reported "Total Fees: +$50,00"
// beside "PnL: +0.1%". Each leg had earned about ten cents and was printed "+$0,10"; the
// merge read that label back with a digits-only filter, which drops the id-ID decimal
// comma and turns 0.10 into 10. Five legs, fifty dollars, all of it fictional.
const indexSrc = readFileSync('src/index.ts', 'utf8');
const merge = indexSrc.slice(indexSrc.indexOf('function collapseLadderRows'), indexSrc.indexOf('collapseLadderRows(rows);'));
assert.ok(!/feesUsdLabel\.replace/.test(merge), 'the ladder is parsing its own fee label again');
assert.match(merge, /legs\.map\(\(r\) => r\.feesUsd\)/, 'the ladder must sum the carried fee figure');
assert.ok(!/parseFloat\(r\.(investLabel|feesLabel|feesUsdLabel)\)/.test(merge), 'a printed label is being parsed back into a number');

// The trap in one line: this is what the old code did to a ten-cent fee.
assert.equal(Number('+$0,10'.replace(/[^0-9.-]/g, '')), 10, 'the id-ID decimal comma no longer inflates — recheck the guard below');
// And what the money path must do instead: keep the number.
assert.equal(Number((0.1).toFixed(2)), 0.1);

console.log('ok: a ladder adds up its legs from figures, never from formatted text');
