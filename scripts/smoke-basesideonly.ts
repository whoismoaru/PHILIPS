import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as msg from '../src/messages.js';

/**
 * PHILIPS deposits the BASE side and nothing else: the chain's native asset or its
 * stablecoin. The token side ("sell the rip") was removed on 16 Sep 2026 -- it only ever
 * worked on v3, and every card, alert, sweep and PnL path had to branch on which side was
 * deposited. That branching is exactly where this month's bugs came from.
 */
const files = ['src/index.ts', 'src/messages.ts', 'src/uniswap.ts', 'src/monitor.ts', 'src/store.ts']
  .concat(readdirSync('src/commands').map((f) => `src/commands/${f}`));

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // No new flow may offer it, and no new branch may test for it.
  assert.ok(!/strat:token|planAddTokenSide|msgStrategyStep/.test(code), `${f}: the token-side flow is back`);
  // store.ts still READS the old value, and one line in index.ts maps it away for old
  // records. Everything else must be free of the branch.
  if (f !== 'src/store.ts' && f !== 'src/index.ts')
    assert.ok(!/side === 'token'|strategy === 'token'/.test(code), `${f}: still branches on the token side`);
}
const idx = readFileSync('src/index.ts', 'utf8').replace(/\/\/.*$/gm, '');
assert.equal((idx.match(/side === 'token'/g) ?? []).length, 1, 'index.ts should keep exactly one compatibility check');

// The wizard goes pool → range → amount → confirm: no strategy screen in between.
assert.match(idx, /flow\.strategy = 'base';[\s\S]{0,200}renderRangeStep/, 'picking a pool must go straight to the range step');

// Every card says the same thing about the side.
const list = msg.msgPositionsList({
  dryRun: false, activeCount: 1, totalInvestLabel: null, totalPnlUsd: 0, outOfRange: 0,
  rows: [{ id: '1', pair: 'GG/USDG', investLabel: '$1.00 USDG', age: '1m', pnlUsd: 0, pnlPct: 0, inRange: true, baseSymbol: 'USDG' }],
}).replace(/<[^>]+>/g, '');
assert.match(list, /USDG Single Side \(buy the dip\)/, 'the list card no longer names the base side');
assert.ok(!/sell the rip/i.test(list), 'the list card still offers the token side');

console.log('ok: one strategy only — the base side, on every chain and both protocols');
