import assert from 'node:assert/strict';
import { slipLadder } from '../src/relay.js';

// One band for EVERY swap: 1% -> 3% -> 5% -> 10%, never beyond (raised from 1-2-3% on
// 11 Oct 2026). The old 5% -> 15% ladder must still never come back.
assert.deepEqual(slipLadder(undefined), [1, 3, 5, 10], 'with no cap it must use the 1-3-5-10% band');
assert.deepEqual(slipLadder(99), [1, 3, 5, 10], 'a cap above 10% is still clamped to 10%');

assert.deepEqual(slipLadder(10), [1, 3, 5, 10], 'a 10% cap is the whole band');
assert.ok(Math.max(...slipLadder(10)) <= 10, 'no step may exceed the cap');

assert.deepEqual(slipLadder(3), [1, 3], 'a 3% cap drops the later steps');
assert.deepEqual(slipLadder(4), [1, 3, 4], 'a cap between steps ends at the cap');
assert.ok(!slipLadder(99).includes(15), 'the old 15% figure must never reappear');

assert.deepEqual(slipLadder(1), [1], 'a cap equal to the first step must not double it');
assert.deepEqual(slipLadder(0), [], 'a cap of 0 means no Uniswap route, not unlimited slippage');

console.log('ok: every swap is clamped to the 1-3-5-10% band.');
