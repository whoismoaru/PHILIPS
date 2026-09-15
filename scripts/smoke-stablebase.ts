import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAINS, isStableBase } from '../src/chains.js';
import { stableOf, v4BaseDecimals, v4BaseSymbol } from '../src/uniswapV4.js';

/**
 * A v4 close is measured as the BASE balance delta. The reader used to test for USDG by
 * name, so on BSC -- where the stable is USDT -- it fell through to the native BNB
 * balance, which does not move when USDT arrives. Every BSC v4 close then reported
 * "Received —", was journalled with no result, and produced no PnL card (#1279330,
 * 15 Sep 2026).
 */
const src = readFileSync('src/index.ts', 'utf8');
const reader = src.slice(src.indexOf('const readBase = async (): Promise<bigint | null>'), src.indexOf('const beforeWei = await readBase();'));
// Comments are stripped first: this file EXPLAINS the old test, and the guard must read
// the code rather than the prose describing it.
const code = reader.replace(/\/\/.*$/gm, '');
assert.ok(!/if \(trackedBase === 'usdg'\)/.test(code), 'the base reader is keyed on USDG again');
assert.match(reader, /isStableBase\(trackedBase\)/, 'the base reader must accept any stable base');
assert.match(reader, /stableOf\(cc\)/, "the reader must use the chain's own stable address");

// The v4 card's base detection had the same hole.
const card = src.slice(src.indexOf('let mcPool: number | null = null;'), src.indexOf('let mcPool: number | null = null;') + 900);
assert.ok(!/cc\.usdgAddress && a\.toLowerCase\(\)/.test(card), 'the v4 card still identifies the stable by USDG alone');

// Every chain resolves a stable base, with ITS OWN decimals -- USDG is 6, BSC's USDT is 18.
for (const cc of Object.values(CHAINS)) {
  const st = stableOf(cc);
  if (!st) continue;
  assert.ok(isStableBase(cc.bases.find((b) => b.address === st.addr)!.kind), `${cc.label}: stableOf returned a non-stable base`);
  assert.equal(v4BaseDecimals(cc, 'USDG'), st.decimals, `${cc.label}: v4 base decimals disagree with the chain's stable`);
  assert.equal(v4BaseSymbol(cc, 'USDG'), st.symbol, `${cc.label}: v4 base symbol disagree with the chain's stable`);
  console.log(`${cc.label.padEnd(10)} stable ${st.symbol.padEnd(5)} ${st.decimals} decimals  ${st.addr}`);
}
console.log('ok: a v4 close measures the chain\'s own stable, whichever it is');
