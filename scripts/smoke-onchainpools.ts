/**
 * One runnable check for on-chain v4 pool discovery.
 *
 * Guards the two failures that would make it silently useless: a PoolKey that
 * does not hash back to the poolId it came from (which must NEVER reach the mint
 * path), and native ETH being treated as a non-base (which once dropped the
 * single largest pool of a token while keeping two dust ones).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { ethers } from 'ethers';

// The PoolKey cache is a real file under data/. Snapshot it so this test never
// leaves an entry behind in the running bot's cache.
const CACHE = 'data/poolkeys.json';
const semula = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8') : null;
const pulihkan = () => (semula === null ? fs.rmSync(CACHE, { force: true }) : fs.writeFileSync(CACHE, semula));
process.on('exit', pulihkan);

// $RSTR on Robinhood: live with $86k liquidity while BOTH indexers returned zero.
const RSTR = '0x78b96280C3347E0f58a7147B73eb0EC5fFFf025d';
const POOL_ID = '0x935c1401e40a4eeec0e722f1841cc4be9d7a523cf90cdc52900f9e343304f0fe';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';

const LOG = {
  result: [{
    topics: [
      new ethers.Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'])
        .getEvent('Initialize')!.topicHash,
      POOL_ID,
      ethers.zeroPadValue(ethers.ZeroAddress, 32),
      ethers.zeroPadValue(RSTR.toLowerCase(), 32),
    ],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'], [0, 200, HOOK, 1n, 0]),
    blockNumber: '0x34d0b74',
  }],
};
const PAIRS = {
  pairs: [{
    chainId: 'robinhood', labels: ['v4'], pairAddress: POOL_ID,
    baseToken: { address: RSTR, symbol: 'RSTR' }, quoteToken: { address: ethers.ZeroAddress, symbol: 'ETH' },
    liquidity: { usd: 86201 }, volume: { h24: 1032334 },
  }],
};

globalThis.fetch = (async (u: string) => ({
  ok: true, status: 200,
  json: async () => (String(u).includes('dexscreener') ? PAIRS : LOG),
})) as any;

const { onchainV4Pools } = await import('../src/onchainPools.js');
const { CHAINS } = await import('../src/chains.js');

const pools = await onchainV4Pools(CHAINS.robinhood, RSTR);
assert.equal(pools.length, 1, 'an ETH-native pool must pass, not be dropped');
const p = pools[0];
assert.equal(p.protocol, 'v4');
assert.equal(p.base, 'weth', 'native ETH (0x0) must be recognised as the base side');
assert.equal(p.poolKey!.hooks, HOOK);
assert.equal(p.poolKey!.tickSpacing, 200);
assert.equal(p.fee, 0);
assert.equal(p.aprPct, null, 'a zero fee means the hook collects it, so a 0% APR would be a lie');
assert.equal(p.baseIsCurrency0, true);

// The poolKey must reproduce the poolId it was fetched under.
const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['tuple(address,address,uint24,int24,address)'],
  [[p.poolKey!.currency0, p.poolKey!.currency1, p.poolKey!.fee, p.poolKey!.tickSpacing, p.poolKey!.hooks]]));
assert.equal(id.toLowerCase(), POOL_ID, 'the keccak of the poolKey must equal the poolId');

// A log whose key hashes to something else must be REFUSED, never handed to the
// mint path. It needs an UNCACHED poolId: a cached key has already been verified,
// so the cache legitimately short-circuits the check.
const OTHER = '0x' + 'ab'.repeat(32);
const FAKE = JSON.parse(JSON.stringify(LOG));
FAKE.result[0].topics[1] = OTHER;
const PAIRS2 = JSON.parse(JSON.stringify(PAIRS));
PAIRS2.pairs[0].pairAddress = OTHER;
globalThis.fetch = (async (u: string) => ({
  ok: true, status: 200, json: async () => (String(u).includes('dexscreener') ? PAIRS2 : FAKE),
})) as any;
assert.deepEqual(await onchainV4Pools(CHAINS.robinhood, RSTR), [], 'a poolKey that does not match must be rejected');

console.log('smoke-onchainpools OK');
