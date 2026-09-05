/**
 * Skor /pnl per POSISI, bukan per leg.
 *
 * Satu ladder 8-leg dulu terbaca 8 trade dengan PnL masing-masing ~1/8 — cukup
 * kecil untuk lolos ambang debu dan hilang dari W/L. Cek ini mengunci perilaku
 * barunya, sekaligus memastikan NET tak ikut berubah (uangnya tetap uang yang sama).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Jurnal dibaca dari `cwd`, jadi uji ini pindah ke folder sementara — .env ikut
// dibawa supaya config tetap termuat, dan data/journal.jsonl asli tak tersentuh.
const dir = mkdtempSync(join(tmpdir(), 'pnlgroup-'));
mkdirSync(join(dir, 'data'));
copyFileSync(join(process.cwd(), '.env'), join(dir, '.env'));
process.chdir(dir);
process.env.WALLET_SECRET ??= '0x' + '11'.repeat(32);

const journal = await import('../src/journal.js');
const me = journal.currentWallet();
assert.ok(me, 'butuh wallet aktif untuk uji ini');

const t0 = Date.now() - 3600_000;
/** 8 leg satu ladder: tiap leg +$0,05 (di bawah ambang debu), total +$0,40. */
const legs = Array.from({ length: 8 }, (_, i) => ({
  tokenId: `${100 + i}`, symbol: 'LADDER', ca: '0xaaa', chain: 'bsc', baseKind: 'usdt' as const,
  openedAt: t0, closedAt: t0 + i, initialWethWei: '1000', resultEthWei: '1050',
  pnlEth: 0.05, pnlPct: 5, reason: 'cashed' as const, wallet: me, usdRate: 1,
}));
/** Satu trade tunggal yang menang jelas — pembanding. */
const solo = {
  tokenId: '900', symbol: 'SOLO', ca: '0xbbb', chain: 'bsc', baseKind: 'usdt' as const,
  openedAt: t0, closedAt: t0 + 9_000, initialWethWei: '1000', resultEthWei: '2000',
  pnlEth: 5, pnlPct: 500, reason: 'cashed' as const, wallet: me, usdRate: 1,
};
writeFileSync(join(dir, 'data', 'journal.jsonl'), [...legs, solo].map((e) => JSON.stringify(e)).join('\n') + '\n');

const s = journal.statsFor(0, undefined, () => 1);
const b = s.books[0]!;

assert.equal(s.count, 9, 'count tetap jumlah ENTRI');
assert.equal(s.known, 2, `ladder + solo = 2 trade berskor, dapat ${s.known}`);
assert.equal(b.wins, 2, `ladder menang sbg satu kesatuan (+$0,40 > $0,10), dapat ${b.wins} menang`);
assert.equal(b.flats, 0, 'tak boleh ada leg yang jatuh jadi debu setelah dikelompokkan');
assert.ok(Math.abs(b.net - 5.4) < 1e-9, `net harus 8×0,05 + 5 = 5,4, dapat ${b.net}`);

/** groupId eksplisit mengalahkan tebakan waktu: dua ladder yang tutup bersamaan tetap terpisah. */
const pairs = [
  { ...legs[0], tokenId: 'g1a', groupId: 'G1', closedAt: t0 }, { ...legs[0], tokenId: 'g1b', groupId: 'G1', closedAt: t0 + 1 },
  { ...legs[0], tokenId: 'g2a', groupId: 'G2', closedAt: t0 + 2 }, { ...legs[0], tokenId: 'g2b', groupId: 'G2', closedAt: t0 + 3 },
];
writeFileSync(join(dir, 'data', 'journal.jsonl'), pairs.map((e) => JSON.stringify(e)).join('\n') + '\n');
const g = journal.statsFor(0, undefined, () => 1);
assert.equal(g.known + g.books[0]!.flats, 2, 'groupId harus memisahkan dua ladder yang tutup di detik yang sama');

/**
 * Hasil terukur + modal tak terekam = PnL TAK TERHITUNG, bukan laba sebesar
 * seluruh cash-out. Tiga entri semacam ini pernah menyumbang $662 laba palsu.
 */
const hantu = {
  tokenId: '777', symbol: 'GHOST', ca: '0xccc', chain: 'bsc', baseKind: 'usdt' as const,
  openedAt: t0, closedAt: t0 + 50_000, initialWethWei: '0', resultEthWei: '5000',
  pnlEth: 5, pnlPct: 0, reason: 'cashed' as const, wallet: me, usdRate: 1,
};
writeFileSync(join(dir, 'data', 'journal.jsonl'), [solo, hantu].map((e) => JSON.stringify(e)).join('\n') + '\n');
const h = journal.statsFor(0, undefined, () => 1);
assert.equal(h.noCapital, 1, 'entri bermodal nol harus dihitung terpisah');
assert.equal(h.known, 1, 'hanya solo yang boleh berskor');
assert.ok(Math.abs(h.books[0]!.net - 5) < 1e-9, `net harus 5 (solo saja), dapat ${h.books[0]!.net} — hantu ikut terhitung`);

/** 'recovery' memang bermodal nol dan itu SAH: modalnya sudah dibukukan di close aslinya. */
const sweep = { ...hantu, tokenId: '778', reason: 'recovery' as const };
writeFileSync(join(dir, 'data', 'journal.jsonl'), [solo, sweep].map((e) => JSON.stringify(e)).join('\n') + '\n');
const rc = journal.statsFor(0, undefined, () => 1);
assert.equal(rc.noCapital, 0, 'sweep tak boleh ikut tersaring');
assert.equal(rc.recovered, 1, 'sweep harus tetap dikreditkan');
assert.ok(Math.abs(rc.books[0]!.net - 10) < 1e-9, 'sweep harus menambah net');

console.log('OK smoke-pnlgroup: skor per posisi, net utuh, groupId menang atas tebakan waktu, modal-nol dilewati');
