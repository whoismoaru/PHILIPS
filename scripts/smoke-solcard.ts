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
  pools: [{ pair: '$TIGRINO/$SOL', binStep: '125', fee: '1%', tvl: '$149.2K', vol: '$2.01M', feeTvl: '>1000%' }],
  otherVenueCount: 5,
  offBaseCount: 0,
  chainReadSkipped: false,
};

// --- The address survives verbatim: case is value on base58 ---
const card = msg.msgSolToken(base);
assert.ok(card.includes(base.ca), 'the mint must appear exactly as given, not normalised');

// --- Escaping happens once, and only once ---
const amp = msg.msgSolToken({ ...base, symbol: 'AT&T', name: 'Ampersand & Co' });
assert.ok(amp.includes('AT&amp;T'), 'the symbol was not escaped');
assert.ok(!amp.includes('&amp;amp;'), 'double-escaped: bold() and esc() were both applied');

// --- The facts read as a tree, and no emoji may sit inside a <pre> if one is ever added ---
assert.ok(/\u251C price: \$0.002787/.test(card), 'the fact rows are not drawn as a tree');
assert.ok(/\u2514 mcap: /.test(card), 'the LAST fact row must close the tree');
for (const block of [...card.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1])) {
  assert.ok(
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(block),
    'an emoji sits inside <pre> and will break the column alignment',
  );
}

// --- The pool line reports 24h fee over TVL, which is NOT an annualised APR ---
assert.ok(card.includes('24h Fee/TVL'), 'the pool line must name what the ratio measures');
assert.ok(!/APR/.test(card), 'a 24h ratio must never be labelled APR: the two differ by 365x');
const idxSrc = readFileSync('src/index.ts', 'utf8');
assert.ok(/aprPct \/ 365/.test(idxSrc), 'the 24h ratio must come from aprPct, not a second copy of the formula');
// Through the shared label, so the >1000% cap is applied in exactly one place.
assert.ok(/feeTvl: aprLabel\(/.test(idxSrc), 'the ratio must go through the shared cap');

// --- Only the top pools are listed, and the card says when it trimmed ---
const many = msg.msgSolToken({ ...base, morePools: 4 });
assert.ok(/4 deeper pools not shown/.test(many), 'a trimmed pool list must say so');
assert.ok(!/not shown/.test(card), 'nothing was trimmed, so do not claim it was');

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

// The owner asked for the screening note gone, permanently. Kept as an assert so it does
// not drift back in with a later edit.
assert.ok(!/safety screening/.test(card), 'the screening note was removed on request');

// --- Off-base pools are explained, never silently dropped ---
const offBase = msg.msgSolToken({ ...base, offBaseCount: 2 });
assert.ok(/not offered/.test(offBase), 'pools outside SOL/USDC must be accounted for on the card');

// --- House rules: HTML only, and one blank line after the header ---
assert.ok(!/(\*\*|__|\[.+\]\(.+\))/.test(card), 'Markdown leaked into an HTML card');
assert.ok(!card.includes('\n\n\n'), 'a double blank line renders as a visible gap');

// --- The buttons: three pools, a refresh that carries the mint, and a way back ---
assert.ok(/Markup\.button\.url\(`\$\{i \+ 1\}/.test(idxSrc), 'each shown pool must get its own button');
assert.ok(/solref:\$\{mint\}/.test(idxSrc), 'refresh must carry the mint it is refreshing');
// Callback data is capped at 64 bytes by Telegram; 'solref:' plus a 44-character mint is 51.
assert.ok('solref:'.length + 44 <= 64, 'the refresh callback would exceed 64 bytes');
assert.ok(/positions_back/.test(idxSrc.slice(idxSrc.indexOf('async function startSolToken'), idxSrc.indexOf('bot.action(/^solref'))),
  'the card must offer a way back to the menu');
// The keyboard is spread over html. Passed alone it replaces parse_mode and the card
// renders its own tags as literal text.
assert.ok(/\{ \.\.\.html, \.\.\.Markup\.inlineKeyboard\(kb\) \}/.test(idxSrc), 'the keyboard must not drop parse_mode');

console.log('smoke-solcard OK');
