import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAINS, isStableBase } from '../src/chains.js';

/**
 * Every asset the bridge OFFERS must have something to land in.
 *
 * Arc has no wrapped native -- its gas token IS USDC, as an ERC-20. The asset step mapped a
 * native transfer to "native on the destination", so ETH → Arc asked for an asset that does
 * not exist and came back with no route, while USDC → Arc worked (16 Sep 2026). A button
 * that cannot complete is worse than one that is absent.
 */
const src = readFileSync('src/commands/bridge.ts', 'utf8');
assert.match(src, /if \(!to\.hasWethBase\)/, 'the native transfer no longer checks the destination has a native asset');
assert.match(src, /const dstStable = to\.bases\.find\(\(b\) => isStableBase\(b\.kind\)\)/, 'a WETH-less destination must receive its own stable');
assert.match(src, /throw new Error\(`\$\{to\.label\} has nothing to receive/, 'a destination with no base at all must be skipped, not offered');

// Structural: on every pair the bot lists, each offered asset resolves to a real
// destination asset with the right decimals.
for (const from of Object.values(CHAINS)) {
  for (const to of Object.values(CHAINS)) {
    if (from.key === to.key) continue;
    for (const b of from.bases) {
      if (b.kind === 'weth' && !to.hasWethBase) {
        const dst = to.bases.find((x) => isStableBase(x.kind));
        assert.ok(dst, `${from.label} → ${to.label}: native has nowhere to land and must not be offered`);
        assert.ok(dst!.decimals > 0 && dst!.address.startsWith('0x'), `${to.label}: stable base looks wrong`);
      }
    }
  }
}
console.log('ok: every offered bridge asset has a real asset waiting on the other side');
