/**
 * One runnable check that a position row reads the same on every chain.
 *
 * Two things made BSC look like a different bot:
 *
 * 1. The ladder badge was appended to the PAIR STRING, which posPair() then splits on '/'
 *    and rebuilds as TOKEN/BASE. Whether the badge survived depended on which side the
 *    token sorted to: on BSC (token second) it ended up inside the name, "天才  ◣×3/USDT";
 *    on Robinhood (token first) it was silently dropped and a 3-leg ladder read as one
 *    position.
 * 2. Invested precision was keyed on the base TOKEN's decimals, so the same dollar amount
 *    printed "$197.30" on Robinhood (USDG, 6 dec) and "$398.7457" on BSC (USDT, 18 dec).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as m from '../src/messages.js';

const row = (pair: string, baseSymbol: string, legCount: number | null) =>
  m
    .msgPositionsList({
      dryRun: false, activeCount: 1, totalInvestLabel: null, totalPnlUsd: 1, outOfRange: 0,
      rows: [{ id: '1', pair, investLabel: 'x', age: '1m', pnlUsd: 1, pnlPct: 1, inRange: true, protocol: 'V4', chain: 'C', baseSymbol, legCount }],
    } as any)
    .split('\n')
    .find((l) => l.includes('#1'))!
    .replace(/<[^>]+>/g, '');

// The badge survives BOTH currency orders, and lands outside the pair either way.
for (const [label, pair, base] of [
  ['token first', 'VYNEX / USDG', 'USDG'],
  ['token second', 'TOKEN / USDT', 'USDT'],
] as const) {
  const r = row(pair, base, 3);
  assert.ok(r.includes('◣×3'), `${label}: the ladder badge vanished`);
  // The badge must come AFTER the whole pair, separated by a space: never "◣×3/USDT"
  // (inside the name) and never glued to a symbol.
  assert.ok(!r.includes('◣×3/'), `${label}: the badge sits inside the pair name: ${r}`);
  assert.match(r, /\$\S+\/\S+ ◣×3 \| #1/u, `${label}: row shape changed: ${r}`);
}
// A single position carries no badge.
for (const n of [1, null]) assert.ok(!row('PONS / USDT', 'USDT', n).includes('◣'), `legCount ${n} drew a badge`);

// Precision follows meaning, not the token's decimals.
const src = readFileSync('src/index.ts', 'utf8');
const fn = src.slice(src.indexOf('function investedLabel'), src.indexOf('function investedLabel') + 700);
assert.ok(!/decimals >= 18/.test(fn), 'invested precision is keyed on token decimals again: 18-dec stables print 4 places');
assert.ok(/toFixed\(stable \? 2 : 4\)/.test(fn), 'dollars must print 2 places and a volatile base 4');
assert.ok(!/investedLabel\([^)]*,\s*(dec|sumInvest >= 1 \? 18 : 6)\)/.test(src), 'a caller still passes decimals into investedLabel');

// And the collapse must hand the badge over as DATA. Rendering is only half the fix: the
// bug was born in collapseLadderRows writing the badge into the pair string.
const collapse = src.slice(src.indexOf('function collapseLadderRows'), src.indexOf('function collapseLadderRows') + 1800);
assert.ok(/base\.legCount = legs\.length;/.test(collapse), 'the ladder collapse no longer records the leg count');
assert.ok(!/base\.pair = /.test(collapse), 'the ladder collapse writes into the pair string again: the badge will land inside the token name');

console.log('ok: the row reads the same on every chain, ladder or not');
