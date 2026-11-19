import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flipSpan, rangePct } from '../src/solana/lp.js';

/**
 * Auto-flip (20 Nov 2026): a position the price fell through, now all token, is re-shaped IN PLACE
 * into a BID-ASK sell ladder over the same bins, and closes once the price is 90% of the way from
 * the range's Min to its Max price. A wick counts, and a flip that fails is retried, never dropped.
 */

// --- the ladder takes the token side of the range that is still beyond the price ---
assert.deepEqual(flipSpan(-619, -550, -630, true), [-619, -550], 'token X, price under the range: the whole range');
assert.deepEqual(flipSpan(-619, -550, -600, true), [-599, -550], 'price back inside: only the bins above it');
assert.equal(flipSpan(-619, -550, -550, true), null, 'price at the top bin: nothing left above it');
assert.equal(flipSpan(-619, -550, -500, true), null, 'price above the range: nothing to flip');
assert.deepEqual(flipSpan(100, 169, 180, false), [100, 169], 'token Y, mirror: the whole range below the price');
assert.deepEqual(flipSpan(100, 169, 150, false), [100, 149], 'token Y, price back inside');

// --- the take profit is % of the way in PRICE, not in bins ---
assert.equal(Math.round(rangePct(0, 69, 0, 100, true)), 0, 'Min price is 0%');
assert.equal(Math.round(rangePct(0, 69, 69, 100, true)), 100, 'Max price is 100%');
// 70 bins at step 100 (a 50% range): 90% of the price distance falls between bins 63 and 64.
// By bins, 63 would already read 91%: the take profit would fire a bin early.
assert.ok(rangePct(0, 69, 63, 100, true) < 90 && rangePct(0, 69, 64, 100, true) >= 90, 'token X: 90% lands at bin 64');
assert.ok(rangePct(0, 69, 6, 100, false) < 90 && rangePct(0, 69, 5, 100, false) >= 90, 'token Y reads the same way round');
assert.ok(rangePct(0, 69, 90, 100, true) > 100, 'past the top reads past 100%, so a gap through it still fires');

// --- the send: exact bins, never more token than comes out ---
const lp = readFileSync('src/solana/lp.ts', 'utf8');
const plan = lp.slice(lp.indexOf('export async function planFlip'), lp.indexOf('export type FlipResult'));
assert.ok(/rebalancePosition\(sim, new BN\(0\)/.test(plan), 'active-bin slippage must be 0, or a moved price shifts the whole ladder');
assert.ok(/if \(put > out\)/.test(plan), 'the deposit must never exceed what the withdrawal returns');
assert.ok(/StrategyType\.BidAsk/.test(plan), 'the flip lays a BID-ASK ladder');
assert.ok(/getAccountInfo\(new PublicKey\(position\)/.test(lp), "a position closed meanwhile is 'gone', not retried forever");

// --- the bot: checked every 2s, retried until it lands, then the range take profit ---
const idx = readFileSync('src/index.ts', 'utf8');
assert.ok(/setInterval\(\(\) => void checkFlips\(\), 2_000\)/.test(idx), 'armed positions are checked every 2s');
assert.ok(/const FLIP_TP_PCT = 90;/.test(idx), 'the take profit is 90% of the range');
assert.ok(/metric: 'range', target: FLIP_TP_PCT/.test(idx), 'a flip sets its range take profit');
assert.ok(/l\.metric === 'range'\) return rangeProgress/.test(idx), 'a range take profit reads the live bin');
const run = idx.slice(idx.indexOf('async function runFlip'), idx.indexOf('setInterval(() => void checkFlips'));
const failed = run.slice(run.indexOf('catch (err)'), run.indexOf('finally'));
assert.ok(/flipRetryAt\.set/.test(failed) && !/delete e\.autoFlip/.test(failed), 'a failed flip must be retried, never dropped');
assert.ok(run.indexOf('solClosing.delete') < run.indexOf('limits.add'), 'the take profit is added only once the in-flight mark is cleared');
// A position's own take profits go with it when it closes, so /limits never lists an orphan.
assert.ok(/l\.posRef === `sol:\$\{ref\.position\}`\) limits\.remove/.test(idx), 'a closed position leaves no PnL or range take profit behind');

console.log('ok: auto-flip re-shapes in place on exact bins, retries until it lands, and closes at 90% of the range');
