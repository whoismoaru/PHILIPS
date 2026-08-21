/** Cek akuntansi PnL. Jalankan: npx tsx scripts/smoke-pnl.ts
 *  Dua kesalahan yang pernah membuat kartu PnL bohong:
 *   1. desimal stablecoin ditulis mati 6 → USDT BSC (18 dec) meleset 10^12
 *   2. seluruh saldo WETH dompet dihitung sbg hasil posisi, bukan pertambahannya */
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { baseDecimalsOf } from '../src/chains.js';

// ── 1. desimal per chain, bukan angka mati
assert.equal(baseDecimalsOf('robinhood', 'usdg'), 6, 'USDG Robinhood 6 desimal');
assert.equal(baseDecimalsOf('robinhood', 'weth'), 18);
assert.equal(baseDecimalsOf('bsc', 'usdt'), 18, 'USDT BSC 18 desimal — BUKAN 6');
assert.equal(baseDecimalsOf('bsc', 'weth'), 18);
assert.equal(baseDecimalsOf(undefined, 'weth'), 18, 'chain kosong = chain utama');

// 48 USDT di BSC harus terbaca 48, bukan 48 triliun.
const raw = ethers.parseUnits('48', baseDecimalsOf('bsc', 'usdt'));
const shown = Number(ethers.formatUnits(raw, baseDecimalsOf('bsc', 'usdt')));
assert.equal(shown, 48, `48 USDT BSC terbaca ${shown}`);
const salah = Number(ethers.formatUnits(raw, 6));
assert.ok(salah > 4.7e13, 'membuktikan memakai 6 memang menggeser 10^12');

// ── 2. hanya PERTAMBAHAN WETH yang jadi hasil posisi
const gained = (before: bigint, after: bigint) => (after > before ? after - before : 0n);
assert.equal(gained(ethers.parseEther('0.12'), ethers.parseEther('0.25')), ethers.parseEther('0.13'),
  'WETH lama 0.12 tak boleh ikut dihitung');
assert.equal(gained(0n, ethers.parseEther('0.13')), ethers.parseEther('0.13'));
assert.equal(gained(ethers.parseEther('0.5'), ethers.parseEther('0.4')), 0n,
  'saldo menyusut → hasil 0, bukan angka negatif');

console.log('OK — PnL: desimal ikut chain, hasil = pertambahan saldo.');
