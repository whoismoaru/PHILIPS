/**
 * One runnable check on which Solana pools PHILIPS will offer, and on the difference
 * between "no DLMM pool" and "no such token".
 *
 * Those two look identical on a card and mean opposite things. Filtering to DLMM throws
 * away real, live pools -- DAMM v2, Raydium CLMM, pumpswap -- and a token served only by
 * those is a healthy token we cannot LP in yet, not a dead address. Two BSC tokens asked
 * about in September were exactly that case, and answering "not found" would have been
 * wrong.
 *
 * The fixture is a real DexScreener payload for a Solana token, trimmed to the fields the
 * classifier reads: 11 pairs, 6 of them DLMM. Running against a recording rather than the
 * live API keeps this offline and stable, because a live token's pools change hourly.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyPairs } from '../src/solana/pools.js';
import { SOL, USDC } from '../src/solana/bases.js';

const MINT = '91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump';
const fixture = JSON.parse(readFileSync('scripts/fixtures/dexscreener-solana-token.json', 'utf8')) as {
  pairs: any[];
};

// --- The ordinary case: DLMM kept, everything else counted and set aside ---
const c = classifyPairs(MINT, fixture.pairs);
assert.equal(fixture.pairs.length, 11, 'the fixture changed shape');
assert.equal(c.inScope.length, 6, 'the DLMM pools were not all kept');
assert.equal(c.otherVenueCount, 5, 'DAMM v2, Raydium and pumpswap must be counted, not silently dropped');
assert.equal(c.offBaseCount, 0, 'every DLMM pool in the fixture is SOL-quoted');
assert.ok(c.facts, 'token facts went missing');
assert.equal(c.facts.mint, MINT, 'the mint must survive untouched');
assert.ok(c.facts.symbol && c.facts.symbol !== '?', 'the symbol was not read');
assert.ok((c.facts.marketCapUsd ?? 0) > 0, 'market cap was not read');
for (const { base } of c.inScope) {
  assert.ok(base.mint === SOL.mint || base.mint === USDC.mint, `a pool outside SOL/USDC was kept: ${base.mint}`);
}

// --- The distinction that matters: pairs exist, but none of them are DLMM ---
const noDlmm = classifyPairs(
  MINT,
  fixture.pairs.filter((p) => !(p.labels ?? []).includes('DLMM')),
);
assert.equal(noDlmm.inScope.length, 0, 'there should be nothing to offer here');
assert.ok(noDlmm.facts, 'a token with only DAMM/Raydium pools is still a REAL token; facts must survive');
assert.equal(noDlmm.otherVenueCount, 5, 'the card needs this count to say "no DLMM pool" rather than "not found"');

// --- Genuinely nothing: the only case that may report the token as absent ---
const nothing = classifyPairs(MINT, []);
assert.equal(nothing.facts, null, 'no pairs at all means no token facts');
assert.equal(nothing.otherVenueCount, 0);

// Pairs on other chains must not leak in: the same mint string could appear anywhere.
const wrongChain = classifyPairs(MINT, fixture.pairs.map((p) => ({ ...p, chainId: 'bsc' })));
assert.equal(wrongChain.facts, null, 'non-Solana pairs were accepted');

// --- Out-of-scope base: counted, never offered ---
const dlmmPair = fixture.pairs.find((p) => (p.labels ?? []).includes('DLMM'));
const offBase = classifyPairs(MINT, [
  { ...dlmmPair, quoteToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' } },
]);
assert.equal(offBase.inScope.length, 0, 'a BONK-quoted pool must not be offered');
assert.equal(offBase.offBaseCount, 1, 'it must still be counted, so the card can explain itself');

// --- The base58 hazard, in the form that costs the most ---
// A lowercased USDC mint must NOT match the base. If it did, the pool would be offered
// with the wrong deposit asset.
const lowerUsdc = classifyPairs(MINT, [
  { ...dlmmPair, quoteToken: { address: USDC.mint.toLowerCase(), symbol: 'USDC' } },
]);
assert.equal(lowerUsdc.inScope.length, 0, 'a lowercased USDC mint was accepted as the USDC base');
assert.equal(lowerUsdc.offBaseCount, 1);

// --- One APR formula. Three copies once drifted apart and printed 373,403,973%. ---
const src = readFileSync('src/solana/pools.ts', 'utf8');
assert.ok(src.includes("import { aprOf } from '../explore.js'"), 'pools.ts must reuse aprOf');
assert.ok(!/\*\s*365\)?\s*\/\s*(tvl|liquidityUsd)/.test(src), 'the APR formula was re-derived inside pools.ts');

console.log('smoke-solpools OK');
