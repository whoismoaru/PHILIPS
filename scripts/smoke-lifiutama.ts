// One runnable check on the route-preference rule: LI.FI leads unless its rate is
// genuinely worse. Pure comparison logic -- no network, no wallet.
import assert from 'node:assert';
import { lifiPreferred, LIFI_TOL } from '../src/relay.js';

const M = 1_000_000n;

// Identical rate -> LI.FI leads.
assert.equal(lifiPreferred(M, M), true, 'a tie goes to LI.FI');
// Marginally worse but inside tolerance -> still LI.FI.
assert.equal(lifiPreferred(990_000n, M), true, '1% worse is still LI.FI');
// Beyond tolerance -> back off to the alternative.
assert.equal(lifiPreferred(980_000n, M), false, '2% worse has to step aside');
// Better rate -> obviously LI.FI.
assert.equal(lifiPreferred(1_100_000n, M), true, 'a better quote is certainly LI.FI');
// No quote at all -> never chosen, whatever the alternative did.
assert.equal(lifiPreferred(0n, M), false, 'with no quote it must not be picked');
assert.equal(lifiPreferred(0n, 0n), false, 'nothing on either side means no pick');
// No alternative quoted -> LI.FI leads unopposed.
assert.equal(lifiPreferred(M, 0n), true, 'with nothing to compare against, LI.FI wins');
assert.equal(LIFI_TOL, 0.015, 'the tolerance changed by accident');

console.log('ok: LI.FI-first route selection holds in every case');

// Slippage band: every swap steps 1% -> 2% -> 3%, and 3 is a ceiling nobody escapes.
import { slipLadder, SLIP_MAX_PCT } from '../src/relay.js';
assert.deepEqual(slipLadder(), [1, 2, 3], 'the default ladder is 1-3%');
assert.deepEqual(slipLadder(3), [1, 2, 3], 'cap 3 = tangga penuh');
assert.deepEqual(slipLadder(2), [1, 2], 'a cap of 2 stops at 2%');
assert.deepEqual(slipLadder(1), [1], 'a cap of 1 gives only 1%');
assert.deepEqual(slipLadder(15), [1, 2, 3], 'a request for 15% is clamped to 3%');
assert.equal(SLIP_MAX_PCT, 3, 'the slippage ceiling changed by accident');
console.log('ok: slippage stays locked to the 1-3% band even when the caller asks for more');
