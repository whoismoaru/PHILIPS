import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isGoneErr } from '../src/core.js';
import { retryOnce } from '../src/retry.js';

/**
 * Closing a position that is ALREADY gone must be quiet.
 *
 * On 15 Sep 2026 a seven-leg v4 ladder produced fourteen "TRANSACTION ERROR" cards in
 * Telegram: v4 reverts with NOT_MINTED, isGoneErr only knew v3's 'invalid token id', so
 * each leg raised a generic error AND the retry fired against a revert that can never
 * change. Two bugs, one symptom.
 */
// 1) Both protocols' wording is recognised.
assert.ok(isGoneErr(new Error('execution reverted: "NOT_MINTED"')), 'v4 NOT_MINTED is not read as gone');
assert.ok(isGoneErr(new Error('invalid token id')), 'v3 wording regressed');
assert.ok(!isGoneErr(new Error('insufficient funds for gas')), 'a real failure must not be swallowed as gone');

// 2) A gone position is NOT retried: the revert is deterministic, so a second attempt is
//    only a second error card.
let calls = 0;
await assert.rejects(
  retryOnce('close v4', async () => 0n, async () => {
    calls++;
    throw new Error('execution reverted: "NOT_MINTED"');
  }, { log: () => {} }),
  /NOT_MINTED/,
);
assert.equal(calls, 1, `a gone position was attempted ${calls} times; once is the maximum`);

// 3) A genuinely transient failure IS still retried -- this guard must not disable retries.
let t = 0;
const out = await retryOnce('close v4', async () => 0n, async () => {
  if (++t === 1) throw new Error('server response 503');
  return 'ok';
}, { log: () => {} });
assert.equal(out, 'ok');
assert.equal(t, 2, 'a transient failure is no longer retried');

// 4) The close handler answers "already closed" rather than a revert card.
const src = readFileSync('src/index.ts', 'utf8');
const close = src.slice(src.indexOf("await recoverStrayWeth(cc, 'close v4')"), src.indexOf("await recoverStrayWeth(cc, 'close v4')") + 700);
assert.match(close, /isGoneErr\(e\)/, 'the close handler no longer recognises a gone position');
assert.match(close, /msgAlreadyClosed/, 'a gone position must be reported as already closed');

console.log('ok: closing a vanished position is reported once, calmly, and never retried');
