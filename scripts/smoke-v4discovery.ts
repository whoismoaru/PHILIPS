/**
 * One runnable check on recovering a v4 PoolKey from a pool id.
 *
 * DexScreener lists a v4 pool by its POOL ID -- keccak(abi.encode(PoolKey)) -- which is
 * not invertible. With the pair known, only the fee and tick spacing are unknown, so
 * hashing the plausible combinations recovers the key that opening a position needs.
 *
 * The case this was built for (Arc, 17 Sep 2026): a token whose /add card offered ONE
 * dust v3 pool while a $52k v4 pool doing $974k a day was invisible to every source.
 * These three ids are that token's real pools, verified against the PoolManager: their
 * on-chain liquidity read 1266876900, 4378168 and 0.
 */
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { poolIdV4 } from '../src/uniswapV4.js';

const DUKE = '0x41358defd0dedc90528b3f1835715e907b686e6a';
const USDC_ARC = '0x3600000000000000000000000000000000000000';
const [c0, c1] = [DUKE, USDC_ARC].sort();

// fee -> tickSpacing -> the pool id DexScreener lists.
const KNOWN: Array<[number, number, string]> = [
  [50000, 500, '0x22bccf2f038c'],
  [10000, 200, '0x971d66fcc2f1'],
  [100000, 1000, '0x01e14cf36e9b'],
];
for (const [fee, tickSpacing, prefix] of KNOWN) {
  const id = poolIdV4({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: ethers.ZeroAddress } as any);
  assert.ok(
    id.toLowerCase().startsWith(prefix),
    `fee ${fee}/spacing ${tickSpacing} hashes to ${id.slice(0, 14)}, not ${prefix}: the PoolKey encoding changed and every recovered pool is now wrong`,
  );
}

// A different spacing must NOT collide -- the match is what proves the key.
const wrong = poolIdV4({ currency0: c0, currency1: c1, fee: 50000, tickSpacing: 501, hooks: ethers.ZeroAddress } as any);
assert.ok(!wrong.toLowerCase().startsWith('0x22bccf2f038c'), 'the id does not depend on tick spacing any more');

// The search must still cover the fees and spacings those pools use.
const src = readFileSync('src/explore.ts', 'utf8');
const fees = src.match(/const V4_FEE_TIERS = \[([^\]]+)\]/)?.[1] ?? '';
for (const [fee] of KNOWN) assert.ok(fees.split(',').map((x) => x.trim()).includes(String(fee)), `fee ${fee} dropped from the search`);
assert.ok(/labels \?\? \[\]\)\.includes\('v4'\)/.test(src), 'the v4 pairs are no longer selected from DexScreener');
assert.ok(
  /!out\.some\(\(p\) => p\.protocol === 'v4'\)/.test(src),
  'v4 discovery is gated on an EMPTY result again; a chain with v3-only indexing then keeps hiding its v4 pools',
);

console.log('ok: v4 PoolKeys are recovered from their pool ids, and the search still covers them');
