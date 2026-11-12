/**
 * One runnable check that price and market cap come from a pair quoted in one of our bases.
 *
 * DexScreener prices a pair off its raw vault balances. PUSSY/NVDA (Raydium CPMM, 12 Nov 2026)
 * still held 75.78 NVDA of unclaimed creator fees, so the deepest PUSSY pair read $771K while
 * every SOL pool, Jupiter and GeckoTerminal agreed on ~$656K. The bot took the deepest pair and
 * showed PUSSY 17% high. Figures below are the live payload of that afternoon, trimmed.
 */
import assert from 'node:assert/strict';
import { pricedPair } from '../src/explore.js';
import { classifyPairs } from '../src/solana/pools.js';

const PUSSY = 'FZxHLUGiGchY5uvvoeqh1EKiXTrGdN67WUBhUc1fLoat';
const NVDA = 'NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv';
const WSOL = 'So11111111111111111111111111111111111111112';
const pair = (quote: string, liq: number, mcap: number, base = PUSSY) => ({
  chainId: 'solana', baseToken: { address: base, symbol: 'PUSSY' }, quoteToken: { address: quote },
  liquidity: { usd: liq }, marketCap: mcap, priceUsd: String(mcap / 1e9),
});
const pussy = [pair(NVDA, 171933, 771393), pair(WSOL, 34004, 649322), pair(WSOL, 130, 646035), pair(WSOL, 0, 865401)];

// The fee-inflated NVDA pair is deeper, but a SOL pair with real depth wins.
assert.equal(classifyPairs(PUSSY, pussy).facts?.marketCapUsd, 649322, 'PUSSY took the fee-inflated NVDA pair');
// The SOL pair must carry 5% of the deepest pair: a dust pool's stale price never wins.
assert.equal(pricedPair([pair(NVDA, 171933, 771393), pair(WSOL, 130, 999999)], PUSSY, [WSOL])?.marketCap, 771393, 'a dust SOL pair set the price');
// No pair in our bases: the deepest base pair, as before.
assert.equal(pricedPair([pair(NVDA, 500, 1), pair(NVDA, 900, 2)], PUSSY, [WSOL])?.marketCap, 2);
// A pair quoted in the token describes the other token and is never picked.
assert.equal(pricedPair([pair(PUSSY, 99999, 5, NVDA)], PUSSY, [WSOL]), undefined, 'a quote-side pair priced the token');
// EVM addresses fold case; base58 does not.
const W = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const tok = '0xAbC0000000000000000000000000000000000001';
assert.equal(pricedPair([pair('0x9999', 900, 1, tok.toLowerCase()), pair(W.toLowerCase(), 100, 2, tok)], tok, [W])?.marketCap, 2, 'EVM case folding broke');
assert.equal(pricedPair([pair(WSOL, 100, 1, PUSSY.toLowerCase())], PUSSY, [WSOL]), undefined, 'base58 was case-folded');

console.log('smoke-pricedpair OK');
