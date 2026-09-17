/**
 * One runnable check that a v4 close never runs against the wrong chain.
 *
 * `closev4go:<id>` carries only a token id. The chain came from v4ChainOf, which looks in
 * v4store and then asks every v4 chain whether THIS wallet owns that id -- and the result
 * was then defaulted to the active chain with `?? getChain()`. Once a position is closed
 * it leaves the store and no chain owns it, so tapping a stale card re-ran the close
 * against whatever chain happened to be active.
 *
 * Seen on 17 Sep 2026: an Arc ladder (#157580/#157581) closed at 18:35, tapped again at
 * 19:35, and the close ran against Robinhood, where those ids belong to other people. The
 * ownership check refused it. Had the same number been one of ours on the active chain,
 * the bot would have closed an unrelated position instead -- the check only proves the
 * NFT is ours, never that it is the one on the card.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/index.ts', 'utf8');

// No caller may paper over "no chain owns this" with the active chain.
const fallbacks = [...src.matchAll(/v4ChainOf\([^)]*\)\)? *\?\? *getChain\(\)/g)];
assert.deepEqual(
  fallbacks.map((m) => m[0]),
  [],
  'v4ChainOf falls back to the active chain again: a stale card can close a different chain\'s position',
);

// The close path must stop instead, and let go of its lock so the id is not wedged.
const exec = src.slice(src.indexOf('async function execCloseV4'), src.indexOf('async function execCloseV4') + 2500);
assert.ok(/const cc = await v4ChainOf\(tokenId\);/.test(exec), 'execCloseV4 no longer resolves the chain from the position');
assert.ok(/if \(!cc\) \{/.test(exec), 'execCloseV4 does not handle an unresolvable chain');
assert.ok(/closingInFlight\.delete\(key\)/.test(exec), 'the in-flight lock is not released when the chain cannot be resolved');
assert.ok(/msgAlreadyClosed\(tokenId\)/.test(exec), 'the owner is not told the position is already closed');

// v4ChainOf itself must keep searching every v4 chain -- that search is what makes
// "undefined" trustworthy enough to stop on.
const chainOf = src.slice(src.indexOf('async function v4ChainOf'), src.indexOf('bot.action(/^posv4:'));
assert.ok(/v4Supported/.test(chainOf) && /wallet\.address\.toLowerCase\(\)/.test(chainOf), 'v4ChainOf no longer verifies ownership across chains');

console.log('ok: a v4 close runs on the position\'s own chain, or not at all');
