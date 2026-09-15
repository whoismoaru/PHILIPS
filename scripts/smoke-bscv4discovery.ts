import assert from 'node:assert/strict';
import { CHAINS } from '../src/chains.js';
import * as explore from '../src/explore.js';

/**
 * Uniswap v4 pools on BSC must be discoverable.
 *
 * BSC's default venue is PancakeSwap, so discovery runs through DexScreener plus the chain
 * itself -- and neither sees most Uniswap v4 pools: DexScreener labels only some of them,
 * and the on-chain v4 scan takes its candidates from DexScreener as well. Measured
 * 15 Sep 2026: CAKE had two v4 pools holding $29k and $6k that no source in the bot could
 * see, while the Uniswap gateway listed them plainly.
 */
const cc = CHAINS['bsc'];
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const pools = await explore.poolsForToken(cc, CAKE);
const v4 = pools.filter((p) => p.protocol === 'v4');
const v3 = pools.filter((p) => p.protocol === 'v3');

assert.ok(v3.length > 0, 'the PancakeSwap v3 pools have gone: the DexScreener path is broken');
assert.ok(v4.length > 0, 'no Uniswap v4 pool found on BSC — the gateway merge is not running');

for (const p of v4) {
  // Every v4 pool offered must be openable single-sided and carry the key needed to do it.
  assert.ok(p.poolKey, 'a v4 pool arrived without its poolKey');
  assert.ok(p.poolKey!.tickSpacing > 0, 'a v4 pool arrived with no tick spacing');
  assert.equal(p.poolKey!.hooks, '0x0000000000000000000000000000000000000000', 'a hooked pool must not be offered');
  assert.ok(cc.bases.some((b) => b.symbol === p.baseSymbol), `${p.baseSymbol} is not a base on ${cc.label}`);
}
console.log(`ok: BSC discovery returns ${v3.length} v3 and ${v4.length} v4 pools, every v4 one openable single-sided`);
