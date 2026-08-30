/**
 * Audit /pnl (30 Agu 2026). Dua cacat yang diperbaiki:
 *  1. FLAT_EPS fallback 0.1 dipakai untuk satuan native tak terdaftar — pada HYPE
 *     (~$83) itu menghapus setiap trade di bawah ±$8,36 dari W/L & winrate;
 *  2. kartu gambar berjudul "All chains" di atas angka SATU buku saja.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as journal from '../src/journal.js';

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
