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

// Bawaan tiap alur tetap sah menurut aturannya sendiri.
for (const f of ['buy', 'sell', 'add', 'stop'] as p.PctFlow[]) {
  assert.ok(p.sanitize(p.defaultsFor(f), f), `bawaan ${f} tak lolos validasinya sendiri`);
}

console.log('OK — pctPresets: validasi & parsing persen di /settings.');
