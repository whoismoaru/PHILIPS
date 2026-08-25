/** Penjaga: tiap notifikasi ALERT di monitor wajib berpagar setelan /alerts.
 *  Regresi nyata: jalur v4 kirim in/out-range walau rangeNotify=false. Offline. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/monitor.ts', import.meta.url), 'utf8').split('\n');

// Laporan AKSI (bot memindahkan uangmu) sengaja selalu bunyi — bukan /alerts.
const selaluBoleh = [/Swept leftover/, /Swept .* stuck/];

const bocor: string[] = [];
src.forEach((line, i) => {
  if (!/telegram\.sendMessage/.test(line)) return;
  const blok = src.slice(Math.max(0, i - 26), i + 4).join('\n');
  if (selaluBoleh.some((re) => re.test(blok))) return;
  // pagar sah: cfg.<flag> / alerts.get().<flag> dalam 26 baris sebelumnya
  if (/\b(cfg|alerts\.get\(\))\s*\.\s*(rangeNotify|dropPct|ilPct)/.test(blok)) return;
  bocor.push(`baris ${i + 1}: ${line.trim()}`);
});

assert.deepEqual(bocor, [],
  'notifikasi monitor tanpa pagar /alerts (user mematikan alert tapi tetap dikirimi):\n' + bocor.join('\n'));

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

console.log('smoke-alerts: LULUS');
