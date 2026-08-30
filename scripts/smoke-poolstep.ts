/**
 * Kartu OPEN LP langkah 1. Baris pool tak lagi mengulang nama pasangan —
 * tombol di bawahnya yang membawanya — jadi URUTAN baris wajib sama dengan
 * urutan tombol. Kalau tidak, user memilih pool yang bukan ia baca.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { msgPoolStep } from '../src/messages.js';

const pools = [
  { pair: 'GG / USDG', ver: 'V4', feeLabel: '3.85%', tvl: '$507.2K', vol: '$2.77M', apr: '~7671%', tight: '4%' },
  { pair: 'GG / WETH', ver: 'V3', feeLabel: '1.00%', tvl: '$78.0K', vol: '$1.72M', apr: '~6706%', tight: '2%' },
];
const kartu = msgPoolStep('$GG (Robinhood)', pools);

assert.match(kartu, /AVAILABLE POOLS :/);
const baris = kartu.split('\n').filter((l) => l.startsWith('- '));
assert.equal(baris.length, pools.length, 'satu baris per pool');
baris.forEach((l, i) => {
  assert.ok(l.includes(pools[i].ver) && l.includes(pools[i].feeLabel), `baris ${i} tak cocok urutan pool`);
  assert.ok(!l.includes(pools[i].pair), 'pasangan tak diulang di baris (ada di tombol)');
});
for (const p of pools) {
  const detail = kartu.split('\n').find((l) => l.includes(p.tvl))!;
  for (const v of [p.tvl, p.vol, p.apr, p.tight]) assert.ok(detail.includes(v), `angka ${v} hilang`);
}

// Baris teks & tombol dipotong dari daftar yang SAMA dengan batas yang sama —
// kalau salah satu berubah, pasangannya melenceng tanpa suara.
const idx = readFileSync('src/index.ts', 'utf8');
const sum = idx.slice(idx.indexOf('const poolSummaries'), idx.indexOf('const poolSummaries') + 400);
const kb = idx.slice(idx.indexOf('function poolKeyboard'), idx.indexOf('function poolKeyboard') + 400);
for (const [nama, blok] of [['poolSummaries', sum], ['poolKeyboard', kb]] as const)
  assert.match(blok, /slice\(0, POOL_PICK_MAX\)/, `${nama} harus memotong dgn batas yang sama`);

// APR/volume yang tak terbaca tak boleh jadi angka karangan.
const kosong = msgPoolStep('$X (BSC)', [{ pair: 'X / USDT', ver: 'V3', feeLabel: '1.00%', tvl: '$1.0K', apr: '?', tight: '5%' }]);
assert.match(kosong, /Vol 24h: \?/);
assert.match(kosong, /APR: \?/);

console.log('smoke-poolstep OK');
