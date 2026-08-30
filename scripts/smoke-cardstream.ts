/**
 * Kartu posisi dulu: bangun SEMUA dulu (await mapLimit) baru kirim satu-satu →
 * layar diam sepanjang gelombang build terakhir. mapLimitStream mengirim kartu #1
 * begitu #1 jadi, dengan urutan tetap terjaga.
 */
import assert from 'node:assert';
import { mapLimitStream, POS_CARD_CONCURRENCY } from '../src/core.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Urutan hasil mengikuti urutan input, bukan urutan selesai.
const ms = [50, 5, 30, 1, 20];
const t0 = Date.now();
const ps = mapLimitStream(ms, 2, async (d, i) => {
  await sleep(d);
  return i;
});
const firstDone = await Promise.race([ps[0].then(() => 'first'), ps[1].then(() => 'second')]);
assert.equal(firstDone, 'second', 'item cepat selesai duluan (jalan paralel)');
assert.deepEqual(await Promise.all(ps), [0, 1, 2, 3, 4], 'urutan hasil harus tetap');

// Batas concurrency dihormati.
let live = 0;
let peak = 0;
await Promise.all(
  mapLimitStream(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    peak = Math.max(peak, ++live);
    await sleep(5);
    live--;
  }),
);
assert.equal(peak, 3, `concurrency terlampaui: ${peak}`);

// Item gagal tak boleh menjatuhkan proses (unhandled rejection) sebelum di-await,
// dan tak boleh menghalangi item lain.
const mixed = mapLimitStream([1, 2, 3], 2, async (n) => {
  if (n === 2) throw new Error('kartu gagal dibaca');
  return n;
});
await sleep(30); // beri waktu rejection "menganggur" — di sinilah Node dulu mati
assert.equal(await mixed[0], 1);
await assert.rejects(() => mixed[1], /kartu gagal/);
assert.equal(await mixed[2], 3);

assert.equal(mapLimitStream([], 3, async () => 1).length, 0, 'daftar kosong = tak ada worker');
assert.ok(POS_CARD_CONCURRENCY >= 6, 'concurrency kartu dinaikkan dari 3');
assert.ok(Date.now() - t0 < 2000);
console.log('smoke-cardstream OK');
