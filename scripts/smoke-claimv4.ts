import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * /claim_fees must see BOTH protocols.
 *
 * It read store.active() alone for months, which holds v3 records only, so a v4
 * position accrued fees the command swore were not there. Found with a live wallet
 * holding exactly that: v3 #1143853 listed, v4 #2525867 invisible.
 */
const src = readFileSync('src/commands/feesAndRemove.ts', 'utf8');

assert.ok(/listPositionsV4/.test(src), 'daftar fee harus ikut memindai posisi v4');
assert.ok(/Object\.values\(CHAINS\)/.test(src), 'v4 harus dipindai di semua chain, bukan chain aktif saja');

// The callback has to say which protocol it is: ids can collide between v3 and v4, and
// collecting through the wrong contract fails as if the position did not exist.
assert.ok(/claim:\$\{x\.v4 \? 'v4' : 'v3'\}:\$\{x\.chainKey\}:\$\{x\.id\}/.test(src),
  'tombol klaim harus membawa protokol & chain-nya');
assert.ok(/bot\.action\(\/\^claim:\(\\d\+\)\$\//.test(src),
  'tombol lama (id telanjang) harus tetap ditangani, bukan mati diam');

// A v4 collect is a decrease of ZERO: anything else would move real liquidity.
const v4 = readFileSync('src/uniswapV4.ts', 'utf8');
const i0 = v4.indexOf('export async function collectFeesV4');
const fn = v4.slice(i0, v4.indexOf('\n}\n', v4.indexOf('return {', i0)));
assert.ok(/DECREASE_LIQUIDITY/.test(fn) && !/BURN_POSITION/.test(fn), 'panen fee v4 tak boleh membakar posisi');
assert.ok(/\[tokenId, 0n, 0n, 0n, '0x'\]/.test(fn), 'decrease harus benar-benar nol likuiditas');
assert.ok(/staticCall/.test(fn), 'simulasi wajib sebelum kirim tx');
assert.ok(/after > before \? after - before : 0n/.test(fn), 'jumlah panen harus diukur dari selisih saldo');

console.log('ok: /claim_fees melihat v3 & v4 di semua chain, dan panen v4 tak menyentuh likuiditas');
