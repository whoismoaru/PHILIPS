/**
 * Kartu TOKEN SECURITY AUDIT: bentuk pohon + aturan yang tak boleh dilanggar.
 * Yang paling mahal di kartu ini bukan tata letaknya, tapi mengarang jawaban:
 * "Disabled ✅" untuk data yang sebenarnya tak terbaca membuat token berbahaya
 * tampak bersih. Data hilang WAJIB jadi '?'.
 */
import assert from 'node:assert';
import { formatScreen } from '../src/screening.js';

const gmgn = {
  buyTaxPct: 0, sellTaxPct: 0, devPct: 4.1, insidersPct: 2, sniperCount: 4, bundlerPct: 8.5,
  lpLockedPct: 0, burntPct: 100, honeypot: false, renounced: true, openSource: true,
  top10Pct: 34.2, privileges: [], tagsFromTop100: false,
};
const full: any = {
  ok: true, name: 'Baola Token', symbol: '$ASD', verified: true, isProxy: false,
  holdersCount: 1240, top1Pct: 9.1, top10Pct: 34.2, top1IsContract: false,
  liquidityUsd: 62100, volume24h: 431000, buys24h: 812, sells24h: 640,
  priceUsd: '0.000452', marketCapUsd: 452500, pairAgeHours: 1.75, dexName: 'pancakeswap',
  renounced: true, sellPath: 'ok', flags: [], verdict: 'AMAN', gmgn,
};
const CA = '0xF7F2Fb6178290EB812e9bD280920f3dC63437777';
const kartu = formatScreen(full, { ca: CA, chainLabel: 'BSC' });

for (const bagian of ['BASIC STATS :', 'CONTRACT :', 'HOLDER RISK :', 'MARKET :'])
  assert.ok(kartu.includes(bagian), `bagian "${bagian}" hilang`);
for (const baris of ['Mint Authority', 'Freeze Authority', 'LP Status', 'Honeypot', 'Tax (Buy/Sell)',
  'Ownership', 'Dev Wallet', 'Sniper Bundles', 'Top 10 Holders', 'Total Holders', 'Liquidity', 'Age'])
  assert.ok(kartu.includes(baris), `baris "${baris}" hilang`);

// Tiap bagian pohon harus ditutup └ tepat sekali, dan tak ada ├ sesudahnya.
for (const blok of kartu.split('\n\n').filter((b) => b.includes('├')))
  assert.equal(blok.split('\n').filter((l) => l.startsWith('└')).length, 1, `pohon rusak:\n${blok}`);

assert.match(kartu, /Age: 1h 45m/, 'umur pool harus jam+menit, bukan pembulatan jam');
assert.match(kartu, /\$452\.5K/, 'mcap rentang K harus satu desimal');
assert.match(kartu, /\(Pancakeswap\)/, 'venue likuiditas harus disebut');
assert.match(kartu, /LP Status: 100% Burned/, 'burn didahulukan atas lock');
assert.match(kartu, /Honeypot: PASS/, 'sellPath ok = PASS');
assert.ok(kartu.includes(`<code>${CA}</code>`), 'CA harus tercetak');

// Privilege kosong = benar-benar tak ada → Disabled.
assert.match(kartu, /Mint Authority: Disabled/);

// Data hilang TIDAK boleh jadi jawaban positif.
const kosong = formatScreen(
  { ...full, gmgn: null, renounced: null, verified: null, sellPath: 'unknown', holdersCount: null, top10Pct: null, dexName: null } as any,
  { ca: CA, chainLabel: 'HyperEVM' },
);
for (const baris of ['Mint Authority', 'Freeze Authority', 'LP Status', 'Honeypot', 'Ownership', 'Dev Wallet', 'Total Holders']) {
  const l = kosong.split('\n').find((x) => x.includes(baris))!;
  assert.ok(/\?/.test(l), `"${baris}" mengarang jawaban saat data hilang: ${l}`);
  assert.ok(!/✅|PASS|Disabled|Renounced/.test(l), `"${baris}" mengaku aman tanpa data: ${l}`);
}
// Privilege null (payload tak terbaca) ≠ privilege [] (terbaca, tak ada).
const takTerbaca = formatScreen({ ...full, gmgn: { ...gmgn, privileges: null } } as any, { chainLabel: 'BSC' });
assert.ok(/Mint Authority: \?/.test(takTerbaca), 'privileges null harus "?", bukan Disabled');

// Proxy & Verified sengaja dipertahankan di luar naskah — kontrak proxy bisa
// diganti isinya sesudah audit ini dicetak.
assert.ok(kartu.includes('Proxy') && kartu.includes('Verified'));
assert.ok(kartu.length < 4096, 'kartu melewati batas pesan Telegram');

console.log('smoke-auditcard OK');
