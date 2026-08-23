import { ethers } from 'ethers';
import { getChain, baseOf } from '../src/chains.js';
import { priceInfo, planAddSingleSided } from '../src/uniswap.js';
import { config } from '../src/config.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const found: number[] = [];
for (const fee of getChain().feeTiers) {
  const pool = await getChain().factory.getPool(config.uniswap.weth, USDG, fee);
  if (pool && pool !== ethers.ZeroAddress) {
    found.push(fee);
    console.log(`pool WETH/USDG fee ${fee}: ${pool}`);
  }
}
if (found.length === 0) {
  console.log('Tidak menemukan pool WETH/USDG. Coba token lain.');
  process.exit(0);
}

const fee = found[0];
console.log('\n--- priceInfo ---');
console.log(await priceInfo(USDG, fee, baseOf(getChain(), 'weth')));

console.log('\n--- planAddSingleSided 0.01 ETH, rentang 10% ---');
const plan = await planAddSingleSided(USDG, fee, '0.01', 10, baseOf(getChain(), 'weth'));
console.log({
  baseIsToken0: plan.baseIsToken0,
  tickLower: plan.tickLower,
  tickUpper: plan.tickUpper,
  priceRange: `${plan.priceLower}..${plan.priceUpper}`,
  baseSetor: ethers.formatUnits(plan.baseAmountWei, plan.baseDecimals) + ' ' + plan.baseSymbol,
  tokenLain: plan.otherSymbol,
});
process.exit(0);
