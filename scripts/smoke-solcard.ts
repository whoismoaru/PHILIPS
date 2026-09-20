/**
 * One runnable check on the Solana token card.
 *
 * Three things this card must never get wrong, each of which has bitten a card in this bot
 * before. Dynamic text must be escaped exactly once, because bold(esc(x)) once turned AT&T
 * into "AT&amp;amp;T". No emoji may sit inside a <pre> block, because their cell width is
 * not one character and the column alignment collapses. And an unconfigured feature has to
 * say it is unconfigured rather than print '?', which reads as "the data is unavailable"
 * and sends the owner looking for the wrong problem.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as msg from '../src/messages.js';

const base = {
  symbol: 'TIGRINO',
  name: 'Leopardus Tilcayo',
  ca: '91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump',
  rows: [['price', '$0.002787'], ['mcap', '$2.72M']] as Array<[string, string]>,
  pools: [{ baseSymbol: 'SOL', binStep: '125', fee: '1%', tvl: '$149.2K', vol: '$2.01M', apr: '>1000%' }],
  otherVenueCount: 5,
  offBaseCount: 0,
  chainReadSkipped: false,
  dryRun: true,
};

// --- The address survives verbatim: case is value on base58 ---
const card = msg.msgSolToken(base);
assert.ok(card.includes(base.ca), 'the mint must appear exactly as given, not normalised');

// --- Escaping happens once, and only once ---
const amp = msg.msgSolToken({ ...base, symbol: 'AT&T', name: 'Ampersand & Co' });
assert.ok(amp.includes('AT&amp;T'), 'the symbol was not escaped');
assert.ok(!amp.includes('&amp;amp;'), 'double-escaped: bold() and esc() were both applied');

// --- No emoji inside <pre>: it breaks monospace alignment ---
const pres = [...card.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
assert.ok(pres.length > 0, 'the data block is missing');
for (const block of pres) {
  assert.ok(
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(block),
    'an emoji sits inside <pre> and will break the column alignment',
  );
}

// --- The distinction: pools exist elsewhere, just not ours ---
const noDlmm = msg.msgSolToken({ ...base, pools: [], otherVenueCount: 5 });
assert.ok(noDlmm.includes('NO DLMM POOL'), 'a token with other venues must not read as absent');
assert.ok(!noDlmm.includes('NO POOL<'), 'the wrong branch was taken');
const nothing = msg.msgSolToken({ ...base, pools: [], otherVenueCount: 0 });
assert.ok(nothing.includes('NO POOL'), 'a token with no pools at all must say so');
assert.ok(!nothing.includes('NO DLMM POOL'), 'nothing to compare against, so do not blame DLMM');

// --- Unconfigured is not the same as unavailable ---
const noRpc = msg.msgSolToken({ ...base, chainReadSkipped: true });
assert.ok(noRpc.includes('SOLANA_RPC_URL'), 'the card must name what is missing, not print a bare ?');
assert.ok(!card.includes('SOLANA_RPC_URL'), 'the hint must not appear when the RPC IS configured');

// The safety note is not optional: with screening unwired, an absence of warnings must
// never be read as a clean bill of health.
assert.ok(card.includes('safety screening is not wired'), 'the card must say screening is absent');

// --- Off-base pools are explained, never silently dropped ---
const offBase = msg.msgSolToken({ ...base, offBaseCount: 2 });
assert.ok(/not offered/.test(offBase), 'pools outside SOL/USDC must be accounted for on the card');

// --- House rules: HTML only, and one blank line after the header ---
assert.ok(!/(\*\*|__|\[.+\]\(.+\))/.test(card), 'Markdown leaked into an HTML card');
assert.ok(!card.includes('\n\n\n'), 'a double blank line renders as a visible gap');

// --- The APR cap is never stacked with "about" ---
const src = readFileSync('src/index.ts', 'utf8');
assert.ok(src.includes('function aprApprox'), 'aprApprox went missing');
assert.ok(!/`~\$\{aprApprox/.test(src), 'a tilde was added on top of aprApprox');

console.log('smoke-solcard OK');
