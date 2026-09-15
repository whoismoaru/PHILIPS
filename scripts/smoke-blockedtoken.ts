import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A token that REFUSES to be transferred out of the pool must not trap the base side.
 *
 * Measured on Robinhood, 15 Sep 2026: STANDARD (0x88ad8Ddf…) lets a 0-wei transfer through
 * and reverts on any real amount. TAKE_PAIR moves BOTH sides at once, so closing reverted
 * with WrappedError(token, transfer, …) and $350 of USDG sat behind a few cents of
 * untransferable dust. The escape hatch forfeits that side and takes the base.
 */
const src = readFileSync('src/uniswapV4.ts', 'utf8');

// The detector keys on the SELECTOR, not on a message: such tokens revert with custom
// errors that carry no text at all.
assert.match(src, /0x90bfb865/, 'the WrappedError selector is gone');
assert.match(src, /a9059cbb/, 'the ERC20.transfer selector is gone');

const fn = src.slice(src.indexOf('export async function closePositionV4'), src.indexOf('export async function closeLadderV4'));
// It is a FALLBACK: the ordinary path is tried and simulated first.
assert.ok(fn.indexOf('TAKE_PAIR') < fn.indexOf('CLEAR_OR_TAKE'), 'the forfeit path must come after the ordinary take');
// It never fires on a plain failure, and never without a known base.
assert.match(fn, /if \(!base \|\| !isTransferBlocked\(e\)\) throw e;/, 'the escape hatch is no longer gated');
// The forfeited side is ALWAYS the non-base one. Forfeiting the deposited asset would be
// the bot throwing away the money it was told to protect.
assert.match(fn, /const otherCur = baseCur === pk\.currency0 \? pk\.currency1 : pk\.currency0;/, 'the forfeited side is not pinned to the non-base currency');
assert.match(fn, /CLEAR_OR_TAKE\)[\s\S]{0,400}otherCur/, 'CLEAR_OR_TAKE must be applied to the token side');
assert.match(fn, /TAKE\)[\s\S]{0,500}baseCur, cc\.wallet\.address/, 'TAKE must send the base to the wallet');
// The second route is simulated too; a revert there reports the ORIGINAL error.
assert.match(fn, /staticCall\(alt, deadline[\s\S]{0,120}throw e;/, 'the fallback is sent without being simulated');
// And the close says what it gave up.
assert.match(fn, /forfeited = await tokenSymbol\(otherCur, cc\)/, 'a forfeited side must be named in the result');

console.log('ok: a transfer-blocking token loses its dust, never the base side, and only after both routes are simulated');
