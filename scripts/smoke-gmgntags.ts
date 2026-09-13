/**
 * One runnable check for GMGN holder-tag matching.
 *
 * Tags come from real Robinhood payloads read on 8 Sep 2026: `dev_team`,
 * `creator`, `bundler`, `sniper`, `sandwich_bot`. The old code looked for a bare
 * `dev`, found nothing, and reported 0% — which the card renders as a confident
 * "no developer holdings" for a token whose developer is tagged and holding.
 */
import assert from 'node:assert';
import { tagStats } from '../src/gmgn.js';

const s = tagStats([
  { tags: ['dev_team'], amount_percentage: 0.08 },
  { tags: ['creator'], amount_percentage: 0.02 },
  { maker_token_tags: ['bundler'], amount_percentage: 0.0667 },
  { tags: ['sniper'], amount_percentage: 0.01 },
  { tags: ['sniper', 'fresh_wallet'], amount_percentage: 0.01 },
  { tags: ['sandwich_bot'], amount_percentage: 0.05 },
  { tags: ['top_holder'], amount_percentage: 0.3 },
]);

assert.ok(Math.abs(s.devPct! - 10) < 1e-6, `dev_team 8% + creator 2% = 10%, dapat ${s.devPct}`);
assert.equal(s.sniperCount, 2);
assert.ok(Math.abs(s.bundlerPct! - 6.67) < 1e-6);
assert.ok(Math.abs(s.insidersPct! - 5) < 1e-6, 'sandwich_bot ikut dihitung sebagai insider');

// maker_token_tags is read just like tags: the bundler above only appears there.
assert.ok(s.bundlerPct! > 0, 'maker_token_tags must not be ignored');

// An empty list means nothing is tagged, not a crash.
const blank = tagStats([]);
assert.equal(blank.devPct, 0);
assert.equal(blank.sniperCount, 0);

console.log('smoke-gmgntags OK');
