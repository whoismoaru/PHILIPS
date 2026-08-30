/**
 * Dua bug dari audit log 30 Agu 2026:
 *  1. mint mendarat tapi run() melempar → kartu bilang "gagal", pemilik buka lagi.
 *  2. ambang TVL membatalkan dirinya sendiri → pool $0+v0 ditawarkan (BSC `富贵`).
 */
import assert from 'node:assert';
import { retryOnce } from '../src/retry.js';
import { msgError } from '../src/messages.js';

const quiet = () => {};

// 1a. state bergerak → tidak diulang, error ditandai landed.
let runs = 0;
await retryOnce(
  'add',
  (() => { let n = 0n; return async () => n++; })(), // 0 → 1: mint mendarat
  async () => { runs++; throw new Error('nonce has already been used'); },
  { log: quiet },
).then(
  () => assert.fail('harus melempar'),
  (e) => {
    assert.equal(runs, 1, 'tx mendarat: JANGAN diulang');
    assert.equal((e as { landed?: boolean }).landed, true);
  },
);

// 1b. state diam → diulang, TIDAK ditandai landed.
runs = 0;
await retryOnce('add', async () => 7n, async () => { runs++; throw new Error('rpc hiccup'); }, {
  sleepMs: 0,
  log: quiet,
}).catch((e) => {
  assert.equal(runs, 2, 'on-chain diam: harus diulang sekali');
  assert.notEqual((e as { landed?: boolean }).landed, true);
});

// 1c. probe tak terbaca → tak diulang, tapi JANGAN mengaku tahu tx mendarat.
await retryOnce('add', async () => { throw new Error('rpc down'); }, async () => { throw new Error('boom'); }, {
  log: quiet,
}).catch((e) => assert.notEqual((e as { landed?: boolean }).landed, true, 'probe buta ≠ landed'));

// 1d. kartu error menyuarakan perbedaannya.
const landedErr = Object.assign(new Error('nonce has already been used'), { landed: true });
assert.match(msgError('add', landedErr), /DID land on-chain/);
assert.ok(!msgError('add', new Error('plain')).includes('DID land on-chain'));
assert.match(msgError('add', landedErr), /nonce has already/);
assert.ok(!msgError('add', landedErr).includes('Error: nonce'), 'awalan "Error:" harus dibuang');

// 2. fallback ambang TVL: pool tanpa TVL DAN tanpa volume dibuang.
const MIN = 1_000;
const pick = (ps: { tvlUsd: number; vol24hUsd?: number }[]) => {
  const sized = ps.filter((p) => p.tvlUsd >= MIN);
  return sized.length > 0 ? sized : ps.filter((p) => p.tvlUsd > 0 || (p.vol24hUsd ?? 0) > 0);
};
assert.equal(pick([{ tvlUsd: 0, vol24hUsd: 0 }, { tvlUsd: 0 }]).length, 0, 'pool $0+v0 tak boleh ditawarkan');
assert.equal(pick([{ tvlUsd: 5_000 }, { tvlUsd: 0 }]).length, 1, 'yang lolos ambang saja');
assert.equal(pick([{ tvlUsd: 0, vol24hUsd: 90_000 }]).length, 1, 'ada volume = masih hidup');

console.log('smoke-landed OK');
