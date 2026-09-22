/**
 * One runnable check on reading Meteora DLMM positions, and on the two things that were
 * actually got wrong while building it.
 *
 * 1. The bin ids sit at 7912/7916 inside an 8120-byte PositionV2. They were located
 *    empirically, so a silent shift here would put every price range in the wrong place
 *    while still looking plausible. The decode is pinned against a hand-built account.
 *
 * 2. Token decimals must be READ, never assumed. A first cross-check against DexScreener
 *    failed on three pools out of four because the test script assumed 6 decimals; UBI has
 *    9, and that single assumption misprices such a pool by 1000x. The code now carries
 *    nullable prices and a mintDecimals() read, and that is what is asserted below.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePosition } from '../src/solana/positions.js';
import { encodeBase58 } from '../src/solana/addr.js';

const OFF_LB_PAIR = 8, OFF_OWNER = 40, OFF_LOWER = 7912, OFF_UPPER = 7916, LEN = 8120;

function account(lower: number, upper: number): Uint8Array {
  const b = new Uint8Array(LEN);
  for (let i = 0; i < 32; i++) b[OFF_LB_PAIR + i] = i + 1;
  for (let i = 0; i < 32; i++) b[OFF_OWNER + i] = 200 - i;
  const v = new DataView(b.buffer);
  v.setInt32(OFF_LOWER, lower, true);
  v.setInt32(OFF_UPPER, upper, true);
  return b;
}

const d = decodePosition(account(-1234, -1165));
assert.ok(d, 'a well-formed PositionV2 must decode');
assert.equal(d.lowerBinId, -1234, 'lower bin id read from the wrong offset');
assert.equal(d.upperBinId, -1165, 'upper bin id read from the wrong offset');
// Bin ids are SIGNED. Reading them unsigned turns every sub-1.0 price range into a
// number near 4.29 billion, which is most of Meteora.
assert.ok(d.lowerBinId < 0, 'bin ids must be read as signed i32');
assert.equal(d.pool, encodeBase58(account(0, 0).subarray(OFF_LB_PAIR, OFF_LB_PAIR + 32)));
assert.notEqual(d.pool, d.owner, 'pool and owner are different fields');

// An account that is not a PositionV2 must be refused, not reported as a flat position.
assert.equal(decodePosition(account(10, 9)), null, 'an inverted range is not a position');
assert.equal(decodePosition(account(0, 70)), null, 'a position spans at most 70 bins');
assert.equal(decodePosition(new Uint8Array(100)), null, 'a short account is not a position');

const src = readFileSync('src/solana/positions.ts', 'utf8');
// The owner filter goes in verbatim. Base58 is case-sensitive, and a folded key matches
// nothing, which reads to the owner as "you have no positions".
assert.ok(!/owner[^\n]*toLowerCase/.test(src), 'the owner filter must never be case-folded');
assert.ok(/memcmp[\s\S]{0,80}offset: OFF_OWNER/.test(src), 'positions are found by the owner field');
// Decimals read, and prices that go null rather than wrong when they cannot be.
assert.ok(/getAccountInfo[\s\S]{0,120}jsonParsed/.test(src), 'decimals must be read from the mint');
assert.ok(!/tokenDecimals = 6|decT = 6/.test(src), 'decimals must never be assumed');
assert.equal((src.match(/scale === null \? null :/g) ?? []).length, 2, 'both bounds drop out when decimals are unknown');
// The upper BOUND is the top of the last bin, not its floor.
assert.ok(/upperBinId \+ 1/.test(src), 'the upper bound takes +1');

const idx = readFileSync('src/index.ts', 'utf8');
assert.ok(/const solRows = await solanaRows\(\)/.test(idx), '/positions must ask for Solana rows');
// The early return fires before rows are built. Leaving Solana out of it made a
// Solana-only wallet read "no positions" while holding several.
assert.ok(/v4\.length === 0 && solRows\.length === 0/.test(idx), 'the empty check must count Solana rows');
assert.ok(/\.concat\(solRows\)/.test(idx), 'Solana rows must join the same array');
assert.ok(/isSolAddress\(wallet\)/.test(idx), 'the configured wallet must be validated as base58');

console.log('smoke-solpositions OK');
