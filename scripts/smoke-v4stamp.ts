/**
 * A v4 position's base stamp must follow the CHAIN, not a hardcoded 'usdg'.
 *
 * On BSC the stable base is USDT, so testing `base === 'usdg'` stamped a stablecoin
 * position as native and wrote the BNB price into entryEthUsd. The card then valued
 * 300 USDT of capital at 300 x $775 and reported -99.9% on an untouched position.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAINS, isStableBase } from '../src/chains.js';
import { v4Supported, v4BaseSymbol } from '../src/uniswapV4.js';
import { allV4 } from '../src/v4store.js';

// Source guard: the open paths must not go back to the literal comparison.
const src = readFileSync('src/index.ts', 'utf8');
assert.ok(!/selected\.base === 'usdg'/.test(src), "a v4 open path still tests `selected.base === 'usdg'`");

// 'USDG' inside the v4 module means "this chain's stable base", so it must resolve to
// a real stablecoin symbol on every v4 chain — never to the native one.
for (const cc of Object.values(CHAINS).filter(v4Supported)) {
  const sym = v4BaseSymbol(cc, 'USDG');
  assert.notEqual(sym, cc.nativeSymbol, `${cc.key}: the stable base resolves to the native symbol`);
  assert.ok(sym.length > 0, `${cc.key}: no stable base symbol`);
  // ANY stable base counts, not just usdt/usdg: Base's stablecoin is USDC, and checking
  // only two names reported a chain as having no stablecoin while it had one.
  assert.ok(cc.bases.some((b) => isStableBase(b.kind)), `${cc.key}: no stable base at all`);
}

// Live records: a stable-based position must carry entryEthUsd = 1. Anything else
// multiplies its capital by a native price and reports a fictional loss.
for (const r of allV4()) {
  if (r.base !== 'USDG' || r.entryEthUsd === undefined) continue;
  assert.equal(
    r.entryEthUsd,
    1,
    `v4 #${r.tokenId} (${r.chain}): stable base stamped with entryEthUsd ${r.entryEthUsd} — PnL will read as a near-total loss`,
  );
}

console.log(`ok — v4 base stamps follow the chain (${allV4().length} live record(s) checked)`);
