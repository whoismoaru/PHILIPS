import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Value now" harus nilai yang BISA DIDAPAT, bukan harga pasar semu.
 *
 * 28 Agu 2026: kartu ladder menulis 287.70 USDG (+10.2%) lalu penutupannya
 * menghasilkan 246.69 (-5.5%). Sisi token dinilai pada harga pool sekarang,
 * padahal menjualnya menggerakkan harga — Relay menolak rutenya dengan
 * "Swap impact is too high: 31.06%". Selisihnya 41 USDG yang tak pernah ada.
 */
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

assert.ok(/previewSwapOut\(otherAddr,/.test(idx), 'sisi token tak dikutip dengan quote nyata');
assert.ok(/const realWei = quotedOtherWei === null \? valWei : baseWei \+ quotedOtherWei;/.test(idx),
  'nilai ladder tak memakai hasil quote');
assert.ok(/exitNote/.test(idx), 'dampak harga tak disebut ke user');
// Quote gagal → jatuh ke harga pool, TAPI ditandai; diam-diam memakai harga pool
// adalah persis bug yang diperbaiki.
assert.ok(/token side priced at pool rate, not a live quote/.test(idx), 'fallback harga pool tak ditandai');

// Sisi base tak perlu dijual, jadi tak boleh ikut dipotong dampak harga.
assert.ok(/baseWei \+= x\.baseAmountWei/.test(idx), 'sisi base tak dipisah dari sisi token');

const v4 = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');
for (const f of ['otherAmountWei', 'otherAddress', 'baseAmountWei']) {
  assert.ok(new RegExp(`${f}:`).test(v4), `V4Position tak memapar ${f}`);
}

console.log('OK — exit value: sisi token dikutip quote nyata, dampak harga disebut.');
