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
  assert.ok(days[i].date.getTime() > days[i - 1].date.getTime(), 'tanggal harus menaik');
assert.ok(days.every((d) => d.trades > 0 || d.net === 0), 'hari tanpa trade harus net 0');

// Gabungan USD: satuan tanpa kurs DILEWATI dan dihitung, bukan dianggap nol.
const semua = journal.dailyAllUsd(() => null, 30);
assert.equal(semua.days.reduce((a, d) => a + d.trades, 0), 0, 'tanpa kurs, tak ada yang boleh masuk');
assert.ok(semua.skipped > 0, 'yang dilewati wajib dihitung, bukan hilang diam-diam');
const berkurs = journal.dailyAllUsd((u) => (u === 'USDG' || u === 'USDT' ? 1 : 2500), 30);
assert.equal(berkurs.skipped, 0);

console.log('smoke-pnlaudit OK');
