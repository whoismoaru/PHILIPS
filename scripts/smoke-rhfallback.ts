import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';

/**
 * Robinhood was the only chain without a backup RPC, and it is the bot's main
 * chain. On 3-4 Sep 2026 Alchemy threw 59x 403 then 503, and its head fell ~2000
 * blocks behind; sweep, sync and the retry probe all went down with it, with
 * nothing to catch them.
 *
 * This checks the provider really is a FallbackProvider (not a lone
 * JsonRpcProvider) and can still read the chain. NOTE: FallbackProvider fails
 * over on ERROR or STALL, not when the primary is stale but still answering.
 */
const rh = CHAINS.robinhood;
assert.ok(rh, 'chain robinhood hilang');
assert.ok(rh.provider instanceof ethers.FallbackProvider, 'robinhood tak punya RPC cadangan');

const blok = await rh.provider.getBlockNumber();
assert.ok(blok > 0, `blok tak masuk akal: ${blok}`);
console.log(`ok — robinhood FallbackProvider hidup, blok ${blok}`);
