import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '../src/pctPresets.js';

/**
 * Prompt "ketik angka" di /settings diperiksa PALING AWAL di penangan teks. Kalau
 * penandanya tak pernah dibersihkan saat user pergi, setiap pesan berikutnya
 * tertelan sebagai jawaban — nominal /add pun ditolak "Give 1 to 4 whole numbers".
 */
p.askEdit(1, 'buy');
assert.equal(p.pendingEdit(1), 'buy', 'permintaan ketik harus tercatat');
p.clearEdit(1);
assert.equal(p.pendingEdit(1), undefined, 'clearEdit harus benar-benar membatalkan');

// Tiga jalan keluar wajib membatalkannya: tombol Back, perintah lain, dan waktu.
const w = readFileSync(join(process.cwd(), 'src', 'commands', 'wallet.ts'), 'utf8');
assert.ok(/bot\.action\(\/\^pct:[^\n]*\n[\s\S]{0,200}?clearEdit/.test(w), 'tombol Back tak membatalkan prompt');
assert.ok(/registerFlowReset\(\(uid\) => pctPresets\.clearEdit\(uid\)\)/.test(w), 'perintah lain tak membatalkan prompt');
assert.ok(/PENDING_TTL_MS/.test(readFileSync(join(process.cwd(), 'src', 'pctPresets.ts'), 'utf8')), 'prompt tak punya kedaluwarsa');

// Sapuan yang gagal transien harus mundur, bukan diulang tiap menit.
const m = readFileSync(join(process.cwd(), 'src', 'monitor.ts'), 'utf8');
assert.ok(/SWEEP_RETRY_BACKOFF_MS/.test(m), 'sapuan gagal tak punya jeda mundur');

console.log('OK — prompt setelan tak lagi menelan pesan; sapuan gagal mundur dulu.');
