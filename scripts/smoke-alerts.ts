/** Penjaga: tiap notifikasi ALERT di monitor wajib berpagar setelan /alerts.
 *  Regresi nyata: jalur v4 kirim in/out-range walau rangeNotify=false. Offline. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/monitor.ts', import.meta.url), 'utf8').split('\n');

// SATU pintu: semua notifikasi lewat notify(bot, flag, ...) yang memaksa pagar
// jadi parameter. Kirim langsung lewat bot.telegram di monitor = pagar terlupa.
// (Versi lama penjaga ini memindai "ada cfg.x dalam N baris" — dan LOLOS saat
// pagar IL v4 dicabut, karena menemukan pagar TETANGGA. Diganti karena cek yang
// bisa hijau saat bug ada lebih berbahaya daripada tak ada cek.)
const kirimLangsung = src
  .map((l, i) => [i + 1, l.trim()] as const)
  .filter(([, l]) => l.includes('bot.telegram.sendMessage'));
assert.equal(kirimLangsung.length, 1,
  'monitor harus punya TEPAT SATU bot.telegram.sendMessage (di dalam notify()); ' +
  'sisanya wajib lewat notify(bot, flag, ...):\n' + kirimLangsung.map(([n, l]) => `baris ${n}: ${l}`).join('\n'));

// dan pintu itu benar-benar memeriksa setelan
const isiNotify = src.join('\n').match(/async function notify\([\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(/alerts\.get\(\)\[flag\]/.test(isiNotify) && /return;/.test(isiNotify),
  'notify() tak lagi memeriksa /alerts — pagar bocor');

// tiap panggilan menyebut flag yang sah (atau null utk laporan aksi)
const flagSah = /await notify\(bot, (null|'rangeNotify'|'dropPct'|'ilPct')/;
const panggil = src.map((l, i) => [i + 1, l.trim()] as const).filter(([, l]) => l.startsWith('await notify('));
const flagJelek = panggil.filter(([, l]) => !flagSah.test(l)).map(([n, l]) => `baris ${n}: ${l}`);
assert.deepEqual(flagJelek, [], 'panggilan notify dengan flag tak dikenal:\n' + flagJelek.join('\n'));
assert.ok(panggil.length >= 9, `panggilan notify hanya ${panggil.length} — ada yang hilang?`);

// --- penjaga: state alert tak boleh BEKU saat notifikasi dimatikan ---
// Kalau penanda (lastInRange / dropTier / ilAlerted) hanya diperbarui di dalam
// pagar cfg, mematikan lalu menyalakan /alerts membuat perbandingan memakai
// status basi: v4 dulu mengirim alert palsu, v3 malah BUNGKAM sampai ambang
// lama tertembus lagi.
const teks = src.join('\n');
for (const [nama, pola] of [
  ['v3 lastInRange diperbarui tanpa syarat',
   /store\.update\(rec\.tokenId, \{ lastInRange: d\.inRange \}\);\n\s*\} catch/],
  ['v3 dropTier di-reset saat dropPct mati',
   /\} else if \(rec\.dropTier \|\| rec\.dropAlerted\) \{/],
  ['v3 ilAlerted di-reset saat ilPct mati',
   /\} else if \(rec\.ilAlerted\) \{/],
  ['v4 setV4InRange dipanggil sebelum pagar',
   /const berubah = [^\n]*setV4InRange/],
] as const) {
  assert.ok(pola.test(teks), `state alert bisa beku — ${nama}`);
}

// --- matematika alert anjlok v4: turunan harga dari TICK, tanpa sumber luar ---
const { dropPctFromTick } = await import('../src/monitor.js');
const dekat = (a: number, b: number, tol = 0.05) =>
  assert.ok(Math.abs(a - b) < tol, `${a.toFixed(4)} != ${b.toFixed(4)}`);

// base = currency0 (mis. USDG/MARTIANS): tick NAIK = token MURAH = dip.
dekat(dropPctFromTick(331168, 331168, true), 0);            // diam
dekat(dropPctFromTick(331168 + 1054, 331168, true), 10.0);  // 1.0001^-1054 ≈ 0.90
dekat(dropPctFromTick(331168 - 383, 331168, true), -3.90);  // tick turun = token NAIK

// base = currency1: arahnya terbalik.
dekat(dropPctFromTick(331168 - 1054, 331168, false), 10.0);
dekat(dropPctFromTick(331168 + 1054, 331168, false), -11.11);

// yang dipakai alert: hanya nilai POSITIF (dip) yang menembus tangga.
assert.ok(dropPctFromTick(1000, 0, true) > 0, 'dip harus positif');
assert.ok(dropPctFromTick(-1000, 0, true) < 0, 'kenaikan harga jangan memicu alert anjlok');

console.log('smoke-alerts: LULUS');
