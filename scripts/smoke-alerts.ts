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

// setV4InRange PUNYA efek samping — harus dipanggil walau notifikasi mati,
// kalau tidak status jadi basi dan alert palsu muncul saat dinyalakan lagi.
const v4 = src.join('\n');
assert.ok(/const berubah = [^\n]*setV4InRange/.test(v4),
  'setV4InRange harus dipanggil sebelum pagar alert (status wajib tetap segar)');

console.log('smoke-alerts: LULUS');
