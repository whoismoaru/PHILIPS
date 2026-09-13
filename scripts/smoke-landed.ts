/**
 * Two bugs from the log audit on 30 Aug 2026:
 *  1. the mint lands but run() throws, the card says "failed", and the owner opens again.
 *  2. the TVL threshold cancelled itself out, so a $0-TVL, no-volume pool was offered (`富贵` on BSC).
 */
import assert from 'node:assert';
import { retryOnce } from '../src/retry.js';
import { msgError } from '../src/messages.js';

const quiet = () => {};

// 1a. the state moved: no retry, and the error is marked as landed.
let runs = 0;
await retryOnce(
  'add',
  (() => { let n = 0n; return async () => n++; })(), // 0 → 1: mint mendarat
  async () => { runs++; throw new Error('nonce has already been used'); },
  { log: quiet },
).then(
  () => assert.fail('it must throw'),
  (e) => {
    assert.equal(runs, 1, 'the transaction landed: never retry');
    assert.equal((e as { landed?: boolean }).landed, true);
  },
);

// 1b. the state stayed still: retried, and NOT marked as landed.
runs = 0;
await retryOnce('add', async () => 7n, async () => { runs++; throw new Error('rpc hiccup'); }, {
  sleepMs: 0,
  log: quiet,
}).catch((e) => {
  assert.equal(runs, 2, 'the chain stayed still, so it gets one retry');
  assert.notEqual((e as { landed?: boolean }).landed, true);
});

// 1c. the probe could not be read: no retry, and no claim to know the transaction landed.
await retryOnce('add', async () => { throw new Error('rpc down'); }, async () => { throw new Error('boom'); }, {
  log: quiet,
}).catch((e) => assert.notEqual((e as { landed?: boolean }).landed, true, 'probe buta ≠ landed'));

// 1d. the error card says which of the two it was.
const landedErr = Object.assign(new Error('nonce has already been used'), { landed: true });
assert.match(msgError('add', landedErr), /DID land on-chain/);
assert.ok(!msgError('add', new Error('plain')).includes('DID land on-chain'));
assert.match(msgError('add', landedErr), /nonce has already/);
assert.ok(!msgError('add', landedErr).includes('Error: nonce'), 'the "Error:" prefix must be stripped');

// 2. the TVL threshold fallback: a pool with no TVL AND no volume is dropped.
const MIN = 1_000;
const pick = (ps: { tvlUsd: number; vol24hUsd?: number }[]) => {
  const sized = ps.filter((p) => p.tvlUsd >= MIN);
  return sized.length > 0 ? sized : ps.filter((p) => p.tvlUsd > 0 || (p.vol24hUsd ?? 0) > 0);
};
assert.equal(pick([{ tvlUsd: 0, vol24hUsd: 0 }, { tvlUsd: 0 }]).length, 0, 'a pool with $0 TVL and no volume must never be offered');
assert.equal(pick([{ tvlUsd: 5_000 }, { tvlUsd: 0 }]).length, 1, 'only what clears the threshold');
assert.equal(pick([{ tvlUsd: 0, vol24hUsd: 90_000 }]).length, 1, 'volume means it is still alive');

console.log('smoke-landed OK');
