import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/monitor.ts', import.meta.url), 'utf8').split('\n');

const kirimLangsung = src
  .map((l, i) => [i + 1, l.trim()] as const)
  .filter(([, l]) => l.includes('bot.telegram.sendMessage'));
assert.equal(kirimLangsung.length, 1,
  'monitor harus punya TEPAT SATU bot.telegram.sendMessage (di dalam notify()); ' +
  'sisanya wajib lewat notify(bot, flag, ...):\n' + kirimLangsung.map(([n, l]) => `baris ${n}: ${l}`).join('\n'));

const isiNotify = src.join('\n').match(/async function notify\([\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(/alerts\.get\(\)\[flag\]/.test(isiNotify) && /return;/.test(isiNotify),
  'notify() tak lagi memeriksa /alerts — pagar bocor');

const flagSah = /await notify\(bot, (null|'rangeNotify'|'dropPct'|'ilPct')/;
const panggil = src.map((l, i) => [i + 1, l.trim()] as const).filter(([, l]) => l.startsWith('await notify('));
const flagJelek = panggil.filter(([, l]) => !flagSah.test(l)).map(([n, l]) => `baris ${n}: ${l}`);
assert.deepEqual(flagJelek, [], 'panggilan notify dengan flag tak dikenal:\n' + flagJelek.join('\n'));
assert.ok(panggil.length >= 9, `panggilan notify hanya ${panggil.length} — ada yang hilang?`);

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

const { dropPctFromTick } = await import('../src/monitor.js');
const dekat = (a: number, b: number, tol = 0.05) =>
  assert.ok(Math.abs(a - b) < tol, `${a.toFixed(4)} != ${b.toFixed(4)}`);

dekat(dropPctFromTick(331168, 331168, true), 0);            
dekat(dropPctFromTick(331168 + 1054, 331168, true), 10.0);  
dekat(dropPctFromTick(331168 - 383, 331168, true), -3.90);  

dekat(dropPctFromTick(331168 - 1054, 331168, false), 10.0);
dekat(dropPctFromTick(331168 + 1054, 331168, false), -11.11);

assert.ok(dropPctFromTick(1000, 0, true) > 0, 'dip harus positif');
assert.ok(dropPctFromTick(-1000, 0, true) < 0, 'kenaikan harga jangan memicu alert anjlok');

console.log('smoke-alerts: LULUS');
