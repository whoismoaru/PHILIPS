import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';
import { v4Supported, v4BaseSymbol, v4BaseDecimals } from '../src/uniswapV4.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * v4 on more than one chain. Two things used to be hard-coded and broke the moment BSC
 * dinyalakan: base stablecoin ('USDG' harfiah) dan desimalnya (6). Di BSC
 * whose base is USDT with 18 decimals.
 */
for (const cc of Object.values(CHAINS)) {
  if (!v4Supported(cc)) continue;
  const stable = cc.bases.find((b) => b.kind !== 'weth');
  assert.ok(stable, `${cc.key}: v4 is enabled but this chain has no stablecoin base`);
  assert.equal(v4BaseSymbol(cc, 'USDG'), stable!.symbol, `${cc.key}: the v4 base symbol is wrong`);
  assert.equal(v4BaseDecimals(cc, 'USDG'), stable!.decimals, `${cc.key}: the v4 base decimals are wrong`);
  assert.equal(v4BaseSymbol(cc, 'ETH'), cc.nativeSymbol, `${cc.key}: the native symbol is wrong`);
  assert.equal(v4BaseDecimals(cc, 'ETH'), 18);
}

/**
 * The v4 address checksums MUST be right. Pool reads are wrapped in catch(() => 0n), so
 * a wrong address does not throw: it poses as a "pool with no liquidity"
 * and silently drops EVERY pool on that chain. It happened on 28 Aug 2026.
 */
const src = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');
const addrs = [...src.matchAll(/^\s{2}(\w+): '(0x[0-9a-fA-F]{40})',$/gm)].map((m) => m[2]);
assert.ok(addrs.length >= 3, `only ${addrs.length} addresses parsed: has the table's shape changed?`);
for (const a of addrs) {
  assert.equal(a, ethers.getAddress(a.toLowerCase()), `bad checksum: ${a}`);
}

console.log(`ok: ${addrs.length} v4 addresses carry valid checksums, and each chain's base matches.`);
