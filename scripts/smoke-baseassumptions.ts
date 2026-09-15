import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CHAINS, isStableBase, baseDecimalsOf } from '../src/chains.js';
import { stableOf, v4BaseDecimals, v4BaseSymbol } from '../src/uniswapV4.js';

/**
 * The BASE ASSET is a property of the chain, never a constant.
 *
 * This class of bug has now bitten three times: a v4 close on BSC measured against the BNB
 * balance and reported no result (#1279330, 15 Sep 2026); the v4 card read the stable by
 * USDG's address alone; and the on-chain discovery fallback valued USDT reserves at the
 * native price. Each was one hardcoded assumption about which stable a chain uses.
 *
 * Two guards: the code may not reintroduce the pattern, and every chain must answer
 * consistently about its own base.
 */

// ── 1. No new "is it USDG?" tests in the money paths.
const files = ['src/index.ts', 'src/uniswapV4.ts', 'src/uniswap.ts', 'src/monitor.ts', 'src/explore.ts', 'src/krystal.ts', 'src/relay.ts']
  .concat(readdirSync('src/commands').map((f) => `src/commands/${f}`));
const offenders: string[] = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    // Comparing a BASE KIND to 'usdg' decides behaviour for one chain and silently gets
    // every other chain wrong. There are no exemptions: baseAssetOf() covers the cases
    // that used to be written out as a three-way map.
    if (/(base|baseKind|kind|trackedBase)\s*===\s*['"]usdg['"]/.test(code))
      offenders.push(`${f}:${i + 1}  ${line.trim()}`);
    // Reaching for usdgAddress means "the stable on this chain" on Robinhood only.
    if (/cc\.usdgAddress|ctx\.usdgAddress/.test(code) && !/usdtAddress|usdcAddress/.test(code))
      offenders.push(`${f}:${i + 1}  ${line.trim()}`);
  });
}
assert.equal(offenders.length, 0, `base asset hardcoded to USDG:\n${offenders.join('\n')}`);

// ── 2. Every chain answers about its own base, and the answers agree with each other.
for (const cc of Object.values(CHAINS)) {
  const st = stableOf(cc);
  assert.ok(st, `${cc.label}: no stable base at all`);
  const b = cc.bases.find((x) => x.address === st!.addr)!;
  assert.ok(isStableBase(b.kind), `${cc.label}: stableOf returned a non-stable base`);
  // The three readers must not drift apart -- decimals decide the size of every figure.
  assert.equal(v4BaseDecimals(cc, 'USDG'), st!.decimals, `${cc.label}: v4 decimals disagree with the base list`);
  assert.equal(baseDecimalsOf(cc.key, b.kind), st!.decimals, `${cc.label}: baseDecimalsOf disagrees with the base list`);
  assert.equal(v4BaseSymbol(cc, 'USDG'), st!.symbol, `${cc.label}: v4 symbol disagrees with the base list`);
  // A WETH-less chain must offer no ETH base, and a WETH-bearing one must carry an address.
  if (cc.hasWethBase) assert.notEqual(cc.wethAddress, '0x0000000000000000000000000000000000000000', `${cc.label}: an ETH base with no WETH address`);
  else assert.ok(!cc.bases.some((x) => x.kind === 'weth'), `${cc.label}: offers an ETH base without a wrapped native`);
  console.log(`${cc.label.padEnd(10)} ${st!.symbol.padEnd(5)} ${String(st!.decimals).padStart(2)} dec  · eth base: ${cc.hasWethBase}`);
}

console.log('ok: no chain\'s base asset is assumed, and every reader of it agrees');
