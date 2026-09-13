/**
 * One runnable check for v4 NFT enumeration via Transfer logs.
 *
 * Blockscout, the old source, is permanently behind a Cloudflare challenge, so
 * ownership is now derived from the logs themselves. Two things decide whether that
 * is correct, and neither fails loudly: the LAST event per tokenId must win (an NFT
 * that left the wallet must not be listed), and a failed scan must fall back to
 * v4store while flagging the list as degraded -- never return an empty list.
 */
import assert from 'node:assert';
import { ethers } from 'ethers';
import { getChain } from '../src/chains.js';
import { walletV4TokenIds, v4ListDegraded, resetV4EnumCache } from '../src/uniswapV4.js';

const cc = getChain('robinhood');
const asli = globalThis.fetch;
const T = ethers.id('Transfer(address,address,uint256)');
const W = ethers.zeroPadValue(cc.wallet.address, 32);
const id32 = (n: number) => ethers.toBeHex(n, 32);
const log = (blok: number, i: number, tid: number) => ({
  blockNumber: '0x' + blok.toString(16),
  logIndex: '0x' + i.toString(16),
  topics: [T, ethers.ZeroHash, W, id32(tid)],
});

// Only eth_getLogs is stubbed; every other RPC call goes to the real chain.
const stub = (incoming: unknown[], outgoing: unknown[], failing = false) =>
  (async (url: string, init: any) => {
    const b = JSON.parse(String(init?.body ?? '{}'));
    if (b.method !== 'eth_getLogs') return asli(url as any, init);
    if (failing) return { ok: false, status: 429, json: async () => ({}) };
    const keluarkah = b.params[0].topics[1] === W;
    return { ok: true, status: 200, json: async () => ({ result: keluarkah ? outgoing : incoming }) };
  }) as unknown as typeof globalThis.fetch;

async function main() {
  // 999001: transferred IN at block 10, OUT at block 20 -> must NOT be listed.
  resetV4EnumCache();
  globalThis.fetch = stub([log(10, 0, 999001)], [log(20, 0, 999001)]);
  let ids = await walletV4TokenIds(cc);
  assert.ok(!ids.includes('999001'), 'an NFT that already left is still listed, so the event order is wrong');
  assert.equal(v4ListDegraded(), false, 'a successful scan must not be marked degraded');

  // Same tokenId, this time it came back: OUT at 20, IN at 30 -> owned again.
  resetV4EnumCache();
  globalThis.fetch = stub([log(30, 0, 999002)], [log(20, 0, 999002)]);
  ids = await walletV4TokenIds(cc);
  assert.ok(ids.includes('999002'), 'an NFT that came back is not listed');

  // A failed scan must degrade, not empty out: the bot's own positions stay.
  resetV4EnumCache();
  globalThis.fetch = stub([], [], true);
  const ps = await walletV4TokenIds(cc);
  assert.equal(v4ListDegraded(), true, 'a failed scan must mark the list incomplete');
  assert.ok(ps.length > 0, 'a failed scan emptied the list, so the bot positions vanished');

  globalThis.fetch = asli;
  console.log('ok: ownership ordering is correct, and a failure degrades gracefully to v4store');
}
main();
