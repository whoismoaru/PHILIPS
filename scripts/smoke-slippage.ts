import assert from 'node:assert/strict';
import { slipLadder } from '../src/relay.js';

// One band for EVERY swap: 1% -> 2% -> 3%, never beyond. The old 5% -> 15% ladder was
// retired when slippage was locked, and this file still demanded it -- a test arguing
// with the change it was supposed to protect.
assert.deepEqual(slipLadder(undefined), [1, 2, 3], 'with no cap it must use the 1-2-3% band');
assert.deepEqual(slipLadder(99), [1, 2, 3], 'a cap above 3% is still clamped to 3%');

assert.deepEqual(slipLadder(3), [1, 2, 3], 'a 3% cap is the whole band');
assert.ok(Math.max(...slipLadder(3)) <= 3, 'no step may exceed the cap');

assert.deepEqual(slipLadder(2), [1, 2], 'a 2% cap drops the last step');
assert.ok(!slipLadder(99).includes(15), 'the old 15% figure must never reappear');

assert.deepEqual(slipLadder(1), [1], 'a cap equal to the first step must not double it');
assert.deepEqual(slipLadder(0), [], 'a cap of 0 means no Uniswap route, not unlimited slippage');

console.log('ok: every swap is clamped to the 1-2-3% band.');
