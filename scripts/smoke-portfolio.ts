/**
 * Kartu PORTFOLIO. Yang dijaga bukan tata letaknya, tapi angkanya: kartu ini
 * satu-satunya tempat pemilik membaca "berapa uangku", jadi USD yang tak terbaca
 * WAJIB '—'. Menjumlahkan sisanya diam-diam menampilkan saldo yang lebih kecil
 * dari isi dompet sebenarnya — dan itu terbaca sebagai kehilangan dana.
 */
import assert from 'node:assert';
import { msgStatus } from '../src/messages.js';

const chains: any = [
  { label: 'Robinhood', amount: '0.0091', symbol: 'ETH', usd: 22.67, stables: [] },
  { label: 'BSC', amount: '0.0004', symbol: 'BNB', usd: 0.26, stables: [{ symbol: 'USDT', amount: '122.37', usd: 122.37 }] },
  { label: 'Base', amount: '0.0005', symbol: 'ETH', usd: 1.24, stables: [] },
  { label: 'HyperEVM', amount: '0.0591', symbol: 'HYPE', usd: 4.94, stables: [] },
  { label: 'Ink', amount: '0.0000', symbol: 'ETH', usd: 0, stables: [] },
];
const kartu = msgStatus({ dryRun: false, positions: 1, chains, totalUsd: 151.48, lpUsd: 211.46 });

assert.match(kartu, /EQUITY :/);
assert.match(kartu, /BY CHAIN :/);
assert.match(kartu, /Total: <b>\$362\.94<\/b>/, 'total = bebas + LP');
assert.match(kartu, /1 position\b/, 'tunggal tak boleh "positions"');
assert.match(msgStatus({ dryRun: false, positions: 3, chains, totalUsd: 1, lpUsd: 1 }), /3 positions/);

// Nama pendek hanya untuk yang terdaftar; sisanya apa adanya.
assert.match(kartu, /<b>RH<\/b>: \$22\.67/);
assert.match(kartu, /<b>BASE<\/b>/);
assert.match(kartu, /<b>HyperEVM<\/b>/, 'chain tak terdaftar pakai labelnya sendiri');

// Nilai chain = native + SELURUH stablecoin di chain itu.
assert.match(kartu, /<b>BSC<\/b>: \$122\.63/, 'stablecoin harus ikut nilai chain-nya');
assert.match(kartu, /0\.0004 BNB · 122\.37 USDT/, 'nominal tiap aset tetap tampil');

// Chain kosong tak menyita baris.
assert.ok(!kartu.includes('Ink'), 'chain bersaldo nol tak perlu ditampilkan');

// Tiap pohon ditutup └ tepat sekali.
for (const blok of kartu.split('\n\n').filter((b) => b.includes('├')))
  assert.equal(blok.split('\n').filter((l) => l.startsWith('└')).length, 1, `pohon rusak:\n${blok}`);

// USD tak terbaca → '—', JANGAN $0.00 dan jangan jumlah sebagian.
const buta = msgStatus({
  dryRun: false, positions: 1, totalUsd: null, lpUsd: null, lpFailed: 2,
  chains: [{ label: 'BSC', amount: '0.0004', symbol: 'BNB', usd: null, stables: [{ symbol: 'USDT', amount: '122.37', usd: 122.37 }] }] as any,
});
assert.match(buta, /Total: <b>—<\/b>/);
assert.match(buta, /Free: <b>—<\/b>/);
assert.match(buta, /<b>BSC<\/b>: —/, 'satu bagian tak terbaca = seluruh baris —');
assert.ok(!/\$0\.00/.test(buta), 'nol palsu terbaca sebagai fakta');
assert.match(buta, /failed to read/, 'posisi gagal baca wajib diakui');

// DRY RUN wajib menonjol; LIVE tak perlu label.
assert.match(msgStatus({ dryRun: true, positions: 0, chains: [], totalUsd: 0 }), /DRY RUN/);
assert.ok(!/LIVE/.test(kartu));

console.log('smoke-portfolio OK');
