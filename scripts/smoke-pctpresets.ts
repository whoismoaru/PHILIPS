import assert from 'node:assert/strict';
import * as p from '../src/pctPresets.js';

// Valid numbers are tidied rather than rejected: sorted ascending, no duplicates.
assert.deepEqual(p.sanitize([50, 10, 25, 10], 'buy'), [10, 25, 50]);
assert.deepEqual(p.sanitize([100], 'buy'), [100]);

// Nonsense is rejected: a 0% or 150% percentage button means nothing.
assert.equal(p.sanitize([], 'buy'), null);
assert.equal(p.sanitize([0, 50], 'buy'), null);
assert.equal(p.sanitize([150], 'buy'), null);
assert.equal(p.sanitize([12.5], 'buy'), null, 'a fraction is not a valid percentage button');
assert.deepEqual(p.sanitize([10, 20, 30, 40, 50], 'buy'), [10, 20, 30, 40, 50], 'five values must be accepted');
assert.deepEqual(p.sanitize([10, 25, 50, 75, 90, 100], 'buy'), [10, 25, 50, 75, 90, 100], 'six values are still valid');
assert.equal(p.sanitize([1, 2, 3, 4, 5, 6, 7], 'buy'), null, 'seven values exceed the limit');
// The buttons wrap, so a long list no longer gets cut off on a narrow screen.
assert.deepEqual(p.chunkButtons([1, 2, 3, 4, 5, 6]), [[1, 2, 3, 4], [5, 6]]);
assert.deepEqual(p.chunkButtons([1, 2]), [[1, 2]]);

// A 100% withdrawal closes the position, and that is a different path: close, not decrease.
assert.equal(p.sanitize([25, 100], 'stop'), null);
assert.deepEqual(p.sanitize([25, 99], 'stop'), [25, 99]);

// Every reasonable way of typing it is accepted.
assert.deepEqual(p.parseList('10 25 50 90'), [10, 25, 50, 90]);
assert.deepEqual(p.parseList('10,25 , 50'), [10, 25, 50]);
assert.deepEqual(p.parseList('10/25/50'), [10, 25, 50]);
assert.deepEqual(p.parseList('10% 25%'), [10, 25]);
assert.equal(p.parseList(''), null);
assert.equal(p.parseList('abc'), null);

// A leg count is not a percentage: at least 2, since one leg is not a ladder, and at most 69.
assert.equal(p.sanitize([1, 8], 'legs'), null, 'one leg is not a ladder');
assert.equal(p.sanitize([70], 'legs'), null, "above the open flow's limit");
assert.deepEqual(p.sanitize([8, 2, 69], 'legs'), [2, 8, 69]);
assert.equal(p.unitFor('legs'), 'legs');
assert.equal(p.unitFor('buy'), '%');
assert.deepEqual(p.boundsFor('stop'), { min: 1, max: 99 }, 'a 100% withdrawal is a close, a different path');

// Each flow's defaults stay valid under its own rules.
for (const f of ['buy', 'sell', 'add', 'stop', 'bridge', 'legs'] as p.PctFlow[]) {
  assert.ok(p.sanitize(p.defaultsFor(f), f), `the ${f} defaults fail their own validation`);
}

console.log('OK — pctPresets: validasi & parsing persen di /settings.');
