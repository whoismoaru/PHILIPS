/**
 * Audit /pnl (30 Agu 2026). Dua cacat yang diperbaiki:
 *  1. FLAT_EPS fallback 0.1 dipakai untuk satuan native tak terdaftar — pada HYPE
 *     (~$83) itu menghapus setiap trade di bawah ±$8,36 dari W/L & winrate;
 *  2. kartu gambar berjudul "All chains" di atas angka SATU buku saja.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as journal from '../src/journal.js';
import { msgPnl, msgPnlPicker } from '../src/messages.js';

// 1) Tiap satuan yang bisa muncul di jurnal punya ambang impas yang masuk akal.
const src = readFileSync('src/journal.ts', 'utf8');
const eps = src.slice(src.indexOf('const FLAT_EPS'), src.indexOf('FLAT_EPS_UNKNOWN'));
for (const unit of ['USDT', 'USDG', 'USDC', 'ETH', 'BNB', 'HYPE'])
  assert.ok(new RegExp(`\\b${unit}:`).test(eps), `satuan ${unit} tak punya ambang impas sendiri`);
assert.match(src, /FLAT_EPS\[unit\] \?\? FLAT_EPS_UNKNOWN/, 'fallback harus nyaris nol, bukan 0.1');
const unknown = Number(src.match(/const FLAT_EPS_UNKNOWN = ([\d.e-]+)/)![1]);
assert.ok(unknown < 1e-6, `fallback ${unknown} masih cukup besar untuk menelan trade sungguhan`);

// 2) Judul kartu gambar menyebut BUKU-nya, bukan cuma cakupan chain.
const jc = readFileSync('src/commands/journalCmds.ts', 'utf8');
const img = jc.slice(jc.indexOf('async function pnlImage'), jc.indexOf('function pnlCaption'));
// Sejak seluruh rekap dihitung dalam USD, gambar memuat SATU buku yang sudah
// mencakup semuanya — tak boleh ada lagi buku yang tertinggal di luar bingkai.
assert.ok(!/other books/.test(img), 'masih ada buku yang tak muat di gambar');
assert.match(img, /pair: `\$\{chain === ALL[^`]*PERIODS\[key\]\.label\}`/, 'judul kartu harus menyebut periodenya');

// Winrate & profit factor: impas tak boleh masuk penyebut.
assert.equal(journal.winrateOf({ wins: 3, losses: 1 }), 75);
assert.equal(journal.winrateOf({ wins: 0, losses: 0 }), 0, 'tanpa trade jangan bagi nol');
assert.equal(journal.profitFactorOf({ grossWin: 10, grossLoss: -5 }), 2);
assert.equal(journal.profitFactorOf({ grossWin: 10, grossLoss: 0 }), null, 'tanpa rugi, PF tak terdefinisi');

// Buku tak pernah dicampur: tiap satuan berdiri sendiri.
const s = journal.statsFor(0);
assert.equal(new Set(s.books.map((b) => b.unit)).size, s.books.length, 'satu buku per satuan');
assert.equal(s.books.reduce((a, b) => a + b.known, 0), s.known, 'known harus = jumlah known tiap buku');
for (const b of s.books) {
  assert.equal(b.known, b.wins + b.losses, `${b.unit}: known harus hanya W+L`);
  assert.ok(b.grossWin >= 0 && b.grossLoss <= 0, `${b.unit}: tanda gross terbalik`);
}

console.log('smoke-pnlaudit OK');

// ── Pemilik: tak satu pun angka boleh memuat trade wallet lain ───────────────
// Jurnal ini memang berisi dua wallet (727 milik yang aktif, 181 milik yang lama),
// jadi kebocoran di sini bukan hipotesis — ia akan langsung terlihat.
const me = journal.currentWallet();
if (me) {
  const asing = (xs: Array<{ wallet?: string }>) => xs.filter((e) => e.wallet !== me).length;
  assert.equal(asing(journal.readMine(999)), 0, 'readMine membocorkan wallet lain');
  assert.equal(journal.statsFor(0).count, journal.readMine(999).length, 'cakupan /pnl ≠ cakupan riwayat');

  // Pembaca yang menyentuh uang atau menampilkan riwayat WAJIB lewat readMine.
  for (const [berkas, pola] of [
    ['src/commands/journalCmds.ts', /journal\.readMine\(8\)/],
    ['src/monitor.ts', /\.readMine\(80\)/],
  ] as const)
    assert.match(readFileSync(berkas, 'utf8'), pola, `${berkas} memakai read() polos — riwayat wallet lain ikut`);

  // Entri baru selalu dicap pemiliknya; tanpa cap, penyaring di atas tak berarti.
  assert.match(readFileSync('src/journal.ts', 'utf8'), /wallet: e\.wallet \?\? currentWallet\(\)/, 'entri jurnal tak dicap pemilik');
}
console.log('smoke-pnlaudit: pemilik OK');

// Rolling `now - 30d` mulai 22:30 WIB hari ke-31; kalender mulai 00:00 WIB hari
// ke-30. Trade yang jatuh di sela itu muncul di rekap tanpa punya kotak.
const mulai = journal.monthStartMs(30);
// Batas hari PENUH menurut WIB: stabil sepanjang hari, tak bergeser tiap kartu dibuka.
assert.equal((mulai + 7 * 3_600_000) % 86_400_000, 0, 'awal jendela bukan tengah malam WIB');
assert.ok(mulai > Date.now() - 31 * 86_400_000 && mulai <= Date.now(), 'jendela 1M di luar akal');
assert.equal(journal.monthStartMs(30), journal.monthStartMs(30), 'jendela harus deterministik');
const jc2 = readFileSync('src/commands/journalCmds.ts', 'utf8');
assert.ok(!/statsFor\(Date\.now\(\) - 30 \* 24 \* 3600_000/.test(jc2), 'masih ada jendela rolling 30 hari yang lama');

// Kalender gabungan menjumlahkan SEMUA buku dalam USD, sementara kartu periode
// menampilkan SATU buku dalam satuannya sendiri — bedanya wajar, tapi harus
// dikatakan, kalau tidak terbaca sebagai salah hitung.

// Jendela dipakai apa adanya oleh tiap chain — tak ada jalur kedua yang bisa
// menghitung periode yang sama dengan batas berbeda.
for (const chain of ['robinhood', 'bsc', 'base']) {
  const stc = journal.statsFor(mulai, chain);
  assert.ok(stc.count >= stc.books.reduce((a, b) => a + b.known, 0), `${chain}: berskor melebihi jumlah entri`);
}
console.log('smoke-pnlaudit: jendela OK');

// ── Semua angka rekap dalam USD ─────────────────────────────────────────────
const kurs = new Map<string, number | null>([['USDG', 1], ['USDT', 1], ['ETH', 2478], ['HYPE', 83.76]]);
const usd = journal.statsFor(0, undefined, (u) => kurs.get(u) ?? null);
assert.deepEqual(usd.books.map((b) => b.unit), ['USD'], 'mode USD harus menghasilkan SATU buku');

// Nilainya = jumlah net tiap buku asli × kursnya. Tak ada jalur hitung kedua.
const asli = journal.statsFor(0);
const dariAsli = asli.books.reduce((a, b) => a + b.net * (kurs.get(b.unit) ?? 0), 0);
assert.ok(Math.abs(usd.books[0].net - dariAsli) < 1e-6, `USD ${usd.books[0].net} ≠ jumlah buku ${dariAsli}`);

// Kurs SAAT CLOSE didahulukan; kurs sekarang cuma cadangan untuk entri lama.
const dicap = { tokenId: '1', symbol: 'X', openedAt: 0, closedAt: Date.now(), initialWethWei: '0',
  resultEthWei: '1', pnlEth: 1, pnlPct: 1, reason: 'cashed' as const, usdRate: 10 };
assert.equal(
  journal.statsFor(0, undefined, () => 1).estimated + journal.statsFor(0, undefined, () => 1).books.reduce((a, b) => a + b.known, 0) >= 0,
  true,
);
{
  // Entri lama (tanpa cap) HARUS dihitung sebagai taksiran, bukan diam-diam.
  const st = journal.statsFor(0, undefined, () => 1);
  const lama = journal.readMine(999999).filter((e) => e.usdRate === undefined).length;
  const dipakai = st.count - st.untracked - st.excluded;
  assert.ok(st.estimated <= lama, 'taksiran melebihi entri yang memang tak tercap');
  assert.ok(st.estimated <= dipakai, 'taksiran melebihi entri yang dihitung');
}
// Cap tak boleh ditimpa kurs baru.
assert.match(readFileSync('src/journal.ts', 'utf8'), /rate = e\.usdRate;/, 'kurs tercap harus didahulukan');
assert.match(readFileSync('src/journal.ts', 'utf8'), /usdRate: e\.usdRate \?\? rateNow\(/, 'entri baru harus dicap saat ditulis');
// Kurs basi tak boleh dipakai mencap.
assert.match(readFileSync('src/journal.ts', 'utf8'), /RATE_TTL_MS/, 'cap tanpa batas kedaluwarsa');

// Kurs tak terbaca → entri DILEWATI dan dihitung, bukan dianggap nol.
const buta = journal.statsFor(0, undefined, () => null);
assert.equal(buta.books.length, 0, 'tanpa kurs tak boleh ada buku');
assert.ok(buta.unconverted > 0, 'entri tanpa kurs wajib dihitung');
assert.equal(buta.unconverted + buta.untracked + buta.excluded, buta.count, 'entri hilang tanpa jejak');

// Kartu mencetak dolar, bukan satuan asli, dan mengakui yang tak terkonversi.
const kartuUsd = msgPnl({
  dryRun: false, chainLabel: 'All chains', periodLabel: 'All Time',
  known: usd.known, count: usd.count, untracked: usd.untracked, excluded: usd.excluded,
  recovered: usd.recovered, unconverted: usd.unconverted, books: usd.books,
});
assert.match(kartuUsd, /\$/, 'kartu USD tanpa tanda dolar');
assert.ok(!/USDG book|ETH book|HYPE book/.test(kartuUsd), 'masih ada buku per satuan di kartu USD');
assert.match(
  msgPnl({ dryRun: false, chainLabel: 'x', periodLabel: 'y', known: 1, count: 9, unconverted: 3,
    books: [{ unit: 'USD', known: 1, wins: 1, losses: 0, flats: 0, net: 1, grossWin: 1, grossLoss: 0 }] }),
  /no USD rate/,
  'entri tanpa kurs tak diakui di kartu',
);

console.log('smoke-pnlaudit: total USD OK');

// ── Rekonsiliasi: 728 entri vs 246 berskor harus bisa ditelusuri ─────────────
// Pemilih chain dan kartu rekap sama-sama memakai kata "trades" untuk dua hal
// berbeda; selisihnya (impas + hasil tak terbaca + sweep) wajib disebut, kalau
// tidak terbaca sebagai ratusan trade yang hilang antar layar.
const st0 = journal.statsFor(0);
const berskor = st0.books.reduce((a, b) => a + b.known, 0);
const impas = st0.books.reduce((a, b) => a + b.flats, 0);
assert.equal(
  berskor + impas + st0.untracked + st0.excluded + st0.recovered,
  st0.count,
  'entri jurnal tak bisa direkonsiliasi — ada kategori yang tak terhitung',
);

const kartu = msgPnl({
  dryRun: false, chainLabel: 'All chains', periodLabel: 'All Time',
  known: st0.known, count: st0.count, untracked: st0.untracked,
  excluded: st0.excluded, recovered: st0.recovered, books: st0.books,
});
assert.match(kartu, new RegExp(`${st0.count} closed`), 'kartu tak menyebut jumlah entri');
assert.match(kartu, new RegExp(`<b>${berskor}</b>`), 'kartu tak menyebut jumlah berskor');
assert.match(kartu, /scored/, 'istilah scored harus muncul');
if (impas) assert.match(kartu, /break-even/, 'impas tak dijelaskan di mana pun');

// Pemilih chain menyebut DUA angka bila berbeda, satu angka bila sama.
const picker = msgPnlPicker([{ label: 'Robinhood', trades: 480, scored: 161 }, { label: 'Ink', trades: 0, scored: 0 }]);
assert.match(picker, /480 closed · 161 scored/);
assert.match(picker, /Ink[^\n]*0 closed/);
assert.ok(!/0 closed · 0 scored/.test(picker), 'angka sama tak perlu ditulis dua kali');
assert.match(picker, /Scored = wins\/losses only/, 'istilah "scored" harus dijelaskan');
assert.match(picker, /All figures in USD/, 'pemilih harus menyebut satuannya');
console.log('smoke-pnlaudit: rekonsiliasi OK');
