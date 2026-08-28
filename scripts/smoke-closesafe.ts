import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gagal BACA posisi bukan bukti posisi hilang.
 *
 * 28 Agu 2026: RPC BSC putus saat menutup ladder 8 leg. `positions()` gagal untuk
 * setiap leg, `catch {}` menelan semuanya, daftar panggilan multicall jadi kosong,
 * dan alurnya tetap melapor "LADDER CLOSED · Total cashed out 0 USDT". Tak satu
 * transaksi pun dikirim: 214 USDT tetap hidup di chain tapi terhapus dari catatan
 * bot. Dua penjaga di bawah memastikan itu tak terulang.
 */
const uni = readFileSync(join(process.cwd(), 'src', 'uniswap.ts'), 'utf8');
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

// 1. Hanya revert 'Invalid token ID' yang boleh dilewati; sisanya harus dilempar.
const loop = uni.slice(uni.indexOf('export async function executeRemoveBatch'), uni.indexOf('export type PositionInfo'));
assert.ok(/if \(isGoneErr\(e\)\) continue;/.test(loop), 'leg yang gagal dibaca masih dilewati diam-diam');
assert.ok(/throw new Error\(\s*`Could not read position/.test(loop), 'gagal baca tak dilempar');
assert.ok(!/\} catch \{\s*continue;/.test(loop), 'masih ada catch kosong yang menelan semua error');

// 2. Tanpa tx penarikan, jangan finalisasi apa pun sebagai tertutup.
assert.ok(
  /No withdrawal transaction was sent/.test(idx),
  'jalur ladder masih bisa melapor sukses tanpa mengirim tx',
);

console.log('OK — close: gagal baca membatalkan penutupan, bukan menyamar jadi sukses.');
