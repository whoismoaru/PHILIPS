import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CHAINS, EXPLORER_TX } from '../src/chains.js';
import { v4Supported, hookAcceptsLp } from '../src/uniswapV4.js';
import { onchainV4Pools } from '../src/onchainPools.js';
import { feeLabel } from '../src/messages.js';
import { lifiSupports } from '../src/lifi.js';
import { OFFICIAL_RPC } from '../src/feeOracle.js';
import { poolsForToken } from '../src/explore.js';

/**
 * Elysium (chain 99901) against the live chain, read-only. Run with ELYSIUM_ENABLED=true.
 *
 * The trap here is WHYPE: Elysium has two. The v3 deployment wraps 0x43Ca...6090 (2.85
 * supply, nothing trades it); the v4 PositionManager and every live pair use
 * 0xbA87...5E81. A registry pointing at the wrong one sees no pools at all.
 */
const cc = CHAINS.elysium;
assert.ok(cc, 'elysium is not in CHAINS: is ELYSIUM_ENABLED=true?');
assert.equal(Number((await cc.provider.getNetwork()).chainId), 99901);
assert.ok(EXPLORER_TX.elysium && OFFICIAL_RPC[99901] && lifiSupports(cc), 'explorer, gas oracle or LI.FI entry missing');

// v3: the position manager belongs to this factory, and every fee tier we list is live.
const pm3 = new ethers.Contract(cc.pmAddress, ['function factory() view returns (address)'], cc.provider);
assert.equal(await pm3.factory(), ethers.getAddress(await cc.factory.getAddress()));
const fac = new ethers.Contract(await cc.factory.getAddress(), ['function feeAmountTickSpacing(uint24) view returns (int24)'], cc.provider);
for (const fee of cc.feeTiers) assert.equal(Number(await fac.feeAmountTickSpacing(fee)), cc.tickSpacing[fee], `fee ${fee}`);

// v4: the PositionManager sits on our PoolManager and wraps OUR WHYPE.
assert.ok(v4Supported(cc), 'v4 is not enabled on elysium');
const pm4 = new ethers.Contract(
  '0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518',
  ['function poolManager() view returns (address)', 'function WETH9() view returns (address)'],
  cc.provider,
);
assert.equal(await pm4.poolManager(), '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1');
assert.equal(await pm4.WETH9(), cc.wethAddress, 'the base WHYPE is not the one v4 wraps');

// Bases: decimals read from the tokens themselves.
for (const b of cc.bases) {
  const t = new ethers.Contract(b.address, ['function decimals() view returns (uint8)'], cc.provider);
  assert.equal(Number(await t.decimals()), b.decimals, `${b.symbol} decimals`);
}

// A launchpad hook that keeps its pool to itself is refused; a plain pool is not.
// e/acc's pool runs on hook 0xe0dE...a8eC, which reverts 0xf09c8c8e for any outside add.
const eacc = {
  currency0: '0x8df4f39d592de2aAee15838B265C2392d19A4128',
  currency1: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81',
  fee: 0x800000,
  tickSpacing: 200,
  hooks: '0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC',
};
assert.equal(await hookAcceptsLp(cc, eacc), false, 'the e/acc launchpad hook must be refused');
assert.equal(await hookAcceptsLp(cc, { ...eacc, hooks: ethers.ZeroAddress, fee: 10000 }), true, 'no hook, no gate');
assert.equal(feeLabel(0x800000), 'dynamic');

// Discovery end to end on tokens from the command line.
for (const token of process.argv.slice(2)) {
  const pools = [...(await poolsForToken(cc, token)), ...(await onchainV4Pools(cc, token))];
  console.log(token, pools.map((p) => `${p.protocol} ${p.otherSymbol}/${p.baseSymbol} ${feeLabel(p.fee)} hook ${p.poolKey?.hooks ?? '-'} tvl $${Math.round(p.tvlUsd)}`).join(' | ') || 'no pools');
}
console.log('ok: elysium registry matches the chain (v3 venue, v4 PoolManager/PositionManager, WHYPE, USDC)');
