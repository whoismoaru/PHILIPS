import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Value now" has to be what you could ACTUALLY get, not a notional market price.
 *
 * 28 Aug 2026: the ladder card read 287.70 USDG (+10.2%) and then the close
 * produced 246.69 (-5.5%). The token side was valued at the current pool price,
 * while selling it moves the price -- Relay rejected the route with
 * "Swap impact is too high: 31.06%". The gap was 41 USDG that never existed.
 */
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

assert.ok(/previewSwapOut\(otherAddr,/.test(idx), 'the token side is not priced from a real quote');
assert.ok(/const realWei = quotedOtherWei === null \? valWei : baseWei \+ quotedOtherWei;/.test(idx),
  'the ladder value ignores the quote result');
assert.ok(/exitNote/.test(idx), 'price impact is never mentioned to the user');
// A failed quote falls back to the pool price, but SAYS SO: quietly using the pool
// price is exactly the bug that was fixed.
assert.ok(/token side priced at pool rate, not a live quote/.test(idx), 'the pool-price fallback is not flagged');

// The base side is never sold, so price impact must not be charged against it.
assert.ok(/baseWei \+= x\.baseAmountWei/.test(idx), 'the base side is not separated from the token side');

const v4 = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');
for (const f of ['otherAmountWei', 'otherAddress', 'baseAmountWei']) {
  assert.ok(new RegExp(`${f}:`).test(v4), `V4Position does not expose ${f}`);
}

console.log('ok: the token side is priced from a real quote, and price impact is stated.');
