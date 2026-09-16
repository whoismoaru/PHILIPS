/**
 * One runnable check that v4 pools are DISCOVERABLE on every chain that has v4.
 *
 * Having the v4 contracts is not the same as being able to find a v4 pool. On Arc the bot
 * could open v4 positions all along, while /add offered a token's dust v3 pool and hid a
 * $52k v4 pool with $974k daily volume: the gateway indexed only v3 there, the DexScreener
 * path filters for `labels: v3`, and the on-chain fallback enumerates through
 * factory.getPool, which has no v4 equivalent. Three sources, none of them v4.
 *
 * So for each chain: if it carries v4 contracts, its discovery route must reach a v4
 * source. A chain without v4 contracts (HyperEVM, where no PoolManager is deployed and
 * DexScreener sees only v2/v3) is exempt -- there is nothing to find.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAINS } from '../src/chains.js';
import { v4Supported } from '../src/uniswapV4.js';

const src = readFileSync('src/explore.ts', 'utf8');
const gatewayChains = Object.keys(
  JSON.parse(
    '{' +
      (src.match(/const UNISWAP_CHAIN: Record<string, string> = \{([\s\S]*?)\n\};/)?.[1] ?? '')
        .split('\n')
        .filter((l) => /^\s*\w+:\s*'/.test(l))
        .map((l) => l.trim().replace(/(\w+):\s*'([^']+)',?/, '"$1":"$2"'))
        .join(',') +
      '}',
  ),
);

// The two v4 sources that exist, and the branch each one serves.
assert.ok(/async function dexV4Pools\(/.test(src), 'dexV4Pools is gone: nothing recovers a v4 pool from its id');
assert.ok(/async function gatewayV4Pools\(/.test(src), 'gatewayV4Pools is gone');
// Gateway branch: v4 recovery must run whenever the gateway returned no v4.
assert.ok(
  /if \(!out\.some\(\(p\) => p\.protocol === 'v4'\)\) \{[\s\S]{0,200}dexV4Pools/.test(src),
  'the gateway branch no longer falls back to v4 discovery',
);
// Non-gateway branch: same backstop, gated on the chain actually having v4.
assert.ok(
  /v4\.length \|\| !v4Supported\(ctx\)[\s\S]{0,80}dexV4Pools/.test(src),
  'the DexScreener branch no longer backstops v4 discovery',
);

for (const [key, cc] of Object.entries(CHAINS)) {
  if (!v4Supported(cc as any)) continue; // no contracts, nothing to discover
  // Both routes end at a v4 source now. What must never happen is a v4 chain with no
  // dexKey: the id-matching fallback selects pairs by it, so without one that chain is
  // left with whatever the gateway happens to know -- which is how Arc went blind.
  assert.ok(
    (cc as any).dexKey,
    `${key} has v4 contracts but no dexKey, so the pool-id fallback cannot run for it`,
  );
  assert.ok(
    gatewayChains.includes(key) || !!(cc as any).dexKey,
    `${key} reaches neither the gateway nor DexScreener, so no v4 pool can be found there`,
  );
}

const withV4 = Object.entries(CHAINS).filter(([, cc]) => v4Supported(cc as any)).map(([k]) => k);
assert.ok(withV4.length >= 4, `only ${withV4.length} chains carry v4 contracts: ${withV4.join(', ')}`);

console.log(`ok: v4 is discoverable on every chain that has it (${withV4.join(', ')})`);
