/** Cek tangga slippage. Jalankan: npx tsx scripts/smoke-slippage.ts
 *  Yang dijaga: /buy & /sell TAK PERNAH melampaui cap, dan jalur close tetap
 *  boleh naik ke 15% (di sana gagal berarti token nyangkut). */
import assert from 'node:assert/strict';
import { slipLadder } from '../src/relay.js';

// Tanpa cap = perilaku lama, dipakai close/sweep.
assert.deepEqual(slipLadder(undefined), [5, 15], 'tanpa cap harus tetap 5% lalu 15%');

// Cap 3 (yang dipakai /buy & /sell): satu percobaan, tak ada eskalasi.
assert.deepEqual(slipLadder(3), [3], 'cap 3% tak boleh punya percobaan kedua');
assert.ok(Math.max(...slipLadder(3)) <= 3, 'tak boleh ada langkah di atas cap');

// Cap di atas 5 masih boleh bertangga, tapi berhenti di cap — bukan di 15.
assert.deepEqual(slipLadder(10), [5, 10], 'cap 10% → 5% dulu, lalu 10%');
assert.ok(!slipLadder(10).includes(15), 'cap tak boleh ditembus oleh angka 15 lama');

// Cap ekstrem tak menghasilkan langkah kosong/negatif.
assert.deepEqual(slipLadder(5), [5], 'cap = langkah pertama → jangan dobel');
assert.deepEqual(slipLadder(0), [], 'cap 0 = tak ada rute Uniswap, bukan slippage bebas');

console.log('OK — slippage: /buy & /sell terjepit di 3%, close tetap 5%→15%.');
