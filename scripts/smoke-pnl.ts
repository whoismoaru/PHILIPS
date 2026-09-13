import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { baseDecimalsOf } from '../src/chains.js';

assert.equal(baseDecimalsOf('robinhood', 'usdg'), 6, 'USDG Robinhood 6 desimal');
assert.equal(baseDecimalsOf('robinhood', 'weth'), 18);
assert.equal(baseDecimalsOf('bsc', 'usdt'), 18, 'USDT on BSC has 18 decimals, NOT 6');
assert.equal(baseDecimalsOf('bsc', 'weth'), 18);
assert.equal(baseDecimalsOf(undefined, 'weth'), 18, 'no chain means the primary chain');

const raw = ethers.parseUnits('48', baseDecimalsOf('bsc', 'usdt'));
const shown = Number(ethers.formatUnits(raw, baseDecimalsOf('bsc', 'usdt')));
assert.equal(shown, 48, `48 USDT BSC terbaca ${shown}`);
const wrong = Number(ethers.formatUnits(raw, 6));
assert.ok(wrong > 4.7e13, 'proves that using 6 really does shift it by 10^12');

const gained = (before: bigint, after: bigint) => (after > before ? after - before : 0n);
assert.equal(gained(ethers.parseEther('0.12'), ethers.parseEther('0.25')), ethers.parseEther('0.13'),
  'the older 0.12 WETH must not be counted');
assert.equal(gained(0n, ethers.parseEther('0.13')), ethers.parseEther('0.13'));
assert.equal(gained(ethers.parseEther('0.5'), ethers.parseEther('0.4')), 0n,
  'a shrinking balance yields 0, never a negative figure');

console.log('ok: decimals follow the chain, and the outcome is the balance increase.');

import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const lolos = new Set([
  
  'const valF = Number(ethers.formatUnits(d.valueBaseWei, d.baseDecimals));',
  '`${msg.cleanUnits(d.valueBaseWei, d.baseDecimals)} ${d.baseSymbol}` +',
]);
const offenders = src.split('\n').filter((l) => {
  const t = l.trim();
  if (!/formatUnits\(|formatEther\(/.test(t)) return false;
  if (!/\.valueBaseWei/.test(t)) return false;
  if (/feesBaseWei/.test(t)) return false;
  return !lolos.has(t);
});
assert.deepEqual(offenders, [],
  'a position valued without feesBaseWei, which understates PnL:\n' + offenders.join('\n'));

for (const [name, start, end] of [
  // This block moved when /portfolio was parallelised on 30 Aug 2026: v3 valuation now runs as
  // promises started early rather than a chain of awaits.
  ['renderStatus/LP', 'const v3ValsP = mapLimit(store.active()', 'const [network, chains]'],
  ['cmdPositions/v3', 'const v3rows = await mapLimit(active', 'const rows: PosRow[] = v3rows'],
] as const) {
  const i = src.indexOf(start);
  assert.ok(i > 0, `block ${name} not found: this guard is stale, update its marker`);
  const block = src.slice(i, src.indexOf(end, i));
  const offenders = block.split('\n').filter((l) => {
    const t = l.trim();
    if (t.startsWith('//')) return false;
    return /\bethUsd\b/.test(t) || /,\s*cc\)/.test(t) || /\bcc\.(wethAddress|nativeSymbol|label)\b/.test(t);
  });
  assert.deepEqual(offenders, [],
    `${name}: uses the primary chain inside a cross-chain loop; use ctxOf(rec)/rcc instead:\n` + offenders.join('\n'));
}

console.log('smoke-pnl: LULUS');
