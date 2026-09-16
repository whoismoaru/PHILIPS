import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';
import * as explore from '../src/explore.js';

/**
 * /swap must be able to sell a token the bot never bought.
 *
 * Until 16 Sep 2026 the holdings list on a chain without Blockscout (BSC, Base, HyperEVM,
 * Arc) was built ONLY from the journal and live positions -- so a meme bought anywhere else
 * had no way out. The wallet itself is now the source, through the node.
 */
const src = readFileSync('src/index.ts', 'utf8');
assert.match(src, /alchemy_getTokenBalances/, 'the wallet scan is gone');
// A FallbackProvider has no .send(), so the call must go to the primary endpoint itself.
assert.match(src, /new ethers\.JsonRpcProvider\(cc\.rpcUrl/, 'the scan must use the primary endpoint directly');
// Spam guard: a token with no market price is only offered if we have traded it before.
assert.match(src, /\(prices\.get\(ca\) \?\? 0\) > 0 \|\| known\.has\(ca\)/, 'the airdrop-spam guard is gone');
// And the ordering is by what the HOLDING is worth, not the unit price.
assert.match(src, /const roughUsd = \(ca: string\) =>/, 'candidates are no longer ranked by holding value');

// Live: the scan sees tokens, and the price filter keeps the list honest.
const cc = CHAINS['bsc'];
const rpc = new ethers.JsonRpcProvider(cc.rpcUrl, cc.chainId, { staticNetwork: true });
const res: any = await rpc.send('alchemy_getTokenBalances', [cc.wallet.address]).catch(() => null);
assert.ok(res?.tokenBalances, 'the node no longer answers alchemy_getTokenBalances on BSC');
const held = (res.tokenBalances as any[]).filter((t) => {
  try { return BigInt(t.tokenBalance ?? '0x0') > 0n; } catch { return false; }
});
assert.ok(held.length > 0, 'no ERC-20 balances found at all — the scan is returning nothing');

const prices = await explore.tokenUsdPrices(cc, held.map((t) => String(t.contractAddress)));
assert.ok(prices.size > 0, 'no prices resolved: the batch price lookup is broken');
// The deepest pool sets the price, so a stablecoin must come back near a dollar.
const usdt = prices.get(cc.usdtAddress!.toLowerCase());
if (usdt) assert.ok(usdt > 0.5 && usdt < 2, `USDT priced at ${usdt}: the deepest-pool rule is not holding`);

console.log(`ok: the wallet scan sees ${held.length} tokens on BSC and ${prices.size} of them have a market price`);

// The same dust rule as /portfolio: a holding worth under a dime is left off the swap list
// (the gas to sell it costs more than it returns), but an UNPRICED holding is kept --
// unknown is not worthless, and hiding it would remove the only way out of that token.
assert.match(src, /const SELL_DUST_USD = 0\.1;/, 'the swap dust threshold is gone');
assert.match(src, /h\.usd === null \|\| h\.usd >= SELL_DUST_USD/, 'an unpriced holding must survive the dust filter');
assert.equal((src.match(/\.filter\(sellable\)/g) ?? []).length, 2, 'both holdings paths must apply the filter');
console.log('ok: the swap list hides sub-$0.10 dust and keeps what it cannot price');
