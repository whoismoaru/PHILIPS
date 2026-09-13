import assert from 'node:assert/strict';
import { retryOnce } from '../src/retry.js';

const quiet = { sleepMs: 0, log: () => {} };

let n = 0;
assert.equal(await retryOnce('ok', async () => 1n, async () => { n++; return 'done'; }, quiet), 'done');
assert.equal(n, 1, 'never call again after a success');

n = 0;
const out = await retryOnce('retry', async () => 7n, async () => {
  n++;
  if (n === 1) throw new Error('RPC hiccup');
  return 'sukses kedua';
}, quiet);
assert.equal(out, 'sukses kedua');
assert.equal(n, 2, 'the state did not move, so it gets one more attempt');

n = 0;
let probe = 5n;
await assert.rejects(
  retryOnce('moved', async () => probe, async () => { n++; probe = 4n; throw new Error('failed after the transaction landed'); }, quiet),
  /failed after the transaction landed/,
);
assert.equal(n, 1, 'the money already moved, so a retry is forbidden');

n = 0;
await assert.rejects(
  retryOnce('unknown', async () => { throw new Error('RPC down'); }, async () => { n++; throw new Error('boom'); }, quiet),
  /boom/,
);
assert.equal(n, 1, 'in doubt, stop rather than retry');

n = 0;
await assert.rejects(
  retryOnce('minus', async () => -1n, async () => { n++; throw new Error('boom'); }, quiet),
  /boom/,
);
assert.equal(n, 1, '-1n means unknowable, so do not retry');

n = 0;
await assert.rejects(
  retryOnce('twice', async () => 1n, async () => { n++; throw new Error(`failed-${n}`); }, quiet),
  /failed-2/,
);
assert.equal(n, 2);

console.log('ok: a retry happens only when the chain really did not move.');
