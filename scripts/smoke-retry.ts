/** Cek penjaga retry otomatis. Jalankan: npx tsx scripts/smoke-retry.ts
 *
 *  Yang dijaga: percobaan kedua HANYA boleh jalan bila tak ada apa pun yang
 *  mendarat di chain. Kalau penjaga ini rusak, bot bisa beli/jual/mint dua kali. */
import assert from 'node:assert/strict';
import { retryOnce } from '../src/retry.js';

const quiet = { sleepMs: 0, log: () => {} };

// 1. Sukses langsung → run dipanggil sekali.
let n = 0;
assert.equal(await retryOnce('ok', async () => 1n, async () => { n++; return 'done'; }, quiet), 'done');
assert.equal(n, 1, 'jangan panggil ulang kalau sukses');

// 2. Gagal & state TETAP → diulang, percobaan kedua dipakai.
n = 0;
const out = await retryOnce('retry', async () => 7n, async () => {
  n++;
  if (n === 1) throw new Error('RPC hiccup');
  return 'sukses kedua';
}, quiet);
assert.equal(out, 'sukses kedua');
assert.equal(n, 2, 'state tak berubah → harus dicoba sekali lagi');

// 3. Gagal & state BERUBAH → JANGAN diulang (dana sudah bergerak).
n = 0;
let probe = 5n;
await assert.rejects(
  retryOnce('moved', async () => probe, async () => { n++; probe = 4n; throw new Error('gagal setelah tx mendarat'); }, quiet),
  /gagal setelah tx mendarat/,
);
assert.equal(n, 1, 'dana sudah bergerak → HARAM diulang');

// 4. Probe tak bisa dibaca (RPC mati) → dianggap sudah bergerak, jangan diulang.
n = 0;
await assert.rejects(
  retryOnce('unknown', async () => { throw new Error('RPC down'); }, async () => { n++; throw new Error('boom'); }, quiet),
  /boom/,
);
assert.equal(n, 1, 'ragu = berhenti, bukan coba lagi');

// 5. Probe mengembalikan -1n (v4 tak didukung) → sama: jangan diulang.
n = 0;
await assert.rejects(
  retryOnce('minus', async () => -1n, async () => { n++; throw new Error('boom'); }, quiet),
  /boom/,
);
assert.equal(n, 1, '-1n = tak bisa dipastikan → jangan ulang');

// 6. Percobaan kedua gagal juga → error KEDUA yang dilaporkan, tak menggantung.
n = 0;
await assert.rejects(
  retryOnce('twice', async () => 1n, async () => { n++; throw new Error(`gagal-${n}`); }, quiet),
  /gagal-2/,
);
assert.equal(n, 2);

console.log('OK — retry: hanya mengulang saat on-chain benar-benar tak berubah.');
