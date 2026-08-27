import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Setiap jalur TUTUP posisi harus berakhir dengan kartu PnL — atau menyebut
 * alasannya kalau hasilnya tak terukur. Ada empat jalur: v3 tunggal, v3 ladder,
 * v4 tunggal, v4 ladder. Dua jalur ladder dulu tak pernah mengirim kartu sama
 * sekali; user cuma dapat satu baris "Total cashed out".
 */
const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

const calls = src.split('sendProfitCard(').length - 1;
assert.ok(calls >= 5, `sendProfitCard cuma dipanggil ${calls}x — ada jalur close tanpa kartu (butuh 1 definisi + 4 jalur)`);

// Kartu dengan hasil 0 akan menulis −100% padahal dana utuh — harus dijaga.
assert.ok(/if \(totalOut > 0n\) \{/.test(src), 'jalur ladder v3 tak menjaga hasil-nol');
assert.ok(/if \(r\.baseOutWei > 0n\) \{/.test(src), 'jalur ladder v4 tak menjaga hasil-nol');

// Diam bukan jawaban: hasil tak terukur harus disebut, bukan kartu yang hilang begitu saja.
const skips = src.split('Result could not be measured').length - 1;
assert.ok(skips >= 3, `hanya ${skips} jalur yang menjelaskan kartu yang dilewati`);

// Fee dipotret SEBELUM burn di kedua jalur ladder — sesudahnya angkanya lenyap.
assert.ok(
  (src.split('Fee dibaca SEBELUM burn').length - 1) >= 3,
  'ada jalur close yang membaca fee setelah burn (angkanya sudah melebur)',
);

console.log('OK — close cards: keempat jalur mengirim kartu PnL, hasil tak terukur dijelaskan.');
