/**
 * One runnable check on the failure of 23 Sep 2026: every v4 add on Robinhood reverted
 * with data="0xd81b2f2e…6ab30c50" from 06:16 WIB onward.
 *
 * That is AllowanceExpired(1790118992) from Permit2. The Permit2 allowance for USDG was
 * still at its maximum AMOUNT but its EXPIRATION had passed, and ensurePermit2 destructured
 * only the amount out of the (amount, expiration, nonce) it is given. A 30-day approval
 * therefore stopped working on day 30 and nothing ever renewed it, because the amount was
 * still max and that was the only thing the branch looked at.
 *
 * Three things came out of it and all three are pinned here: renew on expiry, do not retry
 * a revert that cannot change, and say what the revert MEANS instead of printing hex.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainRevert } from '../src/revert.js';

// --- The exact payload from that day decodes to something an owner can act on ---
const real =
  'execution reverted (unknown custom error) (action="call", data="0xd81b2f2e000000000000000000000000000000000000000000000000000000006ab30c50", reason=null)';
const info = explainRevert(real);
assert.ok(info, 'the payload that broke every add must not read as "unknown custom error"');
assert.match(info.text, /Permit2 approval expired/, 'the reason must name Permit2');
// 0x6ab30c50 = 1790118992 = 2026-09-22T23:16:32Z, which is the expiry that was on-chain.
assert.match(info.text, /2026-09-22 23:16 UTC/, 'the expiry in the payload must be shown, not dropped');
assert.equal(info.deterministic, true, 'an expired approval fails the same way on every attempt');

// A payload we do not know stays unexplained rather than being guessed at.
assert.equal(explainRevert('data="0xdeadbeef00000000"'), null, 'an unknown selector must not be given a meaning');
assert.equal(explainRevert('some error with no payload at all'), null, 'no payload, no explanation');
// A selector with no argument must not crash or invent a date.
assert.ok(explainRevert('data="0x5bf6f916"')?.text.includes('deadline'), 'an argument-less revert must still decode');

// --- ensurePermit2 renews on EXPIRY, not only on amount ---
const v4 = readFileSync('src/uniswapV4.ts', 'utf8');
const fn = v4.slice(v4.indexOf('async function ensurePermit2'), v4.indexOf('async function ensurePermit2') + 2000);
assert.ok(/const \[amt, exp\]/.test(fn), 'the expiration must be read, not discarded');
assert.ok(/Number\(exp\) < now \+ 24 \* 3600/.test(fn), 'the approval must be renewed BEFORE it expires');
assert.ok(/BigInt\(amt\) < amount \|\|/.test(fn), 'the amount check must survive alongside the expiry check');
// Renewed EARLY on purpose: an approval valid at read time can be stale by the time the
// add lands, and the whole failure was a boundary being crossed between the two.
assert.ok(/now \+ 30 \* 24 \* 3600/.test(fn), 'the new approval must be dated from now, not from the old expiry');

// --- A deterministic revert is not retried ---
const retry = readFileSync('src/retry.ts', 'utf8');
assert.ok(/known\?\.deterministic/.test(retry), 'a revert that cannot change must not be retried');
const at = retry.indexOf('known?.deterministic');
assert.ok(at < retry.indexOf('const after = await probe()'), 'the bail-out must come before the second attempt');

// --- The card explains instead of printing hex ---
const messages = readFileSync('src/messages.ts', 'utf8');
const card = messages.slice(messages.indexOf('export function msgError'), messages.indexOf('export function msgError') + 1500);
assert.ok(/known\?\.text \?\?/.test(card), 'a decoded reason must win over the raw ethers string');
// The raw message still reaches the log: the card promises the details are there.
assert.ok(/console\.error\(`\[error:\$\{where\}\] \$\{raw/.test(card), 'the untruncated error must still be logged');

console.log('smoke-permit2 OK');
