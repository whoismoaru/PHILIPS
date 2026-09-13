import assert from 'node:assert/strict';
import { slipLadder } from '../src/relay.js';

// One band for EVERY swap: 1% -> 2% -> 3%, never beyond. The old 5% -> 15% ladder was
// retired when slippage was locked, and this file still demanded it -- a test arguing
// with the change it was supposed to protect.
assert.deepEqual(slipLadder(undefined), [1, 2, 3], 'tanpa cap harus memakai pita 1-2-3%');
assert.deepEqual(slipLadder(99), [1, 2, 3], 'cap di atas 3% tetap terjepit di 3%');

assert.deepEqual(slipLadder(3), [1, 2, 3], 'cap 3% = seluruh pita');
assert.ok(Math.max(...slipLadder(3)) <= 3, 'tak boleh ada langkah di atas cap');

assert.deepEqual(slipLadder(2), [1, 2], 'cap 2% memotong langkah terakhir');
assert.ok(!slipLadder(99).includes(15), 'angka 15% lama tak boleh muncul lagi');

assert.deepEqual(slipLadder(1), [1], 'cap = langkah pertama → jangan dobel');
assert.deepEqual(slipLadder(0), [], 'cap 0 = tak ada rute Uniswap, bukan slippage bebas');

console.log('OK — slippage: setiap swap terjepit di pita 1-2-3%.');
