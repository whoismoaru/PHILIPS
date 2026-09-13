import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLORER_HEADERS } from '../src/chain.js';

/**
 * Robinhood's Blockscout REFUSES requests without a User-Agent, with a 403.
 *
 * That read as "the indexer is struggling", and /positions would raise
 * an incomplete-list warning, while the indexer was perfectly healthy and the request was
 * refused. Proven on 29 Aug 2026: same URL, one header added, 403 became 200.
 */
assert.ok(EXPLORER_HEADERS['user-agent'], 'the explorer headers carry no User-Agent');
assert.ok(/Mozilla/.test(EXPLORER_HEADERS['user-agent']), 'the User-Agent does not read as a browser');

// Every explorer caller MUST send those headers: one that forgets is enough to
// returns a 403 on that one path alone, which is the hardest kind to trace.
// Matched on the IMPORT plus any use, not one exact spelling: uniswapV4 spreads the
// headers into a wider object ({ ...EXPLORER_HEADERS, 'content-type': ... }), which the
// old literal check read as "no header at all".
for (const file of ['src/uniswapV4.ts', 'src/index.ts', 'src/screening.ts']) {
  const s = readFileSync(join(process.cwd(), file), 'utf8');
  assert.ok(/EXPLORER_HEADERS/.test(s), `${file} does not import the explorer headers`);
  assert.ok(/headers: (\{ \.\.\.)?EXPLORER_HEADERS/.test(s), `${file} calls the explorer without the headers`);
}

console.log('ok: every caller sends a User-Agent, so the 403 does not come back.');
