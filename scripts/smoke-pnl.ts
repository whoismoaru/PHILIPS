import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { baseDecimalsOf } from '../src/chains.js';

assert.equal(baseDecimalsOf('robinhood', 'usdg'), 6, 'USDG Robinhood 6 desimal');
assert.equal(baseDecimalsOf('robinhood', 'weth'), 18);
assert.equal(baseDecimalsOf('bsc', 'usdt'), 18, 'USDT BSC 18 desimal — BUKAN 6');
assert.equal(baseDecimalsOf('bsc', 'weth'), 18);
assert.equal(baseDecimalsOf(undefined, 'weth'), 18, 'chain kosong = chain utama');

const raw = ethers.parseUnits('48', baseDecimalsOf('bsc', 'usdt'));
const shown = Number(ethers.formatUnits(raw, baseDecimalsOf('bsc', 'usdt')));
assert.equal(shown, 48, `48 USDT BSC terbaca ${shown}`);
const salah = Number(ethers.formatUnits(raw, 6));
assert.ok(salah > 4.7e13, 'membuktikan memakai 6 memang menggeser 10^12');

const gained = (before: bigint, after: bigint) => (after > before ? after - before : 0n);
assert.equal(gained(ethers.parseEther('0.12'), ethers.parseEther('0.25')), ethers.parseEther('0.13'),
  'WETH lama 0.12 tak boleh ikut dihitung');
assert.equal(gained(0n, ethers.parseEther('0.13')), ethers.parseEther('0.13'));
assert.equal(gained(ethers.parseEther('0.5'), ethers.parseEther('0.4')), 0n,
  'saldo menyusut → hasil 0, bukan angka negatif');

console.log('OK — PnL: desimal ikut chain, hasil = pertambahan saldo.');

import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const lolos = new Set([
  
  'const valF = Number(ethers.formatUnits(d.valueBaseWei, d.baseDecimals));',
  '`${msg.cleanUnits(d.valueBaseWei, d.baseDecimals)} ${d.baseSymbol}` +',
]);
const nakal = src.split('\n').filter((l) => {
  const t = l.trim();
  if (!/formatUnits\(|formatEther\(/.test(t)) return false;
  if (!/\.valueBaseWei/.test(t)) return false;
  if (/feesBaseWei/.test(t)) return false;
  return !lolos.has(t);
});
assert.deepEqual(nakal, [],
  'valuasi posisi tanpa feesBaseWei — PnL akan understate:\n' + nakal.join('\n'));

for (const [nama, mulai, selesai] of [
  // Blok ini pindah saat /portfolio diparalelkan (30 Agu 2026): valuasi v3 kini
  // promise yang dinyalakan lebih awal, bukan await berantai.
  ['renderStatus/LP', 'const v3ValsP = mapLimit(store.active()', 'const [network, chains]'],
  ['cmdPositions/v3', 'const v3rows = await mapLimit(active', 'const rows: PosRow[] = v3rows'],
] as const) {
  const i = src.indexOf(mulai);
  assert.ok(i > 0, `blok ${nama} tak ditemukan — penjaga usang, perbarui penanda`);
  const blok = src.slice(i, src.indexOf(selesai, i));
  const jahat = blok.split('\n').filter((l) => {
    const t = l.trim();
    if (t.startsWith('//')) return false;
    return /\bethUsd\b/.test(t) || /,\s*cc\)/.test(t) || /\bcc\.(wethAddress|nativeSymbol|label)\b/.test(t);
  });
  assert.deepEqual(jahat, [],
    `${nama}: memakai chain utama di loop lintas-chain (pakai ctxOf(rec)/rcc):\n` + jahat.join('\n'));
}

console.log('smoke-pnl: LULUS');
