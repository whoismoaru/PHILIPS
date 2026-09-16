import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAINS, isStableBase } from '../src/chains.js';
import { v4Supported, v4BaseSymbol } from '../src/uniswapV4.js';
import { allV4 } from '../src/v4store.js';

const src = readFileSync('src/index.ts', 'utf8');
assert.ok(!/selected\.base === 'usdg'/.test(src), "a v4 open path still tests `selected.base === 'usdg'`");

for (const cc of Object.values(CHAINS).filter(v4Supported)) {
  const sym = v4BaseSymbol(cc, 'USDG');
  // On a chain whose gas IS the stablecoin (Arc: USDC), stable === native is the
  // correct answer, not the mix-up this guard exists to catch.
  if (cc.hasWethBase)
    assert.notEqual(sym, cc.nativeSymbol, `${cc.key}: the stable base resolves to the native symbol`);
  assert.ok(sym.length > 0, `${cc.key}: no stable base symbol`);
  assert.ok(cc.bases.some((b) => isStableBase(b.kind)), `${cc.key}: no stable base at all`);
}

for (const r of allV4()) {
  if (r.base !== 'USDG' || r.entryEthUsd === undefined) continue;
  assert.equal(
    r.entryEthUsd,
    1,
    `v4 #${r.tokenId} (${r.chain}): stable base stamped with entryEthUsd ${r.entryEthUsd} — PnL will read as a near-total loss`,
  );
}

console.log(`ok — v4 base stamps follow the chain (${allV4().length} live record(s) checked)`);
