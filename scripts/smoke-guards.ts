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

console.log('OK — guards: penarikan tanpa lantai harga selalu dilaporkan ke user.');
