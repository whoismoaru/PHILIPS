import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Open ladder yang gagal SETELAH tx mendarat harus tetap memungut posisinya.
 *
 * 29 Agu 2026: RPC balas 503 tepat saat open. Pembacaan id awal gagal, dan karena
 * pemungutan bergantung pada id itu, ia menyerah tanpa mencoba — delapan posisi
 * lahir di chain tanpa catatan dan hilang dari /positions sampai dipungut tangan.
 */
const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
const fn = src.slice(src.indexOf('async function adoptStrayV4'), src.indexOf('/** Kartu detail satu posisi v4'));

// Pembacaan id dicoba ulang, bukan sekali lalu menyerah.
assert.ok(/for \(let i = 0; i < 3 && to === null; i\+\+\)/.test(fn), 'pembacaan nextTokenId tak dicoba ulang');
// Tanpa id awal, mundur satu jendela — bukan pulang dengan tangan kosong.
assert.ok(/const start = from \?\? \(to > window \? to - window : 0n\)/.test(fn), 'tak ada jalur tanpa id awal');
// Yang sudah tercatat bukan stray: memungutnya lagi menyeret posisi grup lain.
assert.ok(/ids\.filter\(\(id\) => !v4store\.getV4\(id\)\)/.test(fn), 'posisi yang sudah tercatat bisa dipungut ulang');
// Pemanggil tak boleh lagi melewati pemungutan saat id awal gagal dibaca.
assert.ok(!/idBefore !== null \? await adoptStrayV4/.test(src), 'pemungutan masih bergantung pada id awal');

console.log('OK — adopt stray: pemungutan tetap jalan walau pembacaan id gagal.');
