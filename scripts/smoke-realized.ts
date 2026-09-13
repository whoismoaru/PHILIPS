import assert from 'node:assert/strict';
import * as journal from '../src/journal.js';
import { CHAINS } from '../src/chains.js';

/**
 * A PnL book's unit follows its chain. Only BSC used to be special-cased, so a native
 * HyperEVM trade was recorded as 'ETH' and merged into the ETH book of other chains
 * -- two different assets summed into one figure.
 */
assert.equal(journal.unitOf('hyperevm', 'weth'), CHAINS.hyperevm!.nativeSymbol);
assert.equal(journal.unitOf('bsc', 'weth'), 'BNB');
assert.equal(journal.unitOf('robinhood', 'weth'), 'ETH');
assert.equal(journal.unitOf('base', 'weth'), 'ETH');
assert.notEqual(journal.unitOf('hyperevm', 'weth'), 'ETH', 'HYPE must never read as ETH');

// Stablecoins get their own book, including USDC, which used to fall into the native branch.
assert.equal(journal.unitOf('robinhood', 'usdg'), 'USDG');
assert.equal(journal.unitOf('bsc', 'usdt'), 'USDT');
assert.equal(journal.unitOf('base', 'usdc'), 'USDC');

// A chain may only use units that actually belong to it.
for (const cc of Object.values(CHAINS)) {
  const allowed = new Set([cc.nativeSymbol, ...cc.bases.map((b) => b.symbol), 'USDG', 'USDT', 'USDC']);
  for (const b of journal.statsFor(0, cc.key).books) {
    assert.ok(allowed.has(b.unit), `${cc.key} has a '${b.unit}' book for an asset it does not hold`);
  }
}

console.log('ok: book units follow the chain, and USDC no longer reads as native.');
