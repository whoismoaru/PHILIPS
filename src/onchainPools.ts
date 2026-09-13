import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import type { ChainCtx } from './chains.js';
import { baseKindOf, type TokenPool } from './explore.js';
import { v4Supported } from './uniswapV4.js';

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
const TIMEOUT_MS = 15_000;

/**
 * poolId -> PoolKey, cached FOREVER and across restarts.
 *
 * A poolId is the keccak of its PoolKey, so the mapping is immutable by
 * construction: it cannot go stale, only be missing. Without this every screen of
 * the same token spent another explorer round-trip per pool, and Blockscout
 * answers 429 long before that becomes acceptable.
 */
const CACHE_FILE = path.join('data', 'poolkeys.json');
type Key = NonNullable<TokenPool['poolKey']>;
let cache: Record<string, Key> | null = null;

function cacheLoad(): Record<string, Key> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache!;
}

function cacheSave(id: string, k: Key): void {
  const c = cacheLoad();
  c[id.toLowerCase()] = k;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {
    /* a cache that cannot be written is slow, not broken */
  }
}

/** The PoolManager that EMITS Initialize (state manager, not the position manager). */
const V4_MANAGER: Record<string, string> = {
  robinhood: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  bsc: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF',
};

const IFACE = new ethers.Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
const TOPIC = IFACE.getEvent('Initialize')!.topicHash;

/** Public RPC that accepts a full-range eth_getLogs (the wallet's does not). */
const LOGS_RPC: Record<string, string> = {
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
};

const poolIdOf = (k: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): string =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,uint24,int24,address)'],
      [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]],
    ),
  );

async function postJson(url: string, body: unknown): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      // The public RPC sits behind the same Cloudflare as the explorer: a bare fetch
      // gets 403, a browser user-agent gets through.
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      },
      body: JSON.stringify(body),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      // Blockscout sits behind Cloudflare and answers 403 to a bare fetch.
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36' },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The PoolKey behind one poolId, read from the chain's own Initialize log.
 *
 * The wallet's RPC cannot answer this: Robinhood produces a block every ~0.1s, so
 * a 42-hour-old pool sits 1.5M blocks back and Alchemy's free tier caps getLogs at
 * 10 blocks. The chain's public RPC takes the full range in one call. Blockscout
 * used to serve this and is now behind a Cloudflare challenge (permanent 403).
 */
async function poolKeyOf(ctx: ChainCtx, poolId: string): Promise<TokenPool['poolKey'] | null> {
  const memo = cacheLoad()[poolId.toLowerCase()];
  if (memo) return memo;

  const mgr = V4_MANAGER[ctx.key];
  const rpc = LOGS_RPC[ctx.key];
  if (!mgr || !rpc) return null;

  const j = await postJson(rpc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getLogs',
    params: [{ fromBlock: '0x0', toBlock: 'latest', address: mgr, topics: [TOPIC, poolId] }],
  });
  const hit = (j?.result ?? [])[0];
  if (!hit) return null;
  let d: ethers.LogDescription | null;
  try {
    d = IFACE.parseLog({ topics: (hit.topics ?? []).filter(Boolean), data: hit.data });
  } catch {
    return null;
  }
  if (!d) return null;
  const key = {
    currency0: ethers.getAddress(d.args.currency0),
    currency1: ethers.getAddress(d.args.currency1),
    fee: Number(d.args.fee),
    tickSpacing: Number(d.args.tickSpacing),
    hooks: ethers.getAddress(d.args.hooks),
  };
  // The log is trusted only after its own hash reproduces the poolId we asked for.
  if (poolIdOf(key).toLowerCase() !== poolId.toLowerCase()) return null;
  cacheSave(poolId, key);
  return key;
}

/**
 * Every v4 pool for `token` that can take a single-sided position.
 *
 * Returns [] on any failure — this is an extra source layered beside the gateway
 * and Krystal, never a replacement, so it must never be the reason a pool list
 * comes back empty.
 */
export async function onchainV4Pools(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  if (!v4Supported(ctx) || !V4_MANAGER[ctx.key]) return [];
  const j = await getJson(`${DEXSCREENER_TOKENS}/${token}`);
  if (!j) return [];

  const kandidat = (j.pairs ?? []).filter(
    (p: any) => p?.chainId === ctx.dexKey && (p?.labels ?? []).includes('v4') && /^0x[0-9a-fA-F]{64}$/.test(p?.pairAddress ?? ''),
  );
  // Biggest first, and capped: a token can carry a dozen dust pools, and each one
  // costs an explorer round-trip that buys nothing.
  kandidat.sort((a: any, b: any) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0));

  const out: TokenPool[] = [];
  for (const p of kandidat.slice(0, 4)) {
    const key = await poolKeyOf(ctx, p.pairAddress);
    if (!key) continue;
    const sym: Record<string, string> = {};
    for (const t of [p?.baseToken, p?.quoteToken]) if (t?.address) sym[String(t.address).toLowerCase()] = t.symbol ?? '?';
    // Native ETH is currency 0x0 and has NO DexScreener entry, so its symbol has to
    // be supplied here. Without it baseKindOf sees an unknown address and rejects
    // the pool — which silently dropped the single largest RSTR pool ($86k) while
    // keeping two dust ones.
    const symOf = (a: string) => (a === ethers.ZeroAddress ? 'ETH' : (sym[a.toLowerCase()] ?? '?'));
    const b0 = baseKindOf(symOf(key.currency0), key.currency0, ctx);
    const b1 = baseKindOf(symOf(key.currency1), key.currency1, ctx);
    // Exactly one base side, or it cannot be opened single-sided.
    if ((b0 && b1) || (!b0 && !b1)) continue;
    if (!key.tickSpacing) continue;

    const baseIsCurrency0 = !!b0;

    const tvlUsd = Number(p?.liquidity?.usd ?? 0);
    const vol24hUsd = Number(p?.volume?.h24 ?? 0);
    out.push({
      protocol: 'v4',
      base: (b0 ?? b1)!,
      baseSymbol: symOf(baseIsCurrency0 ? key.currency0 : key.currency1),
      otherSymbol: symOf(baseIsCurrency0 ? key.currency1 : key.currency0),
      fee: key.fee,
      tvlUsd,
      vol24hUsd,
      // fee 0 means the HOOK charges instead of the pool (dynamic fee). Feeding a
      // zero into the APR formula would print a confident 0% for a pool that does
      // earn — better to admit the number is unknown.
      aprPct: key.fee > 0 && tvlUsd > 0 && vol24hUsd > 0 ? ((vol24hUsd * (key.fee / 1e6) * 365) / tvlUsd) * 100 : null,
      poolKey: key,
      baseIsCurrency0,
    });
  }
  return out;
}
