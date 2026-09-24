/**
 * GeckoTerminal: the complete pool index, and the token-stats fallback.
 *
 * Why it is the pool source (measured 23 Sep 2026, six tokens on BSC and Robinhood): it
 * answered in ~0.6s and named 9-20 pools per token, where Krystal's own list named 2-4 and
 * missed the biggest ones outright ($GPU/USDT 7.55% at $16K TVL, $GPU/BNB 10% at $6K). A v4
 * pool it finds still needs a poolKey to be opened; that comes from Krystal's DETAIL
 * endpoint, which answers for pools its list never names (krystal.v4KeyFor).
 *
 * Rate limit: the free tier is ~30 calls a minute but refuses short bursts sooner. So a
 * 429 benches the source for a minute and every caller falls back (Krystal for pools, the
 * GMGN/DexScreener path for stats) instead of hammering it. Cache is 3s, the owner's call:
 * fresh numbers on every tap, only a double-tap is served twice.
 */
import { ethers } from 'ethers';
import type { ChainCtx } from './chains.js';
import type { TokenPool } from './explore.js';
import { v4Supported } from './uniswapV4.js';
import { baseOfPair, v4KeyFor } from './krystal.js';

const API = 'https://api.geckoterminal.com/api/v2';
const NET: Record<string, string> = { robinhood: 'robinhood', bsc: 'bsc', base: 'base', hyperevm: 'hyperevm', arc: 'arc', ink: 'ink' };
const CACHE_MS = 3_000;
const BENCH_MS = 60_000;
/** v4 keys resolved per token, deepest first: each is a Krystal call the first time. */
const MAX_V4_KEYS = 8;

let benchedUntil = 0;
const cache = new Map<string, { t: number; v: any }>();

async function get(path: string): Promise<any | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  if (Date.now() < benchedUntil) return null;
  const ctrl = new AbortController();
  // 3s: past that the fallback is faster than waiting (a 5s BSC stall was measured).
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (r.status === 429) {
      benchedUntil = Date.now() + BENCH_MS;
      console.log('[gecko] rate limited, using the fallback for 60s');
      return null;
    }
    if (!r.ok) return null;
    const v = await r.json();
    cache.set(path, { t: Date.now(), v });
    return v;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const addrOf = (id: string | undefined): string => {
  const a = String(id ?? '').split('_').pop() ?? '';
  // Native coin in a v4 pool: GeckoTerminal may write it as 0xeeee…; v4 itself uses 0x0.
  return /^0xe{40}$/i.test(a) ? ethers.ZeroAddress : a;
};

/** "GPU / USDT 7.55%" -> 75500 (hundredths of a bip, the unit poolKey.fee uses). */
const feeOf = (name: string): number | null => {
  const m = /([\d.]+)%\s*$/.exec(name);
  return m ? Math.round(Number(m[1]) * 10_000) : null;
};

/**
 * Pools for `token` that this bot can LP in: Uniswap v4 where the chain has a v4
 * PositionManager, and the chain's own v3 DEX (plus Uniswap v3 on BSC), paired with one of
 * the chain's bases. v4 pools carry a verified poolKey when Krystal could resolve it; the
 * rest are listed without one (fine for a card, filtered out by /add). Null when
 * GeckoTerminal did not answer, so the caller knows to fall back.
 */
export async function geckoPools(cc: ChainCtx, token: string, opts: { keys?: boolean; maxKeys?: number } = {}): Promise<TokenPool[] | null> {
  const net = NET[cc.key];
  if (!net) return null;
  const j = await get(`/networks/${net}/tokens/${token.toLowerCase()}/pools?page=1&include=dex`);
  if (!j?.data) return null;
  const dexLabel = cc.dexLabel.toLowerCase();
  const out: TokenPool[] = [];
  for (const p of j.data as any[]) {
    const a = p.attributes ?? {};
    const r = p.relationships ?? {};
    const dex = String(r.dex?.data?.id ?? '').toLowerCase();
    if (/v2|infinity/.test(dex)) continue;
    const isV4 = dex.includes('uniswap') && dex.includes('v4');
    let venue: string | undefined;
    if (isV4) {
      if (!v4Supported(cc)) continue;
    } else if (dex.includes(dexLabel)) {
      venue = undefined; // the chain's default v3 DEX
    } else if (cc.key === 'bsc' && dex.includes('uniswap')) {
      venue = 'uniswapv3';
    } else continue;
    const t0 = addrOf(r.base_token?.data?.id);
    const t1 = addrOf(r.quote_token?.data?.id);
    const b = baseOfPair(cc, t0, t1);
    if (!b) continue;
    const tokenIsT0 = t0.toLowerCase() === token.toLowerCase();
    if (!tokenIsT0 && t1.toLowerCase() !== token.toLowerCase()) continue;
    const name = String(a.name ?? '');
    const [n0, n1] = name.replace(/\s[\d.]+%$/, '').split(' / ');
    const tvl = Number(a.reserve_in_usd ?? 0);
    const vol = Number(a.volume_usd?.h24 ?? 0);
    const fee = feeOf(name) ?? 0;
    const baseSide = (b.baseIsCurrency0 ? t0 : t1).toLowerCase() === t0.toLowerCase() ? n0 : n1;
    out.push({
      protocol: isV4 ? 'v4' : 'v3',
      base: b.base,
      baseSymbol: baseSide ?? '?',
      otherSymbol: (tokenIsT0 ? n0 : n1) ?? '?',
      fee,
      tvlUsd: tvl,
      vol24hUsd: vol,
      // 24h fees annualised, the same definition the other sources use.
      aprPct: tvl > 0 && fee > 0 ? ((vol * (fee / 1_000_000)) / tvl) * 365 * 100 : null,
      otherAddr: token,
      venue,
      // Resolved below for v4; the pool address stands in until then.
      ...(isV4 ? { poolKey: undefined } : {}),
      _poolId: String(a.address ?? ''),
      _tokens: [t0, t1],
      _created: a.pool_created_at ?? undefined,
    } as TokenPool & { _poolId: string; _tokens: string[]; _created?: string });
  }
  out.sort((x, y) => y.tvlUsd - x.tvlUsd);
  // A card only shows pools; resolving keys there would cost seconds for nothing.
  if (opts.keys === false) return out;
  // poolKeys for the deepest v4 pools only: the rest would never be picked, and each first
  // resolution costs a Krystal call.
  const v4 = out.filter((p) => p.protocol === 'v4' && p.tvlUsd >= 500).slice(0, opts.maxKeys ?? MAX_V4_KEYS) as Array<TokenPool & { _poolId: string; _tokens: string[]; _created?: string }>;
  await Promise.all(
    v4.map(async (p) => {
      const pk = await v4KeyFor(cc, p._poolId, p._tokens[0], p._tokens[1], p._created).catch(() => null);
      if (!pk) return;
      p.poolKey = pk;
      p.fee = pk.fee;
      p.baseIsCurrency0 = baseOfPair(cc, pk.currency0, pk.currency1)?.baseIsCurrency0;
    }),
  );
  return out;
}

export type TokenStats = { name: string | null; priceUsd: number | null; mcapUsd: number | null; liquidityUsd: number | null; vol24hUsd: number | null; ageHours: number | null };

/** Token stats from GeckoTerminal, for when GMGN cannot answer. */
export async function geckoTokenStats(cc: ChainCtx, token: string): Promise<TokenStats | null> {
  const net = NET[cc.key];
  if (!net) return null;
  const j = await get(`/networks/${net}/tokens/${token.toLowerCase()}`);
  const a = j?.data?.attributes;
  if (!a) return null;
  const n = (v: unknown) => (v == null || !isFinite(Number(v)) ? null : Number(v));
  return {
    name: a.name ?? null,
    priceUsd: n(a.price_usd),
    mcapUsd: n(a.market_cap_usd) ?? n(a.fdv_usd),
    liquidityUsd: n(a.total_reserve_in_usd),
    vol24hUsd: n(a.volume_usd?.h24),
    ageHours: null,
  };
}
