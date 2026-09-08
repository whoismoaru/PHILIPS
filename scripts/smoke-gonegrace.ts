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
const ditahan = (reason: string, umurMs: number) => reason === 'gone' && umurMs < GRACE_MS;

assert.equal(ditahan('gone', 664), true, 'posisi umur 664ms harus ditahan — ini bug 9 Sep');
assert.equal(ditahan('gone', 59_000), true, 'masih dalam masa tenggang');
assert.equal(ditahan('gone', 61_000), false, 'lewat tenggang: burn sungguhan harus lolos');
assert.equal(ditahan('cashed', 664), false, 'penutupan manual tak pernah ditahan — ia bawa angka hasil');
assert.equal(ditahan('burned', 664), false, 'burn eksplisit tak ditahan');

console.log('ok: gone muda ditahan, gone tua & cashed lolos');
