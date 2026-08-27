import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Penarikan tanpa lantai harga (amount0Min/1Min = 0) bisa disandwich: harga didorong
 * ke tepi rentang, posisi keluar ~100% sebagai aset yang ditekan, lalu harga
 * dikembalikan — dan tx-nya tetap "sukses". Jalur itu masih ada sebagai upaya
 * terakhir (dana user > risiko MEV), tapi TIDAK BOLEH senyap lagi.
 */
const src = readFileSync(join(process.cwd(), 'src', 'uniswap.ts'), 'utf8');

assert.ok(
  /return \{ amount0Min: 0n, amount1Min: 0n, unprotected: true \}/.test(src),
  'jalur lantai-nol harus menandai dirinya unprotected',
);
assert.ok(
  !/return \{ amount0Min: 0n, amount1Min: 0n \}(?!,)/.test(src),
  'ada jalur lantai-nol yang tak menandai diri — akan senyap lagi',
);

// Ketiga jalur penarikan harus meneruskan penandanya ke notes (notes → kartu Telegram).
const uses = src.split('WITHDRAW_UNPROTECTED_NOTE(').length - 1;
assert.ok(uses >= 3, `catatan peringatan cuma dipakai ${uses}x — satu jalur penarikan belum meneruskannya`);

// --- v4 -------------------------------------------------------------------
// Sama untuk v4: BURN_POSITION dulu selalu dikirim dengan amount0Min/1Min = 0.
const v4 = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');

assert.ok(
  !/\[(?:id|tokenId), 0, 0, '0x'\]/.test(v4),
  'BURN_POSITION masih dikirim dengan lantai 0 — proteksi sandwich v4 mati',
);
assert.ok(
  (v4.split('burnMinsV4(').length - 1) >= 3,
  'burnMinsV4 belum dipakai di kedua jalur close v4 (tunggal + ladder)',
);
assert.ok(
  /return \{ min0: 0n, min1: 0n, unprotected: true \}/.test(v4),
  'jalur cadangan v4 harus menandai dirinya unprotected',
);

// Tandanya harus benar-benar sampai ke user, bukan berhenti di tipe kembalian.
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
assert.ok(
  (idx.split('V4_UNPROTECTED_NOTE(').length - 1) >= 2,
  'kartu close v4 tak melaporkan burn tanpa lantai harga',
);

// --- atap ongkos gas ------------------------------------------------------
// Harus dicek di titik BROADCAST: itu satu-satunya tempat yang dilewati SEMUA
// jalur kirim (panggilan kontrak, sendTxNonceSafe, tx mentah dari agregator).
const chains = readFileSync(join(process.cwd(), 'src', 'chains.ts'), 'utf8');
assert.ok(/broadcastTransaction[\s\S]{0,400}Gas fee ceiling hit/.test(chains),
  'atap ongkos gas tak terpasang di broadcastTransaction — sebagian jalur kirim lolos');

console.log('OK — guards: lantai harga v3 & v4 dilaporkan, atap ongkos gas terpasang di broadcast.');
