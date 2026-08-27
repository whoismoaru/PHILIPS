import assert from 'node:assert/strict';
import * as p from '../src/pctPresets.js';

// Angka yang sah dirapikan, bukan ditolak: urut naik, tanpa kembar.
assert.deepEqual(p.sanitize([50, 10, 25, 10], 'buy'), [10, 25, 50]);
assert.deepEqual(p.sanitize([100], 'buy'), [100]);

// Yang tak masuk akal ditolak — tombol persen 0% atau 150% tak punya arti.
assert.equal(p.sanitize([], 'buy'), null);
assert.equal(p.sanitize([0, 50], 'buy'), null);
assert.equal(p.sanitize([150], 'buy'), null);
assert.equal(p.sanitize([12.5], 'buy'), null, 'pecahan bukan tombol persen yang sah');
assert.equal(p.sanitize([10, 20, 30, 40, 50], 'buy'), null, 'lebih dari 4 tombol terpotong di layar sempit');

// Withdraw 100% = menutup posisi, dan itu jalur lain (close, bukan decrease).
assert.equal(p.sanitize([25, 100], 'stop'), null);
assert.deepEqual(p.sanitize([25, 99], 'stop'), [25, 99]);

// Bentuk ketikan yang wajar semuanya diterima.
assert.deepEqual(p.parseList('10 25 50 90'), [10, 25, 50, 90]);
assert.deepEqual(p.parseList('10,25 , 50'), [10, 25, 50]);
assert.deepEqual(p.parseList('10/25/50'), [10, 25, 50]);
assert.deepEqual(p.parseList('10% 25%'), [10, 25]);
assert.equal(p.parseList(''), null);
assert.equal(p.parseList('abc'), null);

// Jumlah leg bukan persen: minimal 2 (satu leg bukan ladder), maksimal 69.
assert.equal(p.sanitize([1, 8], 'legs'), null, '1 leg bukan ladder');
assert.equal(p.sanitize([70], 'legs'), null, 'di atas batas jalur open');
assert.deepEqual(p.sanitize([8, 2, 69], 'legs'), [2, 8, 69]);
assert.equal(p.unitFor('legs'), 'legs');
assert.equal(p.unitFor('buy'), '%');
assert.deepEqual(p.boundsFor('stop'), { min: 1, max: 99 }, 'withdraw 100% = close, jalur lain');

// Bawaan tiap alur tetap sah menurut aturannya sendiri.
for (const f of ['buy', 'sell', 'add', 'stop', 'bridge', 'legs'] as p.PctFlow[]) {
  assert.ok(p.sanitize(p.defaultsFor(f), f), `bawaan ${f} tak lolos validasinya sendiri`);
}

console.log('OK — pctPresets: validasi & parsing persen di /settings.');
