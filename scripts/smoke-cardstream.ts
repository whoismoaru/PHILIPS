/**
 * Position cards used to build EVERY card first (await mapLimit) and only then send
 * them one by one, leaving the screen dead for the whole final build wave.
 * mapLimitStream sends card #1 the moment #1 is ready, with the order preserved.
 */
import assert from 'node:assert';
import { mapLimitStream, POS_CARD_CONCURRENCY } from '../src/core.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Results follow the input order, not the order they finish in.
const ms = [50, 5, 30, 1, 20];
const t0 = Date.now();
const ps = mapLimitStream(ms, 2, async (d, i) => {
  await sleep(d);
  return i;
});
const firstDone = await Promise.race([ps[0].then(() => 'first'), ps[1].then(() => 'second')]);
assert.equal(firstDone, 'second', 'the fast item finishes first, so they really run in parallel');
assert.deepEqual(await Promise.all(ps), [0, 1, 2, 3, 4], 'the result order must hold');

// The concurrency limit is respected.
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

// A failing item must not take the process down with an unhandled rejection before it
// is awaited, and must not block the others.
const mixed = mapLimitStream([1, 2, 3], 2, async (n) => {
  if (n === 2) throw new Error('card failed to read');
  return n;
});
await sleep(30); // give the rejection time to sit idle: this is where Node used to die
assert.equal(await mixed[0], 1);
await assert.rejects(() => mixed[1], /card failed/);
assert.equal(await mixed[2], 3);

assert.equal(mapLimitStream([], 3, async () => 1).length, 0, 'an empty list starts no workers');
assert.ok(POS_CARD_CONCURRENCY >= 6, 'the card concurrency was raised from 3');
assert.ok(Date.now() - t0 < 2000);
console.log('smoke-cardstream OK');
