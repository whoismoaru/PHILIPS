import assert from 'node:assert/strict';
import { CHAINS } from '../src/chains.js';
import { poolIdV4 } from '../src/uniswapV4.js';
import { poolStatsV4Dex } from '../src/explore.js';

/**
 * The v4 detail card read "TVL: —" and "Volume: —" on pools holding real money, because
 * the Uniswap gateway indexes v4 on Robinhood only partially. The fallback keys on the
 * pool id, so what this has to prove is exactly that: the id computed from a PoolKey is
 * the same string DexScreener uses as its pairAddress, and real figures come back.
 */
const cc = CHAINS['robinhood'];
const pk = {
  currency0: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG
  currency1: '0xe27501d787d647CC82a5B4a7Eafd5750386F1B77', // TWINE
  fee: 50000,
  tickSpacing: 1,
  hooks: '0x0000000000000000000000000000000000000000',
};
const id = poolIdV4(pk as any);
assert.equal(id, '0x623cf7d58d37a3649615ef81fd3b91cbe5145b7a045aba19bbb78262cf0360d2', 'the pool id no longer matches the key');

const st = await poolStatsV4Dex(cc, pk.currency1, id);
console.log('pool', id, st);
assert.ok(st, 'no stats for a pool that is live: the fallback is dead');
assert.ok(st!.tvlUsd > 0, 'TVL came back as zero, which is the very hole this closes');

// A pool that does not exist must answer null rather than the first row it finds.
assert.equal(await poolStatsV4Dex(cc, pk.currency1, '0x' + 'ff'.repeat(32)), null, 'an unknown pool id matched something');

console.log('ok: v4 pool TVL/volume resolve through DexScreener by pool id');
