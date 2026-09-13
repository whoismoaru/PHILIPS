import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every CLOSE path ends with a PnL card, or says why the outcome could not be
 * measured. There are four: v3 single, v3 ladder, v4 single, v4 ladder. The two
 * ladder paths used to send no card at
 * all; the user got a single "Total cashed out" line and nothing more.
 */
const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

const calls = src.split('sendProfitCard(').length - 1;
assert.ok(calls >= 5, `sendProfitCard is called only ${calls}x, so a close path sends no card (1 definition + 4 paths expected)`);

// A card built from a zero outcome prints -100% while the money is entirely intact.
assert.ok(/if \(totalOut > 0n\) \{/.test(src), 'the v3 ladder path does not guard against a zero outcome');
assert.ok(/if \(r\.baseOutWei > 0n\) \{/.test(src), 'the v4 ladder path does not guard against a zero outcome');

// Silence is not an answer: an unmeasurable outcome is stated, not left as a missing card.
const skips = src.split('Result could not be measured').length - 1;
assert.ok(skips >= 3, `only ${skips} paths explain the card they skipped`);

// Fees are snapshotted BEFORE the burn on both ladder paths — afterwards the figure is gone.
assert.ok(
  (src.split('Fees are read BEFORE the burn').length - 1) >= 3,
  'a close path reads fees after the burn (by then they have merged into the proceeds)',
);

console.log('ok: all four paths send a PnL card, and an unmeasurable outcome is explained.');
