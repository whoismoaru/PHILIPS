import assert from 'node:assert/strict';
import { slipLadder } from '../src/relay.js';

assert.deepEqual(slipLadder(undefined), [5, 15], 'tanpa cap harus tetap 5% lalu 15%');

assert.deepEqual(slipLadder(3), [3], 'cap 3% tak boleh punya percobaan kedua');
assert.ok(Math.max(...slipLadder(3)) <= 3, 'tak boleh ada langkah di atas cap');

assert.deepEqual(slipLadder(10), [5, 10], 'cap 10% → 5% dulu, lalu 10%');
assert.ok(!slipLadder(10).includes(15), 'cap tak boleh ditembus oleh angka 15 lama');

assert.deepEqual(slipLadder(5), [5], 'cap = langkah pertama → jangan dobel');
assert.deepEqual(slipLadder(0), [], 'cap 0 = tak ada rute Uniswap, bukan slippage bebas');

console.log('OK — slippage: /buy & /sell terjepit di 3%, close tetap 5%→15%.');
