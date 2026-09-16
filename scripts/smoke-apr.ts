/**
 * One runnable check on the APR figure.
 *
 * A pool holding a fraction of a cent with one $12 trade through it reported
 * ~373,403,973% on the Choose Pool card. The guard was `tvl > 0`, and a TVL that rounds
 * to "$0" on the same line is still greater than zero, so the division stood. Two things
 * keep it honest: a denominator floor, and a cap on what is ever printed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aprOf } from '../src/explore.js';

// The reported case: dust TVL, one small trade, 1% fee.
assert.equal(aprOf(12, 10000, 0.0001), null, 'a dust-TVL pool still yields an APR number');
assert.equal(aprOf(12, 10000, 99), null, 'TVL below the floor must not be divided by');

// A real pool still reports: $10k TVL, $5k daily volume, 1% fee -> 0.3% * 365 / ... 
const real = aprOf(5000, 10000, 10000);
assert.ok(real !== null && real > 0 && real < 1000, `a normal pool lost its APR: ${real}`);
assert.equal(Math.round(real!), 183, 'the formula itself changed');

// No volume is unknown, not zero.
assert.equal(aprOf(0, 10000, 10000), null, 'a pool with no volume must report unknown, not 0%');

// One formula only: a second copy is how the capped and uncapped versions drifted apart.
const ex = readFileSync('src/explore.ts', 'utf8');
const inline = [...ex.matchAll(/\*\s*365\)\s*\/\s*tvl/g)].length;
assert.equal(inline, 1, `the APR formula is written ${inline} times; it must live in aprOf alone`);

// And the label caps rather than printing nine digits.
const idx = readFileSync('src/index.ts', 'utf8');
assert.ok(/APR_MAX_SHOWN/.test(idx), 'the APR display cap is gone');
assert.ok(
  !/p\.aprPct >= 100 \? Math\.round\(p\.aprPct\)/.test(idx),
  'the Choose Pool card formats APR itself again instead of going through aprLabel',
);

console.log('ok: APR needs a real denominator, and never prints an unbounded figure');
