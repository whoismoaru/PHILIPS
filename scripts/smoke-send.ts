import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '../src/pctPresets.js';

/**
 * /send adalah jalur satu arah tanpa pembatalan, jadi penjaganya harus ada:
 * validasi alamat, cadangan gas untuk native, konfirmasi terpisah, kunci in-flight,
 * dan peringatan bila tujuannya kontrak.
 */
const src = readFileSync(join(process.cwd(), 'src', 'commands', 'send.ts'), 'utf8');

assert.ok(/ethers\.isAddress\(t\)/.test(src), 'alamat tujuan tak divalidasi');
assert.ok(/gasBuffer\(cc\)/.test(src), 'native dikirim tanpa menyisihkan gas');
assert.ok(/getCode\(/.test(src), 'tujuan tak diperiksa apakah kontrak');
assert.ok(/sending\.has\(uid\)/.test(src), 'tak ada kunci anti double-tap');
assert.ok(/store\.beginMoneyOp\(\)/.test(src) && /store\.endMoneyOp\(\)/.test(src), 'tak mengunci monitor saat kirim');
assert.ok(/flows\.delete\(uid\);/.test(src), 'flow tak dihapus sebelum eksekusi (kirim dobel)');
assert.ok(/config\.safety\.dryRun/.test(src), 'DRY RUN tak dihormati');

// Alamat EVM sama di semua chain: tak boleh ada tebakan chain dari alamatnya.
assert.ok(/assetsOn\(cc\)/.test(src), 'chain tak dipilih dari saldo nyata');

// Preset persen /send ada dan sah.
assert.ok(p.get('send').length > 0, 'preset send kosong');
assert.ok(p.sanitize(p.defaultsFor('send'), 'send'), 'bawaan send tak lolos validasinya sendiri');
assert.equal(p.unitFor('send'), '%');

// Alamat contoh tetap alamat sah (menjaga helper tak berubah arti).
assert.ok(ethers.isAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'));

// Alamat base di chains.ts tak seragam kapitalnya (USDG Robinhood lowercase,
// sisanya checksummed). Membandingkan string apa adanya membuat aset yang ADA
// terbaca "balance is gone" — terjadi 28 Agu 2026 saat /send pertama dicoba.
assert.ok(
  /x\.address\?\.toLowerCase\(\)/.test(src),
  'pencocokan aset masih membandingkan alamat apa adanya (peka huruf besar/kecil)',
);
assert.ok(!/=== \(addr \?\? 'native'\)[\s\S]{0,40}getAddress/.test(src), 'callback dinormalkan checksum lalu dibanding mentah');

console.log('OK — send: alamat divalidasi & dibanding tanpa peduli kapital, gas disisihkan, kirim dikunci.');
