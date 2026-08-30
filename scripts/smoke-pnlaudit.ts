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
assert.match(img, /pair: `\$\{chain === ALL[^`]*\$\{main\.unit\}/, 'judul kartu wajib menyebut satuan bukunya');
assert.match(img, /other books/, 'buku yang tak muat di gambar harus disebut');

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

// Kalender: 30 kotak, urut, hari tanpa trade tetap ada.
const days = journal.dailyFor('robinhood', 'USDG', 30);
assert.equal(days.length, 30);
for (let i = 1; i < days.length; i++)
  assert.equal(days[i].date.getTime() - days[i - 1].date.getTime(), 86_400_000, 'kotak harus persis 1 hari');
assert.ok(days.every((d) => d.trades > 0 || d.net === 0), 'hari tanpa trade harus net 0');

// Batas hari = tengah malam WIB, bukan tengah malam mesin (mesin ini CST/UTC+8).
// Kotak terakhir wajib hari WIB HARI INI, dan tiap kotak tengah malam UTC pas.
const wibHariIni = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
assert.equal(days[29].date.toISOString().slice(0, 10), wibHariIni, 'kotak terakhir bukan hari WIB ini');
for (const d of days)
  assert.equal(d.date.getTime() % 86_400_000, 0, 'date harus tengah malam UTC dari hari WIB itu');
assert.match(
  readFileSync('src/journal.ts', 'utf8'),
  /const wibDay = \(ms: number\): number => Math\.floor\(\(ms \+ WIB_MS\) \/ DAY_MS\)/,
  'indeks hari harus bebas zona waktu mesin',
);
// Kartu membaca tanggalnya dengan getUTC* — kalau tidak, kolom & label bergeser.
const card = readFileSync('src/card.ts', 'utf8');
assert.match(card, /getUTCDay\(\)/, 'kolom hari harus dibaca UTC');
assert.match(card, /getUTCDate\(\)/, 'label tanggal harus dibaca UTC');

// 'recovery' bukan trade: uangnya masuk net, hitungannya tidak.
const jsrc = readFileSync('src/journal.ts', 'utf8');
for (const fn of ['dailyFor', 'dailyAllUsd']) {
  const blok = jsrc.slice(jsrc.indexOf(`export function ${fn}`), jsrc.indexOf(`export function ${fn}`) + 1600);
  assert.match(blok, /reason !== 'recovery'/, `${fn}: sweep dihitung sebagai trade`);
}

// Gabungan USD: satuan tanpa kurs DILEWATI dan dihitung, bukan dianggap nol.
const semua = journal.dailyAllUsd(() => null, 30);
assert.equal(semua.days.reduce((a, d) => a + d.trades, 0), 0, 'tanpa kurs, tak ada yang boleh masuk');
assert.ok(semua.skipped > 0, 'yang dilewati wajib dihitung, bukan hilang diam-diam');
const berkurs = journal.dailyAllUsd((u) => (u === 'USDG' || u === 'USDT' ? 1 : 2500), 30);
assert.equal(berkurs.skipped, 0);
assert.equal(berkurs.days.length, 30);
// 'skipped' hanya boleh menghitung entri DI DALAM jendela 30 hari.
assert.ok(semua.skipped <= berkurs.days.reduce((a, d) => a + d.trades, 0) + semua.skipped);

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

// ── Jendela: '1 Month' dan kalender harus mulai dari batas yang SAMA ─────────
// Rolling `now - 30d` mulai 22:30 WIB hari ke-31; kalender mulai 00:00 WIB hari
// ke-30. Trade yang jatuh di sela itu muncul di rekap tanpa punya kotak.
const mulai = journal.monthStartMs(30);
const kotak = journal.dailyFor('robinhood', 'USDG', 30);
assert.equal(mulai + 7 * 3_600_000, kotak[0].date.getTime(), 'awal jendela 1M ≠ kotak pertama kalender');
assert.ok(mulai > Date.now() - 31 * 86_400_000 && mulai <= Date.now(), 'jendela 1M di luar akal');
const jc2 = readFileSync('src/commands/journalCmds.ts', 'utf8');
assert.match(jc2, /key === '1m' \? journal\.monthStartMs\(30\)/, "'1 Month' harus memakai batas kalender");
assert.ok(!/statsFor\(Date\.now\(\) - 30 \* 24 \* 3600_000/.test(jc2), 'masih ada jendela rolling 30 hari yang lama');

// Kalender gabungan menjumlahkan SEMUA buku dalam USD, sementara kartu periode
// menampilkan SATU buku dalam satuannya sendiri — bedanya wajar, tapi harus
// dikatakan, kalau tidak terbaca sebagai salah hitung.
assert.match(jc2, /sum of \$\{buku\.length\} book/, 'kalender gabungan tak menjelaskan konversinya');

// Konsistensi angka: net kalender satu buku = net buku itu di rekap 30 hari.
for (const chain of ['robinhood', 'bsc', 'base']) {
  const st = journal.statsFor(mulai, chain);
  const main = st.books[0];
  if (!main) continue;
  const net = journal.dailyFor(chain, main.unit, 30).reduce((a, d) => a + d.net, 0);
  assert.ok(Math.abs(net - main.net) < 1e-9, `${chain}: kalender ${net} ≠ rekap ${main.net}`);
}
console.log('smoke-pnlaudit: jendela OK');

// ── Total lintas-buku: satu angka yang bisa dibandingkan dgn kalender ────────
const buku = [
  { unit: 'USDG', known: 1, wins: 1, losses: 0, flats: 0, net: 296.46, grossWin: 296.46, grossLoss: 0 },
  { unit: 'ETH', known: 1, wins: 1, losses: 0, flats: 0, net: 0.24524, grossWin: 0.24524, grossLoss: 0 },
];
const dgn = msgPnl({ dryRun: false, chainLabel: 'All chains', periodLabel: '1 Month', known: 2, usdTotal: 903.9, books: buku });
assert.match(dgn, /All books/, 'kartu multi-buku wajib punya total USD');
assert.match(dgn, /\$903\.90/);
// Satu kurs tak terbaca → JANGAN tampilkan total separuh.
assert.ok(!/All books/.test(msgPnl({ dryRun: false, chainLabel: 'All chains', periodLabel: '1 Month', known: 2, usdTotal: null, books: buku })),
  'total separuh terbaca sebagai fakta');
// Satu buku tak butuh konversi.
assert.ok(!/All books/.test(msgPnl({ dryRun: false, chainLabel: 'BSC', periodLabel: '1 Month', known: 1, usdTotal: 296.46, books: [buku[0]] })));

// Total di kartu = yang dijumlahkan kalender: dua-duanya net × kurs, buku per buku.
const kurs = new Map<string, number | null>([['USDG', 1], ['USDT', 1], ['ETH', 2478], ['HYPE', 83.76]]);
const st = journal.statsFor(journal.monthStartMs(30));
const dariBuku = st.books.reduce((a, b) => a + b.net * (kurs.get(b.unit) ?? 0), 0);
const dariKalender = journal.dailyAllUsd((u) => kurs.get(u) ?? null, 30).days.reduce((a, d) => a + d.net, 0);
assert.ok(Math.abs(dariBuku - dariKalender) < 1e-6, `kartu $${dariBuku} ≠ kalender $${dariKalender}`);
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
console.log('smoke-pnlaudit: rekonsiliasi OK');
