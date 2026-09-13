import { ethers } from 'ethers';
import { config } from './config.js';
import { venueCtx, venuesFor, type BaseKind, type ChainCtx } from './chains.js';
import type { TokenPool } from './explore.js';
import { v4Supported, type PoolKeyV4 } from './uniswapV4.js';

/**
 * Pools from the Krystal Cloud API -- a far more complete list than Uniswap's gateway or
 * DexScreener (it carries deep ETH/token pools the gateway simply misses), with correct
 * TVL. Used on Robinhood (Uniswap v3/v4) and BSC (PancakeSwap v3).
 *
 * What matters per protocol:
 *  - v4: Krystal's list reports the EFFECTIVE fee and a tickSpacing of 0, neither of which
 *    can be used to mint. The poolKey is rebuilt in resolveV4PoolKey (Krystal's detail plus
 *    a brute-forced fee) and then VERIFIED by keccak == poolId. Offered only on chains
 *    where the bot can actually manage the position afterwards.
 *  - v3: poolAddress is the pool contract itself, and opening needs only the fee plus
 *    factory.getPool, so nothing has to be rebuilt. The fee must be one of the chain's tiers.
 */

const CHAIN_ID: Record<string, number> = { robinhood: 4663, bsc: 56, base: 8453 };
const API = 'https://cloud-api.krystal.app/v1';
const V3_PROTOCOLS = new Set(['uniswapv3', 'pancakev3', 'sushiv3']);

export const krystalConfigured = (cc: ChainCtx): boolean => !!config.krystal.apiKey && CHAIN_ID[cc.key] !== undefined;

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { 'KC-APIKey': config.krystal.apiKey, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`krystal HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const coder = ethers.AbiCoder.defaultAbiCoder();
// An ABI-encoded poolKey buffer with fee=0 as a placeholder; the fee is rewritten per attempt.
const poolIdBufferHex = (c0: string, c1: string, ts: number, h: string): string =>
  coder.encode(['tuple(address,address,uint24,int24,address)'], [[c0, c1, 0, ts, h]]);

// A verified poolKey is immutable -- the poolId IS its keccak -- so it is cached for good.
// That makes resolution survive a passing API outage: once proven, never repeated.
const pkCache = new Map<string, PoolKeyV4>();

/** One pool's detail: the list returns tickSpacing 0, the detail returns the real tickSpacing and hooks. */
async function krystalDetail(cid: number, poolId: string): Promise<{ tickSpacing: number; hooks: string; feeTier: number } | null> {
  const d = await fetchJson(`${API}/pools/${cid}/${poolId}`).catch(() => null);
  if (!d || d.tickSpacing == null) return null;
  return { tickSpacing: Number(d.tickSpacing), hooks: d.hook ?? ethers.ZeroAddress, feeTier: Number(d.feeTier) };
}

/**
 * A verified v4 poolKey, resolved reliably and without Blockscout -- getLogs from 0 to
 * latest used to time out or hit the rate limit, and v4 pools vanished from the list.
 *
 * The source is Krystal's detail (tickSpacing and hooks) plus a BRUTE-FORCED fee: Krystal
 * only knows the EFFECTIVE fee, roughly the poolKey fee minus ~1000 units, so the fee is
 * searched in a narrow window around the fee tier and then VERIFIED by keccak == poolId. A
 * match is certain to be mintable; wrong hooks or tickSpacing simply never match and the
 * pool is not offered. The result is cached.
 */
async function resolveV4PoolKey(cc: ChainCtx, p: any): Promise<PoolKeyV4 | null> {
  const poolId = String(p.poolAddress);
  const hit = pkCache.get(poolId);
  if (hit) return hit;
  const a = p.token0?.token?.address, b = p.token1?.token?.address;
  if (!a || !b) return null;
  const det = await krystalDetail(CHAIN_ID[cc.key], poolId);
  if (!det) return null;
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  // Encode the poolKey ONCE, then per attempt rewrite only the 3 fee bytes (the uint24 at
  // the end of the third word) and hash -- far faster than calling AbiCoder.encode each
  // time, which took ~40 s for five pools and left the wizard hanging. A wide window is
  // affordable precisely because each attempt is this cheap.
  const buf = ethers.getBytes(poolIdBufferHex(c0, c1, det.tickSpacing, det.hooks));
  const target = poolId.toLowerCase();
  // The poolKey fee is the effective fee less a few percent (the dynamic-fee premium,
  // measured at 2-3%). A window of 20% below and 2000 above gives roughly six times the
  // observed margin, and still costs almost nothing.
  const lo = Math.max(0, Math.floor(det.feeTier * 0.8) - 100);
  const hi = det.feeTier + 2_000;
  for (let f = lo; f <= hi; f++) {
    buf[93] = (f >> 16) & 0xff;
    buf[94] = (f >> 8) & 0xff;
    buf[95] = f & 0xff;
    if (ethers.keccak256(buf) === target) {
      const pk: PoolKeyV4 = { currency0: ethers.getAddress(c0), currency1: ethers.getAddress(c1), fee: f, tickSpacing: det.tickSpacing, hooks: det.hooks };
      pkCache.set(poolId, pk);
      return pk;
    }
  }
  return null;
}

/** The chain's DEFAULT v3 protocol, the one cc.factory points at. */
const chainV3Protocol = (cc: ChainCtx): string => (cc.dexLabel === 'PancakeSwap' ? 'pancakev3' : 'uniswapv3');

/**
 * The venue for a v3 protocol on this chain, or null when the bot has no contracts for it.
 * The chain's default protocol returns undefined (use the chain's own contracts); any other
 * returns its venue name if VENUES lists it -- 'uniswapv3' on BSC, say, which has its own
 * factory separate from PancakeSwap's.
 */
function venueForProtocol(cc: ChainCtx, proto: string): { venue?: string } | null {
  if (proto === chainV3Protocol(cc)) return {};
  return venuesFor(cc.key).includes(proto) ? { venue: proto } : null;
}

/** Our base asset within a currency pair, or null when the pair has none we support. */
function baseOfPair(
  cc: ChainCtx,
  c0: string,
  c1: string,
): { base: BaseKind; baseIsCurrency0: boolean } | null {
  const isEth = (a: string) =>
    cc.hasWethBase && (a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase());
  const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
  const isUsdt = (a: string) => !!cc.usdtAddress && a.toLowerCase() === cc.usdtAddress.toLowerCase();
  if (isEth(c0)) return { base: 'weth', baseIsCurrency0: true };
  if (isEth(c1)) return { base: 'weth', baseIsCurrency0: false };
  if (isUsdg(c0)) return { base: 'usdg', baseIsCurrency0: true };
  if (isUsdg(c1)) return { base: 'usdg', baseIsCurrency0: false };
  if (isUsdt(c0)) return { base: 'usdt', baseIsCurrency0: true };
  if (isUsdt(c1)) return { base: 'usdt', baseIsCurrency0: false };
  return null;
}

/**
 * Pools for one token via Krystal, ready for the wizard. v4 entries carry a poolKey
 * verified on chain; v3 entries carry a fee and a base and are opened through
 * factory.getPool. Only pairs against one of our bases, sorted by TVL descending. An
 * unconfigured or failing API returns an empty list, and the caller still applies its own
 * health filters.
 */
export async function krystalPools(cc: ChainCtx, token: string, sortBy = 0): Promise<TokenPool[]> {
  if (!krystalConfigured(cc)) return [];
  const cid = CHAIN_ID[cc.key];
  const list = await fetchJson(
    `${API}/pools?chainId=${cid}&token=${token}&sortBy=${sortBy}&limit=50`,
  ).catch(() => null);
  if (!Array.isArray(list)) return [];
  const out = await Promise.all(
    list.map(async (p: any): Promise<TokenPool | null> => {
      const proto = p?.protocol?.key as string | undefined;
      if (!proto || !p.poolAddress) return null;
      const t0 = p.token0?.token, t1 = p.token1?.token;
      if (!t0?.address || !t1?.address) return null;
      // Skip dust BEFORE the expensive v4 poolKey resolution. Tested against TVL alone:
      // volume must never paper over an empty pool (see MIN_POOL_TVL_USD). The threshold
      // here is half the display one, so the caller still makes the final call.
      const tvl = Number(p.tvl) || 0;
      if (tvl < 500) return null;

      if (proto === 'uniswapv4') {
        // v4 only where a PositionManager is configured -- without one, a position opened
        // here could be neither monitored nor closed. Blockscout is no longer required:
        // enumeration has an indexer-free path (nextTokenId plus ownerOf).
        if (!v4Supported(cc)) return null;
        const pk = await resolveV4PoolKey(cc, p);
        if (!pk) return null; // the poolKey is unproven, so do not offer it
        const b = baseOfPair(cc, pk.currency0, pk.currency1);
        if (!b) return null;
        const otherSym = (b.baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
        const baseSym = (b.baseIsCurrency0 ? t0.symbol : t1.symbol) ?? (b.base === 'weth' ? 'ETH' : b.base.toUpperCase());
        return {
          protocol: 'v4',
          base: b.base,
          baseSymbol: baseSym,
          otherSymbol: otherSym,
          fee: pk.fee,
          tvlUsd: Number(p.tvl) || 0,
          vol24hUsd: p.stats24h?.volume != null ? Number(p.stats24h.volume) : 0,
          vol1hUsd: p.stats1h?.volume != null ? Number(p.stats1h.volume) : 0,
          aprPct: p.stats24h?.apr != null ? Number(p.stats24h.apr) : null,
          otherAddr: b.baseIsCurrency0 ? t1.address : t0.address,
          poolKey: pk,
          baseIsCurrency0: b.baseIsCurrency0,
        };
      }

      if (V3_PROTOCOLS.has(proto)) {
        // Only v3 pools the bot has contracts for: the chain's default DEX, or a listed
        // venue -- uniswapv3 on BSC, say, whose factory differs from PancakeSwap's, so it
        // has to be opened through Uniswap's contracts rather than cc.factory.
        const vn = venueForProtocol(cc, proto);
        if (!vn) return null;
        const vcc = venueCtx(cc, vn.venue);
        const b = baseOfPair(cc, t0.address, t1.address);
        if (!b) return null;
        const fee = Number(p.feeTier);
        // The fee tiers belong to the VENUE: Uniswap has 3000, PancakeSwap 2500.
        if (!vcc.feeTiers.includes(fee)) return null;
        const otherSym = (b.baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
        const baseSym = (b.baseIsCurrency0 ? t0.symbol : t1.symbol) ?? (b.base === 'weth' ? 'ETH' : b.base.toUpperCase());
        return {
          protocol: 'v3',
          base: b.base,
          baseSymbol: baseSym,
          otherSymbol: otherSym,
          fee,
          tvlUsd: Number(p.tvl) || 0,
          vol24hUsd: p.stats24h?.volume != null ? Number(p.stats24h.volume) : 0,
          vol1hUsd: p.stats1h?.volume != null ? Number(p.stats1h.volume) : 0,
          aprPct: p.stats24h?.apr != null ? Number(p.stats24h.apr) : null,
          otherAddr: b.baseIsCurrency0 ? t1.address : t0.address,
          ...(vn.venue ? { venue: vn.venue } : {}),
        };
      }
      return null;
    }),
  );
  return out.filter((p): p is TokenPool => p !== null).sort((a, b) => b.tvlUsd - a.tvlUsd);
}
