/**
 * One runnable check on the DLMM pool decode.
 *
 * Bin step and base fee decide whether a pool is worth entering, and neither is available
 * off-chain any more: DexScreener does not carry them and Meteora's own API answers 404
 * for /pair/<address>. So they are read straight out of the LbPair account at fixed
 * offsets, and a wrong offset would not throw. It would print a confident, wrong fee.
 *
 * The fixture is the real first 152 bytes of pool 5TTHzu39..., captured from the chain. It
 * runs to 152 because the two mints sit at 88 and 120, and they are what prove the offsets:
 * a decode landing anywhere else could not produce a known pair.
 * Running against bytes rather than the network keeps this test offline and stable: the
 * pool's active bin moves every trade, a live read would not.
 *
 * The decode was validated independently when it was written: the price implied by
 * active_id came out 1.18% below the price DexScreener reported for the same pool, and one
 * bin is 1.25% wide at bin step 125. A price sitting just inside the active bin is exactly
 * the expected relationship, and a misread offset could not produce it.
 */
import assert from 'node:assert/strict';
import { decodeLbPair, binPrice } from '../src/solana/lbpair.js';

const FIXTURE_B64 =
  'IQsxYrVlsQ1AHywBsASIE0wdAADwSQIAA/X///0KAADoAwACAAAAAKZOAACmTgAA2P7//wAAAABTPK9qAAAAAAAAAAAAAAAA/n0AA9j+//99AAAAQB8AAHcWALT7FolZNSqfn3tZRp6Jd7Tfyj4gPZjMuRdR6YLfBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAE=';
const data = Uint8Array.from(Buffer.from(FIXTURE_B64, 'base64'));

const info = decodeLbPair(data);
assert.ok(info, 'a real LbPair account failed to decode');

// --- The values this pool actually carries ---
assert.equal(info.binStep, 125, 'bin step misread');
assert.equal(info.activeId, -296, 'active bin id misread');
// base_fee = base_factor(8000) * bin_step(125) * 10 * 10^0 / 1e9 = 0.01 -> 1.00%
assert.ok(Math.abs(info.baseFeePct - 1) < 1e-9, `base fee came out ${info.baseFeePct}%, expected 1%`);
assert.ok(Math.abs(info.binWidthPct - 1.25) < 1e-9, `bin width came out ${info.binWidthPct}%`);

// The mints, which are the strongest evidence the layout is right: DexScreener reports
// this pool as the 91ryaCo5...pump token against SOL, and both come back verbatim.
assert.equal(info.tokenX, '91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump', 'token_x misread');
assert.equal(info.tokenY, 'So11111111111111111111111111111111111111112', 'token_y is WSOL');

// --- The cross-check that proved the offsets, kept as a regression ---
// DexScreener reported 0.00002560 SOL for this pool. The token has 6 decimals, SOL has 9.
const implied = binPrice(info.binStep, info.activeId) * 10 ** (6 - 9);
const ratio = implied / 0.0000256;
assert.ok(
  ratio > 1 - info.binWidthPct / 100 && ratio <= 1.0001,
  `implied price is ${ratio} of the observed price; it must sit within one bin below it`,
);

// --- Junk must be rejected, not decoded into confident nonsense ---
assert.equal(decodeLbPair(new Uint8Array(10)), null, 'a too-short account decoded');
assert.equal(decodeLbPair(new Uint8Array(96)), null, 'an all-zero account decoded; bin step 0 is impossible');

// --- Bin maths ---
assert.equal(binPrice(125, 0), 1, 'bin 0 is price 1 by definition');
assert.ok(binPrice(125, 1) > binPrice(125, 0), 'price must rise with bin id');
// One bin step up is exactly one bin width.
assert.ok(Math.abs(binPrice(100, 1) - 1.01) < 1e-12, 'a 100 bin step is 1% per bin');

console.log('smoke-sollbpair OK');
