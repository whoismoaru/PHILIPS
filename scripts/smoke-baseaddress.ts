import assert from 'node:assert/strict';
import { CHAINS } from '../src/chains.js';
import * as explore from '../src/explore.js';

/**
 * A base asset is decided by its ADDRESS, never by the name it prints.
 *
 * On Arc, 0x8e98a62a… is called "UpSideDownCat" and reports the SYMBOL "USDC" with 18
 * decimals, against the real USDC's 6 at 0x3600…0000. Matching on the symbol made the
 * impersonator read as a base, so its pool looked like base/base and was dropped from /add
 * -- the right outcome reached by accident, which would not survive the next impersonator
 * that picks a symbol the bot does not hold.
 */
const arc = CHAINS['arc'];
if (arc) {
  const FAKE = '0x8e98a62a995a50eca9979bfa016f91bf36a8f9d9';
  const REAL = '0x3600000000000000000000000000000000000000';
  assert.equal(explore.baseKindOf('USDC', FAKE, arc), null, 'a token that merely calls itself USDC is being treated as the base');
  assert.equal(explore.baseKindOf('USDC', REAL, arc), 'usdc', "the chain's own USDC is no longer recognised");
  // The impersonator must now be discoverable as an ordinary token, decided on its merits.
  const pools = await explore.poolsForToken(arc, FAKE).catch(() => []);
  assert.ok(pools.length > 0, 'the impersonator has pools but none are offered');
  for (const p of pools) assert.equal(p.base, 'usdc', 'every offered pool must have the REAL USDC as its base side');
}

// Native ETH arrives as currency 0x0 in v4 and has no address to match; it must still
// resolve on a chain that has an ETH base, and must not on one that does not.
const base = CHAINS['base'];
if (base) assert.equal(explore.baseKindOf('ETH', '0x0000000000000000000000000000000000000000', base), 'weth', 'native ETH stopped resolving');
if (arc) assert.equal(explore.baseKindOf('ETH', '0x0000000000000000000000000000000000000000', arc), null, 'Arc has no ETH base and must not claim one');

// With NO address at all the symbol is all there is, and that fallback stays.
if (arc) assert.equal(explore.baseKindOf('USDC', null, arc), 'usdc', 'the symbol fallback is gone');

console.log('ok: bases are matched by address; a token that borrows the name is just a token');
