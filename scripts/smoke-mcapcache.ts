/**
 * One runnable check that a FAILED market-cap lookup is not reused as an answer.
 *
 * entryMcap is read once, when a position opens, and stored for that position's whole
 * life: no market cap, no Range row, ever. Successes and failures shared one 30 s cache,
 * so a miss while the audit card was being read came straight back out of cache when the
 * owner confirmed moments later -- the lookup was never retried. BSC #1311649 (18 Sep
 * 2026) opened with entryMcap null while the same token priced at $388K a minute later.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/explore.ts', 'utf8');

const miss = Number(src.match(/const MCAP_MISS_TTL_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ''));
const hit = Number(src.match(/const MCAP_TTL_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ''));
assert.ok(Number.isFinite(miss), 'the failed-lookup TTL is gone');
assert.ok(Number.isFinite(hit), 'the market-cap TTL is gone');
assert.ok(miss < hit, `a failure is cached as long as a success (${miss} vs ${hit})`);
assert.ok(miss > 0, 'a zero miss TTL re-fetches on every card refresh for a token DexScreener does not carry');
// Short enough that a human reading the audit card outlives it.
assert.ok(miss <= 5_000, `${miss}ms is long enough for a confirm to land inside the window again`);

// The read must actually branch on which kind of entry it found.
assert.match(
  src,
  /hit\.v === null \? MCAP_MISS_TTL_MS : MCAP_TTL_MS/,
  'the cache no longer distinguishes a failed lookup from a good one',
);

// And the open paths must still be the ones that persist it, so the value they get matters.
const idx = readFileSync('src/index.ts', 'utf8');
assert.ok(
  (idx.match(/entryMcap: entryMcap \?\? undefined/g) ?? []).length >= 2,
  'the v4 open paths no longer store entryMcap',
);

console.log('ok: a failed market-cap lookup expires quickly and is retried before it is stored');
