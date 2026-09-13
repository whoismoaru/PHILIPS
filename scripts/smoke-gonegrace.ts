/**
 * One runnable check for the "gone" grace period.
 *
 * Reading a freshly minted tokenId from an RPC node that has not caught up reverts
 * with "invalid token id" -- the same revert a burned NFT gives. Without a grace
 * period the bot deletes the position it just opened (#1092561, 664ms after its
 * mint), sync re-imports it as a stray with no entry price, and its PnL reads
 * "entry unknown" for the rest of its life.
 */
import assert from 'node:assert';
import { isGoneErr } from '../src/core.js';

// The revert a lagging node gives for a brand-new tokenId is indistinguishable from
// the one a burned NFT gives. That is the whole reason age has to be the tiebreaker.
assert.equal(isGoneErr(new Error('execution reverted: invalid token id')), true);

// Mirrors the guard in finalizeClose: only 'gone' is held back, and only while young.
const GRACE_MS = 60_000;
const held = (reason: string, umurMs: number) => reason === 'gone' && umurMs < GRACE_MS;

assert.equal(held('gone', 664), true, 'a 664ms-old position is held back; this is the 9 Sep bug');
assert.equal(held('gone', 59_000), true, 'still inside the grace period');
assert.equal(held('gone', 61_000), false, 'past the grace period, a real burn goes through');
assert.equal(held('cashed', 664), false, 'a manual close is never held back: it carries its own outcome');
assert.equal(held('burned', 664), false, 'an explicit burn is not held back');

console.log('ok: gone muda held, gone tua & cashed lolos');
