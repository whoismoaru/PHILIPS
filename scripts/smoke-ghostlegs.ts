import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Satu leg hantu tak boleh menggagalkan seluruh penutupan ladder.
 *
 * 29 Agu 2026: delapan leg v4 tercatat di store tapi tak pernah ada di chain.
 * BURN_POSITION pada id tak ter-mint me-revert 'NOT_MINTED', dan karena semuanya
 * dalam SATU multicall, seluruh batch ikut gagal. Kalau grup itu bercampur dengan
 * leg yang hidup, posisi yang sehat pun jadi tak bisa ditutup.
 */
const v4 = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

assert.ok(/NOT_MINTED\|invalid token id\|nonexistent/.test(v4), 'leg hantu tak dikenali');
assert.ok(/const alive: string\[\] = \[\];/.test(v4), 'leg hidup tak disaring dari yang hantu');
assert.ok(/tokenIds = alive;/.test(v4), 'batch masih memakai daftar id yang belum disaring');
// Gagal baca (RPC) TIDAK boleh dianggap hantu — itu bug yang sama seperti v3.
assert.ok(/Could not read v4 position #\$\{id\}/.test(v4), 'gagal baca disamakan dengan hilang');
// Catatan hantu dibuang, kalau tidak percobaan berikutnya gagal dengan alasan sama.
assert.ok(/r\.gone\?\.length/.test(idx), 'leg hantu tak dibuang dari catatan');
assert.ok(/no longer exist on-chain/i.test(idx), 'grup hantu penuh tak dibersihkan');

console.log('OK — ghost legs: leg hantu disaring & dibuang, gagal baca tetap dilempar.');
