/**
 * PHILIPS shares one GMGN key, and one IP, with REXONA. Every avoidable call here is
 * quota taken from REXONA's alert lane: measured over 3-6 Sep 2026, 45% of REXONA's
 * rate-limit hits landed within 90s of activity on this bot, against 5% expected by
 * chance. So this guards the three things that keep the call count down.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bustGmgnCache, gmgnExtra } from '../src/gmgn.js';

const src = readFileSync('src/gmgn.ts', 'utf8');

// 1. The two heavy endpoints must go out back to back, never as a burst.
assert.ok(
  !/Promise\.all\(\[\s*run\(\['token', 'security'/.test(src),
  'security+holders fire together again — that is a burst against a leaky bucket',
);

// 2. The TTL has to stay long. A one-minute TTL re-fetched figures that move over hours.
const ttl = src.match(/const TTL = ([^;]+);/);
assert.ok(ttl, 'TTL is gone');
assert.ok(/15 \* 60_000|\b900_000\b/.test(ttl[1]), `TTL fell back to something short: ${ttl[1]}`);

// 3. A long TTL is only safe while Refresh can clear it.
assert.match(
  readFileSync('src/screening.ts', 'utf8'),
  /bustGmgnCache\(/,
  'the screening cache buster no longer clears GMGN, so Refresh would redraw stale figures',
);
assert.equal(typeof bustGmgnCache, 'function');

// Without a key the module must stay silent rather than spending a call to find out.
const before = process.env.GMGN_API_KEY;
delete process.env.GMGN_API_KEY;
const empty = await gmgnExtra('0x0000000000000000000000000000000000000001', 'bsc');
if (before !== undefined) process.env.GMGN_API_KEY = before;
assert.equal(empty.top10Pct, null, 'answered without an API key');

console.log('ok — GMGN calls stay sequential, cached 15 min, and Refresh still busts them');
