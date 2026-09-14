import assert from 'node:assert/strict';
import { msgV4Position } from '../src/messages.js';

/**
 * The card reached by tapping a row in /positions. It reports the POOL the position sits
 * in -- what it charges, holds, pays, and how far price must move before the position
 * starts filling. The range is deliberately NOT here: the list card carries it, pinned to
 * the entry values, and two cards printing it invited them to disagree.
 */
const base = {
  tokenId: '2715227', pair: 'USDG / IPO', feeLabel: '4.58%', valueLabel: '$1.00',
  rangeLabel: '+2.0% / -90.1%', inRange: false, tracked: true, baseSymbol: 'USDG',
  tokenSymbol: 'IPO', chain: 'Robinhood', fillsLabel: '≤2%', poolDepth: '452,3265 USDG',
} as any;

const card = msgV4Position({ ...base, pool: { tvl: '$37.5K', vol: '$222.9K', apr: '0%' } });
const plain = card.replace(/<[^>]+>/g, '');
console.log(plain);

const rows = plain.split('\n').filter((l) => /^[├└] /.test(l)).map((l) => l.slice(2).split(':')[0]);
assert.deepEqual(rows, ['Fee', 'TVL', 'APR', 'Fills', 'Volume', 'Liquidity'], `the rows changed: ${rows.join(', ')}`);
assert.match(plain, /└ Liquidity:/, 'Liquidity must close the block');
assert.ok(!/Range:/.test(plain), 'the range is back on this card; it belongs to the list');
assert.ok(plain.includes('🔴 $IPO/USDG | #2715227 (V4)'), 'the header no longer matches the row that opens it');

// A pool the index has not seen reads '—' on every pool row. NEVER '$0' or '0%': an
// unknown pool is not an idle one, and a fabricated zero is the failure this card can
// actually cause -- it would read as a pool that charges nothing and pays nothing.
const blind = msgV4Position({ ...base, pool: undefined }).replace(/<[^>]+>/g, '');
for (const row of ['TVL: —', 'APR: —', 'Volume: — (24h)'])
  assert.ok(blind.includes(row), `an unread pool must print ${row}`);
assert.ok(!/\$0\b/.test(blind) && !/: 0%/.test(blind), 'an unread pool is being reported as zero');

// An unreadable APR says so. 'hook fee' says WHY it is absent, which '?' cannot.
const noApr = msgV4Position({ ...base, pool: { tvl: '$37.5K', vol: '$222.9K', apr: '?' } }).replace(/<[^>]+>/g, '');
assert.ok(noApr.includes('APR: ?'), 'an unknown APR must stay unknown');
const hook = msgV4Position({ ...base, feeLabel: 'ts 200, dynamic', pool: { tvl: '$37.5K', vol: '$222.9K', apr: 'hook fee' } }).replace(/<[^>]+>/g, '');
assert.ok(hook.includes('APR: hook fee'), 'a hook-fee pool must name its reason');

console.log('ok: the v4 pool card keeps its six rows, and an unread pool never reads as a zero one');
