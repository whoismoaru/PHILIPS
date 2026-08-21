import { planAddSingleSided } from '../src/uniswap.js';
import { getChain, baseOf } from '../src/chains.js';
const p = await planAddSingleSided('0x020bfc650a365f8bb26819deaabf3e21291018b4', 10000, '0.02', 10, baseOf(getChain(), 'weth'));
console.log('Harga kini :', p.currentPrice, 'WETH');
console.log('Rentang %  :', p.pctHigh.toFixed(1)+'%', 's/d', p.pctLow.toFixed(1)+'%');
console.log('Rentang WETH:', p.priceLower, '..', p.priceUpper);
process.exit(0);
