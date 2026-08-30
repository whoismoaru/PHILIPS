/**
 * Tiap open yang SUKSES harus mengirim DUA keluaran, di semua chain & protokol:
 * (1) konfirmasi "berhasil dibuat", lalu (2) kartu detail posisinya.
 * Jalur v4 (tunggal & ladder) dulu berhenti di kartu pertama — posisi v4 baru tak
 * pernah langsung memperlihatkan rentang, strategi, dan status range-nya.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/index.ts', 'utf8');

// Potong badan sesudah tiap konfirmasi sukses; kartu detail harus muncul di situ,
// sebelum catch/akhir blok.
const jalur: Array<[string, string, string]> = [
  ['v3 tunggal', 'msg.msgLpOpened(', 'renderPositionCard('],
  ['v3 ladder', 'msg.msgLadderOpened(opened.length', 'renderPositionCard('],
  ['v4 tunggal', 'msg.msgV4Added({', 'replyV4Card('],
  ['v4 ladder', 'msg.msgLadderOpened(r.tokenIds.length', 'replyV4Card('],
];
for (const [nama, konfirmasi, kartu] of jalur) {
  const i = src.indexOf(konfirmasi);
  assert.ok(i > 0, `jalur ${nama}: penanda konfirmasi tak ditemukan — penjaga usang`);
  const sesudah = src.slice(i, i + 1200);
  const j = sesudah.indexOf(kartu);
  assert.ok(j > 0, `jalur ${nama}: sukses tanpa kartu detail (cuma 1 keluaran dari 2)`);
  assert.ok(
    j < sesudah.indexOf('} catch') || sesudah.indexOf('} catch') < 0,
    `jalur ${nama}: kartu detail di luar jalur sukses`,
  );
}

// Kartu detail v4 tak boleh menjatuhkan open yang SUDAH sukses: posisinya nyata,
// kartunya cuma tampilan.
const h = src.slice(src.indexOf('async function replyV4Card'), src.indexOf('/** Tampilan detail'));
assert.match(h, /try \{/, 'replyV4Card harus menelan galat bacanya');
assert.match(h, /if \(!tokenId\) return/, 'tanpa tokenId (mis. dry-run) jangan coba baca');

console.log('smoke-opencards OK');
