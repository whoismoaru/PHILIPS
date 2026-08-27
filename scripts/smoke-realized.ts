import assert from 'node:assert/strict';
import * as journal from '../src/journal.js';
import { CHAINS } from '../src/chains.js';

/**
 * Satuan buku PnL harus mengikuti chain-nya. Dulu hanya BSC yang dikecualikan,
 * jadi trade native HyperEVM tercatat 'ETH' dan menyatu dengan buku ETH chain lain
 * — dua aset berbeda dijumlahkan jadi satu angka.
 */
assert.equal(journal.unitOf('hyperevm', 'weth'), CHAINS.hyperevm!.nativeSymbol);
assert.equal(journal.unitOf('bsc', 'weth'), 'BNB');
assert.equal(journal.unitOf('robinhood', 'weth'), 'ETH');
assert.equal(journal.unitOf('base', 'weth'), 'ETH');
assert.notEqual(journal.unitOf('hyperevm', 'weth'), 'ETH', 'HYPE tak boleh terbaca sebagai ETH');

// Stablecoin punya bukunya sendiri, termasuk USDC yang dulu jatuh ke cabang native.
assert.equal(journal.unitOf('robinhood', 'usdg'), 'USDG');
assert.equal(journal.unitOf('bsc', 'usdt'), 'USDT');
assert.equal(journal.unitOf('base', 'usdc'), 'USDC');

// Tiap chain hanya boleh memakai satuan yang memang miliknya.
for (const cc of Object.values(CHAINS)) {
  const allowed = new Set([cc.nativeSymbol, ...cc.bases.map((b) => b.symbol), 'USDG', 'USDT', 'USDC']);
  for (const b of journal.statsFor(0, cc.key).books) {
    assert.ok(allowed.has(b.unit), `${cc.key} punya buku '${b.unit}' yang bukan asetnya`);
  }
}

console.log('OK — realized PnL: satuan buku mengikuti chain, USDC tak lagi terbaca native.');
