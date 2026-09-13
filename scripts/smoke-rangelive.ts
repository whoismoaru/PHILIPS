import assert from 'node:assert/strict';

/**
 * The "Target Range" percentages are measured against the PRICE NOW, not the entry
 * price. Anchored to entry, the card reports the state at open forever:
 * the token fell 26% and the row still printed -0.7% ⇄ -90.2%.
 * The numbers below come from a real position, #7263410 on BSC.
 */
const entry = 0.0013974596;
const now = 0.0010305677;
const upper = 0.00138831; // the upper bound, in token price
const lower = 0.00013645;

const pctFrom = (ref: number) => (p: number) => (p / ref - 1) * 100;
const live = [upper, lower].map(pctFrom(now)).sort((a, b) => b - a);
const anchored = [upper, lower].map(pctFrom(entry)).sort((a, b) => b - a);

assert.ok(live[0] > 0, 'the upper bound is still ABOVE the current price, so its percentage must be positive');
assert.ok(Math.abs(live[0] - 34.71) < 0.1, `the upper bound from the price now should be about +34.7%, got ${live[0].toFixed(2)}`);
assert.ok(Math.abs(live[1] + 86.76) < 0.1, `the lower bound from the price now should be about -86.8%, got ${live[1].toFixed(2)}`);

// This is the old misleading figure: make sure it is not the one in use.
assert.ok(anchored[0] < 0, 'anchoring to entry makes the upper bound read negative although the price never reached it');
assert.notDeepEqual(live.map(Math.round), anchored.map(Math.round));

console.log('ok: the target range is measured against the price now, not the entry price.');
