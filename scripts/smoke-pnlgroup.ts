/**
 * /pnl scores POSITIONS, not legs.
 *
 * An 8-leg ladder used to read as 8 trades, each carrying about an eighth of the
 * PnL — small enough to slip under the dust threshold and vanish from the W/L
 * count. This pins the new behaviour down and, just as importantly, proves NET
 * did not move: the money is the same money either way.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The journal is read from `cwd`, so this test moves into a temp directory. The
// .env comes along so config still loads, and the real data/journal.jsonl is
// never touched.
const dir = mkdtempSync(join(tmpdir(), 'pnlgroup-'));
mkdirSync(join(dir, 'data'));
copyFileSync(join(process.cwd(), '.env'), join(dir, '.env'));
process.chdir(dir);
process.env.WALLET_SECRET ??= '0x' + '11'.repeat(32);

const journal = await import('../src/journal.js');
const me = journal.currentWallet();
assert.ok(me, 'this test needs an active wallet');

const t0 = Date.now() - 3600_000;
/** One 8-leg ladder: +$0.05 per leg (under the dust threshold), +$0.40 in total. */
const legs = Array.from({ length: 8 }, (_, i) => ({
  tokenId: `${100 + i}`, symbol: 'LADDER', ca: '0xaaa', chain: 'bsc', baseKind: 'usdt' as const,
  openedAt: t0, closedAt: t0 + i, initialWethWei: '1000', resultEthWei: '1050',
  pnlEth: 0.05, pnlPct: 5, reason: 'cashed' as const, wallet: me, usdRate: 1,
}));
/** A single, clearly winning trade to compare against. */
const solo = {
  tokenId: '900', symbol: 'SOLO', ca: '0xbbb', chain: 'bsc', baseKind: 'usdt' as const,
  openedAt: t0, closedAt: t0 + 9_000, initialWethWei: '1000', resultEthWei: '2000',
  pnlEth: 5, pnlPct: 500, reason: 'cashed' as const, wallet: me, usdRate: 1,
};
writeFileSync(join(dir, 'data', 'journal.jsonl'), [...legs, solo].map((e) => JSON.stringify(e)).join('\n') + '\n');

const s = journal.statsFor(0, undefined, () => 1);
const b = s.books[0]!;

assert.equal(s.count, 9, 'count stays the number of ENTRIES');
assert.equal(s.known, 2, `a ladder plus a solo makes 2 scored trades, got ${s.known}`);
assert.equal(b.wins, 2, `the ladder wins as a single unit (+$0.40 > $0.10), got ${b.wins} wins`);
assert.equal(b.flats, 0, 'no leg may fall through as dust once the group is formed');
assert.ok(Math.abs(b.net - 5.4) < 1e-9, `net should be 8x0.05 + 5 = 5.4, got ${b.net}`);

/** An explicit groupId beats the time heuristic: two ladders closing in the same
 *  second stay separate. */
const pairs = [
  { ...legs[0], tokenId: 'g1a', groupId: 'G1', closedAt: t0 }, { ...legs[0], tokenId: 'g1b', groupId: 'G1', closedAt: t0 + 1 },
  { ...legs[0], tokenId: 'g2a', groupId: 'G2', closedAt: t0 + 2 }, { ...legs[0], tokenId: 'g2b', groupId: 'G2', closedAt: t0 + 3 },
];
writeFileSync(join(dir, 'data', 'journal.jsonl'), pairs.map((e) => JSON.stringify(e)).join('\n') + '\n');
const g = journal.statsFor(0, undefined, () => 1);
assert.equal(g.known + g.books[0]!.flats, 2, 'groupId must separate two ladders that close in the same second');

/**
 * A measured result with no recorded cost means the PnL is UNKNOWABLE, not a
 * profit the size of the whole cash-out. Three entries like this once added $662
 * of profit that never existed.
 */
const hantu = {
  tokenId: '777', symbol: 'GHOST', ca: '0xccc', chain: 'bsc', baseKind: 'usdt' as const,
  openedAt: t0, closedAt: t0 + 50_000, initialWethWei: '0', resultEthWei: '5000',
  pnlEth: 5, pnlPct: 0, reason: 'cashed' as const, wallet: me, usdRate: 1,
};
writeFileSync(join(dir, 'data', 'journal.jsonl'), [solo, hantu].map((e) => JSON.stringify(e)).join('\n') + '\n');
const h = journal.statsFor(0, undefined, () => 1);
assert.equal(h.noCapital, 1, 'an entry with no capital is counted separately');
assert.equal(h.known, 1, 'only the solo position may be scored');
assert.ok(Math.abs(h.books[0]!.net - 5) < 1e-9, `net should be 5, the solo alone, got ${h.books[0]!.net}: the ghost was counted`);

/** 'recovery' has zero cost by design, and that is fine: the cost was already
 *  booked on the original close. */
const sweep = { ...hantu, tokenId: '778', reason: 'recovery' as const };
writeFileSync(join(dir, 'data', 'journal.jsonl'), [solo, sweep].map((e) => JSON.stringify(e)).join('\n') + '\n');
const rc = journal.statsFor(0, undefined, () => 1);
assert.equal(rc.noCapital, 0, 'a sweep must not be filtered out');
assert.equal(rc.recovered, 1, 'a sweep still has to be credited');
assert.ok(Math.abs(rc.books[0]!.net - 10) < 1e-9, 'a sweep adds to the net');

console.log('ok: scored per position, net intact, groupId beats the timestamp guess, zero-capital entries skipped');
