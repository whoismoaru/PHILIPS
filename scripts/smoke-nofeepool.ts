/**
 * One runnable check that pools paying LPs nothing are dropped, not offered.
 *
 * $RSTR's deepest pool on Robinhood turned over $3.4M in a day with
 * feeGrowthGlobal still at zero on both sides: the hook takes the swap fee and
 * routes it to protocol, creator and buyback. Two positions were opened there
 * before this was caught, and both earned exactly $0.00 while carrying full
 * impermanent-loss risk.
 */
import assert from 'node:assert';
import { ethers } from 'ethers';
import { readFeeGrowth, poolHealthV4 } from '../src/uniswapV4.js';
import { CHAINS } from '../src/chains.js';

const cc = CHAINS.robinhood;
const HOOKED = { // ETH/RSTR — hook charges, pool does not
  currency0: ethers.ZeroAddress,
  currency1: '0x78b96280C3347E0f58a7147B73eb0EC5fFFf025d',
  fee: 0, tickSpacing: 200, hooks: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
};
const NORMAL = { // USDG/RSTR fee 5% — no hook, accrues normally
  currency0: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  currency1: '0x78b96280C3347E0f58a7147B73eb0EC5fFFf025d',
  fee: 50000, tickSpacing: 1000, hooks: ethers.ZeroAddress,
};

const a = await readFeeGrowth(cc, HOOKED);
assert.equal(a.g0, 0n, 'a hooked pool must have feeGrowth0 at zero');
assert.equal(a.g1, 0n, 'a hooked pool must have feeGrowth1 at zero');

const h = await poolHealthV4(cc, HOOKED);
assert.equal(h.paysLps, false, 'a hooked pool must be flagged as paying LPs nothing');
assert.ok(h.liquidity > 0n, 'the pool is alive, so that is not why it was dropped');

// The control: a hookless pool on the SAME token must still pass, or the filter
// would be condemning every pool rather than the ones that take the fee.
const b = await readFeeGrowth(cc, NORMAL);
assert.ok(b.g0 > 0n || b.g1 > 0n, 'a pool without hooks must have fee growth');

// The source guard: the drop must require volume, or a brand-new honest pool
// (which also reads zero) would be thrown away for never having traded yet.
const src = await import('node:fs/promises').then((f) => f.readFile('src/index.ts', 'utf8'));
assert.ok(/!h\.paysLps && \(p\.vol24hUsd \?\? 0\) >= NO_FEE_VOL_USD/.test(src),
  'dropping a pool must require volume, not just a zero feeGrowth');

console.log('smoke-nofeepool OK');
