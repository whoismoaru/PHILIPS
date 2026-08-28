import assert from 'node:assert/strict';
import * as journal from '../src/journal.js';
import { renderCalendarCard } from '../src/card.js';

/** Kalender 30 hari: satu buku, satu satuan, hari kosong tetap punya kotaknya. */
const days = journal.dailyFor('robinhood', 'USDG', 30);
assert.equal(days.length, 30, 'harus tepat 30 hari, termasuk yang tanpa trade');
assert.ok(days.every((d) => d.date instanceof Date), 'tiap hari punya tanggal');
assert.ok(days.every((d) => d.trades >= 0), 'jumlah trade tak boleh negatif');

// Hari berurutan naik, tepat sehari terpisah — indeks dihitung dari tengah malam
// lokal, bukan pembagian milidetik yang meleset saat zona waktu bergeser.
for (let i = 1; i < days.length; i++) {
  const gap = days[i].date.getTime() - days[i - 1].date.getTime();
  assert.ok(gap >= 23 * 3600_000 && gap <= 25 * 3600_000, `jarak hari ke-${i} tak wajar: ${gap}ms`);
}
// Hari terakhir = hari ini.
const today = new Date(); today.setHours(0, 0, 0, 0);
assert.equal(days[29].date.getTime(), today.getTime(), 'hari terakhir harus hari ini');

// "tak ada trade" berbeda dari "impas": net 0 boleh, tapi hanya bila trades 0 juga 0.
assert.ok(days.every((d) => d.trades > 0 || d.net === 0), 'hari tanpa trade tak boleh punya net');

// Kartunya benar-benar terender (dan tanpa artwork — tak butuh berkas latar).
const buf = await renderCalendarCard({
  title: 'Test · USDG', subtitle: 'last 30 days', days, unit: 'USDG',
  netLabel: '+1.00 USDG', positive: true,
  stats: [{ label: 'best day', value: '+1.00' }],
  footerLeft: 'smoke',
}, 1);
assert.ok(buf.length > 5000, 'kartu kalender kosong / gagal render');

// Gabungan lintas chain: satuan tanpa kurs DILEWATI dan dihitung, bukan dianggap 0.
const all = journal.dailyAllUsd(() => 1, 30);
assert.equal(all.days.length, 30);
assert.equal(all.skipped, 0, 'dengan kurs lengkap tak boleh ada yang dilewati');
const none = journal.dailyAllUsd(() => null, 30);
assert.equal(none.days.reduce((a, d) => a + d.trades, 0), 0, 'tanpa kurs, tak ada trade yang boleh masuk');
assert.ok(none.skipped >= 0 && Number.isInteger(none.skipped), 'jumlah yang dilewati harus dilaporkan');

console.log('OK — kalender 30 hari: bucket harian benar, gabungan USD melewatkan yang tanpa kurs.');
