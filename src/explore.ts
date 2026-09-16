/**
 * EXPLORE -- top pools by APR, in step with Uniswap itself.
 *
 * The data comes from Uniswap's own gateway (interface.gateway.uniswap.org), the same one
 * behind app.uniswap.org/explore. It takes topV3Pools and topV4Pools, then keeps only the
 * pools the bot can LP single-sided: one side has to be one of our bases. APR is not a
 * field the API returns, so it is computed with Explore's own formula -- one day of fees,
 * annualised, over TVL:
 *
 *   APR = volume1D x (feeTier / 1e6) x 365 / TVL
 *
 * Purely read-only: it touches no wallet and no chain, and failing is safe (it throws and
 * the caller shows an error card).
 */
import { getChain, venueCtx, venuesFor, type BaseKind, type ChainCtx } from './chains.js';
import { gmgnPrice } from './gmgn.js';
import { poolIdV4, v4Supported } from './uniswapV4.js';
import type { PoolKeyV4 } from './uniswapV4.js';
import { ethers } from 'ethers';

const GATEWAY = 'https://interface.gateway.uniswap.org/v1/graphql';

// Our chain key -> the Chain enum name in Uniswap's API.
// These are the chains whose pool lists come from Uniswap's gateway. BSC is absent on
// purpose: positions there are opened on PancakeSwap, and the gateway carries no Pancake
// pools at all. Any chain outside this map uses the DexScreener path below.
const UNISWAP_CHAIN: Record<string, string> = {
  robinhood: 'ROBINHOOD',
  ethereum: 'ETHEREUM',
  base: 'BASE',
  // The gateway accepts ARC as a Chain enum (the query returns data:[] rather than an
  // error), it simply has no Arc pools indexed yet. Listed here so the moment it does,
  // discovery works with no code change -- and until then poolsForToken falls through to
  // the on-chain path on its own, which is the same behaviour as an empty result.
  arc: 'ARC',
};

// Fetch plenty, then filter and sort here: the API sorts by TVL, and we want APR.
const FETCH_N = 100;
// A TVL floor, so a dust pool (a few cents, one swap) cannot fake an APR in the thousands of percent.
const MIN_TVL_USD = 1_000;

export type ExplorePool = {
  ver: string; // 'v4' | 'v3'
  pair: string; // TOKEN/BASE (base ditaruh belakang)
  feeTier: number; // 500 = 0.05%
  tvlUsd: number;
  vol1dUsd: number;
  apr: number; // persen
  otherAddr?: string; // the non-base side's CA, for the "➕ LP <TOKEN>" button
  chain?: string; // the source chain key; REQUIRED once a list mixes several chains
  chainLabel?: string; // label tampilan chain asal
  vol1hUsd?: number; // the 1h volume; undefined means it could not be read
  mcapUsd?: number; // the token side's market cap; undefined means it could not be read
};

type ApiPool = {
  protocolVersion?: string;
  feeTier?: number;
  totalLiquidity?: { value?: number } | null;
  cumulativeVolume?: { value?: number } | null;
  token0?: { symbol?: string; address?: string | null } | null;
  token1?: { symbol?: string; address?: string | null } | null;
};

const POOL_FIELDS = `
    protocolVersion
    feeTier
    totalLiquidity { value }
    cumulativeVolume(duration: DAY) { value }
    token0 { symbol address }
    token1 { symbol address }`;

const QUERY = `query TopPools($chain: Chain!, $n: Int!) {
  topV3Pools(chain: $chain, first: $n) {${POOL_FIELDS}
  }
  topV4Pools(chain: $chain, first: $n) {${POOL_FIELDS}
  }
}`;

/** true when this token is one of the bases the bot can LP single-sided. */
function isBase(sym: string | undefined | null, addr: string | undefined | null, ctx: ChainCtx): boolean {
  const s = (sym ?? '').toUpperCase();
  const a = (addr ?? '').toLowerCase();
  if (ctx.hasWethBase && (s === 'ETH' || s === 'WETH')) return true;
  if (ctx.hasWethBase && a && a === ctx.wethAddress.toLowerCase()) return true;
  // EVERY base this chain carries. Testing WETH and USDG alone made a USDT pair on BSC and
  // a USDC pair on Base read as "not single-sideable", so they never reached the list.
  return ctx.bases.some((b) => (a && a === b.address.toLowerCase()) || (s && s === b.symbol.toUpperCase()));
}

/** The top pools by APR that can be LP'd single-sided (ETH/WETH/USDG), in sync with Uniswap. */
export async function fetchTopPools(
  ctx: ChainCtx = getChain(),
  limit = 5,
): Promise<ExplorePool[]> {
  const chain = UNISWAP_CHAIN[ctx.key];
  if (!chain) return fetchTopPoolsDex(ctx, limit);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let json: any;
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body: JSON.stringify({ query: QUERY, variables: { chain, n: FETCH_N } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  // GraphQL answers partially: on Robinhood every v4 pool returns "external API
  // error" for cumulativeVolume while the pool itself arrives intact. Throwing on a
  // non-empty errors[] discarded 37 good pools on every /add and fell through to the
  // on-chain fallback -- seconds wasted before it even started. Only a response with
  // no usable payload is a real failure; a missing optional field already reads as 0.
  if (json?.errors?.length && !json?.data?.topV3Pools?.length && !json?.data?.topV4Pools?.length)
    throw new Error(json.errors[0]?.message ?? 'gateway error');

  const raw: ApiPool[] = [
    ...(json?.data?.topV3Pools ?? []),
    // v4 only on chains the bot fully supports. Elsewhere a v4 position could be neither
    // monitored nor closed, so it must not be offered as an opportunity.
    ...(v4Supported(ctx) ? (json?.data?.topV4Pools ?? []) : []),
  ];
  const out: ExplorePool[] = [];
  for (const p of raw) {
    const t0 = p.token0,
      t1 = p.token1;
    if (!t0 || !t1) continue;
    // It has to work single-sided: at least one side must be one of our bases.
    const base0 = isBase(t0.symbol, t0.address, ctx);
    const base1 = isBase(t1.symbol, t1.address, ctx);
    if (!base0 && !base1) continue;

    const tvl = p.totalLiquidity?.value ?? 0;
    const vol = p.cumulativeVolume?.value ?? 0;
    const feeTier = p.feeTier ?? 0;
    if (tvl < MIN_TVL_USD || vol <= 0 || feeTier <= 0) continue;

    // aprOf, not a third copy: this path filters at MIN_TVL_USD above, so the shared
    // floor changes nothing here -- but the formula now lives in exactly one place.
    const apr = aprOf(vol, feeTier, tvl) ?? 0;

    // Base ditaruh belakang → baca "TOKEN/BASE".
    const s0 = t0.symbol ?? '?',
      s1 = t1.symbol ?? '?';
    const pair = base0 && !base1 ? `${s1}/${s0}` : `${s0}/${s1}`;
    const otherAddr = base0 && !base1 ? t1.address : base1 && !base0 ? t0.address : undefined;

    out.push({
      ver: (p.protocolVersion ?? 'V4').toLowerCase(),
      pair,
      feeTier,
      tvlUsd: tvl,
      vol1dUsd: vol,
      apr,
      otherAddr: otherAddr ?? undefined,
    });
  }
  out.sort((a, b) => b.apr - a.apr);
  return out.slice(0, limit).map((p) => ({ ...p, chain: ctx.key, chainLabel: ctx.label }));
}

// --- per-token discovery, for /add ---------------------------------

/** Candidate pools for one token, used by the /add wizard. Mirrors app.uniswap.org. */
export type TokenPool = {
  protocol: 'v3' | 'v4';
  base: BaseKind; // the bot's base side: WETH/ETH, USDG or USDT
  baseSymbol: string; // 'ETH' | 'WETH' | 'USDG', exactly as Uniswap reports it
  otherSymbol: string; // simbol token target
  fee: number;
  tvlUsd: number;
  vol24hUsd?: number; // the 24h volume in USD, used for the "largest" ranking and the display
  vol1hUsd?: number; // the 1h volume in USD, from Krystal's stats1h, for the "busy right now" list
  aprPct?: number | null; // 24h fees annualised; null means the volume could not be read
  otherAddr?: string; // the token side's address, which the "Add LP" button needs in a cross-chain list
  venue?: string; // a non-default DEX on the chain ('uniswapv3' on BSC); empty means the default
  poolKey?: PoolKeyV4; // v4 saja — currency0/1, fee, tickSpacing, hooks
  baseIsCurrency0?: boolean; // v4 saja
};

// Query the pools for one token, v3 and v4, through tokenFilter: exactly Explore's own source.
const TOKEN_POOL_FIELDS = `
    protocolVersion
    feeTier
    totalLiquidity { value }
    cumulativeVolume(duration: DAY) { value }
    token0 { symbol address }
    token1 { symbol address }`;
const V4_ONLY_QUERY = `query V4PoolsForToken($chain: Chain!, $n: Int!, $t: String!) {
  topV4Pools(chain: $chain, first: $n, tokenFilter: $t) {${TOKEN_POOL_FIELDS}
    tickSpacing
    hook { address }
  }
}`;
const TOKEN_QUERY = `query PoolsForToken($chain: Chain!, $n: Int!, $t: String!) {
  topV3Pools(chain: $chain, first: $n, tokenFilter: $t) {${TOKEN_POOL_FIELDS}
  }
  topV4Pools(chain: $chain, first: $n, tokenFilter: $t) {${TOKEN_POOL_FIELDS}
    tickSpacing
    hook { address }
  }
}`;

/**
 * Chains where Uniswap is NOT the default venue, yet its v4 pools still exist and are
 * worth offering. The value is the gateway's own Chain enum.
 */
const UNISWAP_V4_ONLY_CHAIN: Record<string, string> = { bsc: 'BNB' };

/** The gateway's v4 pools for one token, mapped like the main path maps them. */
async function gatewayV4Pools(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  const chain = UNISWAP_V4_ONLY_CHAIN[ctx.key];
  if (!chain) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body: JSON.stringify({ query: V4_ONLY_QUERY, variables: { chain, n: 40, t: token } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const json: any = await res.json();
    const out: TokenPool[] = [];
    for (const p of json?.data?.topV4Pools ?? []) {
      const t0 = p.token0, t1 = p.token1;
      if (!t0 || !t1) continue;
      const b0 = baseKindOf(t0.symbol, t0.address, ctx);
      const b1 = baseKindOf(t1.symbol, t1.address, ctx);
      if ((b0 && b1) || (!b0 && !b1)) continue; // single-sided needs exactly one base side
      if (p.hook?.address && p.hook.address !== '0x0000000000000000000000000000000000000000') continue; // hooked pools are not handed to an automatic LP
      const fee = p.feeTier ?? 0;
      if (fee <= 0) continue;
      const baseIsCurrency0 = !!b0;
      const vol = p.cumulativeVolume?.value ?? 0;
      const tvl = p.totalLiquidity?.value ?? 0;
      out.push({
        protocol: 'v4',
        base: (b0 ?? b1)!,
        baseSymbol: (baseIsCurrency0 ? t0.symbol : t1.symbol) ?? ctx.bases.find((b) => b.kind === (b0 ?? b1))?.symbol ?? 'BASE',
        otherSymbol: (baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?',
        fee,
        tvlUsd: tvl,
        vol24hUsd: vol,
        aprPct: aprOf(vol, fee, tvl),
        otherAddr: baseIsCurrency0 ? t1.address : t0.address,
        baseIsCurrency0,
        poolKey: {
          currency0: t0.address,
          currency1: t1.address,
          fee,
          tickSpacing: Number(p.tickSpacing ?? 0),
          hooks: p.hook?.address ?? '0x0000000000000000000000000000000000000000',
        },
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** A pool token's base side, matched against THIS chain's base list
 *  (WETH/WBNB, USDG, USDT). null means it is not a base asset. */
export const baseKindOf = (
  sym: string | null | undefined,
  addr: string | null | undefined,
  ctx: ChainCtx,
): BaseKind | null => {
  const s = (sym ?? '').toUpperCase();
  const a = (addr ?? '').toLowerCase();
  // ADDRESS decides. A symbol is a string anyone can choose: 'UpSideDownCat' on Arc calls
  // itself USDC with 18 decimals against the real USDC's 6, and matching on the symbol made
  // it read as a BASE -- so its pool looked like base/base and was silently dropped from
  // /add. Right answer, wrong reason. Now an impersonator is treated as the ordinary token
  // it is, and the pool is offered or refused on its own merits.
  if (a) {
    for (const b of ctx.bases) if (a === b.address.toLowerCase()) return b.kind;
    // Native ETH arrives as currency 0x0 in v4, with no address of its own to match.
    return a === '0x0000000000000000000000000000000000000000' && ctx.hasWethBase ? 'weth' : null;
  }
  // No address at all (an indexer that returned only a symbol): fall back to the name, which
  // is the best available and no worse than before.
  for (const b of ctx.bases) if (s && s === b.symbol.toUpperCase()) return b.kind;
  if (s === 'ETH' && ctx.hasWethBase) return 'weth';
  return null;
};

/**
 * Every pool (v3 and v4) holding `token` that can be LP'd single-sided -- one side has to
 * be a base -- sorted by TVL descending. A direct mirror of app.uniswap.org.
 *
 * v4 pools WITH HOOKS are skipped: a hook can change the fee or the behaviour, which is
 * not something to hand an automatic LP. Throws when the gateway fails, so the caller can
 * fall back to on-chain v3 discovery.
 */
export async function poolsForToken(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  const chain = UNISWAP_CHAIN[ctx.key];
  if (!chain) {
    // A chain whose default venue is NOT Uniswap (BSC, where it is PancakeSwap) is
    // discovered through DexScreener plus the chain itself. That path cannot see Uniswap
    // v4 pools: DexScreener only labels some of them, and the on-chain v4 scan takes its
    // candidates from DexScreener too. Measured 15 Sep 2026 -- CAKE has two v4 pools on
    // BSC holding $29k and $6k that were invisible to every source the bot had.
    //
    // So the gateway is asked for v4 ONLY, and merged in. v3 is deliberately left out of
    // this query: on BSC a Uniswap v3 pool and a PancakeSwap pool can share base and fee,
    // and the merge in /add keys v3 on (venue, base, fee) -- gateway rows carry no venue,
    // so they would collide with Pancake's and one of the two would vanish.
    const [dex, v4] = await Promise.all([
      poolsForTokenDex(ctx, token),
      UNISWAP_V4_ONLY_CHAIN[ctx.key] ? gatewayV4Pools(ctx, token).catch(() => []) : Promise.resolve([]),
    ]);
    // gatewayV4Pools leans on the same index that was blind to every Arc v4 pool, and
    // poolsForTokenDex is v3-only (it enumerates through factory.getPool, which v4 has
    // no equivalent of). Without this backstop a chain with v4 contracts can still show
    // a token's dust v3 pool while its real liquidity sits in v4, unseen.
    const v4dex = v4.length || !v4Supported(ctx) ? [] : await dexV4Pools(ctx, token).catch(() => []);
    return [...dex, ...v4, ...v4dex];
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let json: any;
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body: JSON.stringify({ query: TOKEN_QUERY, variables: { chain, n: 40, t: token } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  // GraphQL answers partially: on Robinhood every v4 pool returns "external API
  // error" for cumulativeVolume while the pool itself arrives intact. Throwing on a
  // non-empty errors[] discarded 37 good pools on every /add and fell through to the
  // on-chain fallback -- seconds wasted before it even started. Only a response with
  // no usable payload is a real failure; a missing optional field already reads as 0.
  if (json?.errors?.length && !json?.data?.topV3Pools?.length && !json?.data?.topV4Pools?.length)
    throw new Error(json.errors[0]?.message ?? 'gateway error');

  const out: TokenPool[] = [];
  const push = (p: ApiPool & { tickSpacing?: number; hook?: { address?: string } | null }, protocol: 'v3' | 'v4') => {
    const t0 = p.token0,
      t1 = p.token1;
    if (!t0 || !t1) return;
    const b0 = baseKindOf(t0.symbol, t0.address, ctx);
    const b1 = baseKindOf(t1.symbol, t1.address, ctx);
    // EXACTLY one base side is required for single-sided entry; skip base/base and non-base pairs.
    if ((b0 && b1) || (!b0 && !b1)) return;
    const fee = p.feeTier ?? 0;
    const tvl = p.totalLiquidity?.value ?? 0;
    if (fee <= 0) return;
    if (protocol === 'v4' && p.hook) return; // ber-hook → skip (aman)
    // v4 only where the bot fully supports it. Elsewhere the gateway still returns v4
    // pools, but a position opened in one could never be monitored or closed -- so do not
    // offer it at all.
    if (protocol === 'v4' && !v4Supported(ctx)) return;

    const baseIsCurrency0 = !!b0;
    const base = (b0 ?? b1)!;
    // The fallback symbol comes from the CHAIN's own base list, so a missing symbol on a
    // USDT or USDC pair does not silently read as 'USDG' or 'ETH'.
    const fallbackSym = ctx.bases.find((b) => b.kind === base)?.symbol ?? 'BASE';
    const baseSymbol = (baseIsCurrency0 ? t0.symbol : t1.symbol) ?? fallbackSym;
    const otherSymbol = (baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
    // APR is 24h fees annualised. Through aprOf, not a second copy of the formula: the
    // copy here kept its own `tvl > 0` test and went on printing nine-digit APRs after
    // the shared one was given a floor.
    const vol = p.cumulativeVolume?.value ?? 0;
    const aprPct = aprOf(vol, fee, tvl);
    const tp: TokenPool = { protocol, base, baseSymbol, otherSymbol, fee, tvlUsd: tvl, vol24hUsd: vol, aprPct };
    if (protocol === 'v4') {
      tp.poolKey = {
        currency0: t0.address ?? ethers.ZeroAddress, // ETH native = null → 0x0
        currency1: t1.address ?? ethers.ZeroAddress,
        fee,
        tickSpacing: p.tickSpacing ?? 0,
        hooks: ethers.ZeroAddress,
      };
      tp.baseIsCurrency0 = baseIsCurrency0;
      if (!tp.poolKey.tickSpacing) return; // without a tickSpacing it cannot be opened
    }
    out.push(tp);
  };
  for (const p of json?.data?.topV3Pools ?? []) push(p, 'v3');
  for (const p of json?.data?.topV4Pools ?? []) push(p, 'v4');
  // The gateway can know a chain's v3 pools and none of its v4 ones (Arc, 17 Sep 2026:
  // one dust v3 pool returned while a $52k v4 pool with $974k daily volume was missing).
  // Testing for an empty result would miss exactly that case, so test for no V4.
  if (!out.some((p) => p.protocol === 'v4')) {
    const v4 = await dexV4Pools(ctx, token).catch(() => []);
    out.push(...v4);
  }
  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return out;
}

// ─── the alternative source: DexScreener, for chains with no Uniswap gateway ──
//
// DexScreener gives liquidity and 24h volume per PAIR, but no fee tier. The fee is read
// from the pool on chain, which doubles as proof that the pool really belongs to this
// chain's factory -- a fork has different pool addresses for the same pair. So the numbers
// a position is opened on still come from the chain itself.

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
const ERC20_SYM_ABI = ['function symbol() view returns (string)'];
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];

/** This chain's wrapped-native price in USD, for valuing the base side. null when unread. */
async function getBaseUsd(ctx: ChainCtx): Promise<number | null> {
  const { getEthUsd } = await import('./screening.js');
  return getEthUsd(ctx.wethAddress, ctx).catch(() => null);
}
const POOL_META_ABI = [
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

type DexPair = {
  pairAddress: string;
  liquidityUsd: number;
  vol24hUsd: number;
  vol1hUsd?: number;
  /** lowercase address -> symbol. DexScreener has its own idea of base and quote, which
   *  does not always match the pool's token0/token1 order -- so symbols must be matched by
   *  address, never by position. */
  symByAddr: Record<string, string>;
};

/**
 * TVL and 24h volume for ONE v4 pool, from DexScreener.
 *
 * The Uniswap gateway indexes v4 on Robinhood only partially: topV4Pools comes back empty
 * for tokens that plainly have live v4 pools, which is why the detail card read "TVL: —"
 * and "Volume: —" on a position that was earning fees. DexScreener does carry them, and
 * its pairAddress for a v4 pair IS the pool id, so the match is exact rather than by
 * fee/symbol guesswork. null when the pool is not there either.
 */
export async function poolStatsV4Dex(
  ctx: ChainCtx,
  tokenAddress: string,
  poolId: string,
): Promise<{ tvlUsd: number; vol24hUsd?: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${DEXSCREENER_TOKENS}/${tokenAddress}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json: any = await res.json();
    const want = poolId.toLowerCase();
    const hit = (json?.pairs ?? []).find(
      (p: any) => p?.chainId === ctx.dexKey && String(p?.pairAddress ?? '').toLowerCase() === want,
    );
    if (!hit) return null;
    const tvl = Number(hit?.liquidity?.usd ?? 0);
    const vol = Number(hit?.volume?.h24 ?? 0);
    return { tvlUsd: tvl, vol24hUsd: vol > 0 ? vol : undefined };
  } catch {
    return null; // a stats line is never worth failing a card over
  } finally {
    clearTimeout(timer);
  }
}

/**
 * USD price for MANY tokens in one call, keyed by lowercase address.
 *
 * DexScreener takes up to 30 comma-separated addresses, and the deepest pool on the chain
 * decides the price -- a token's own dust pool must not be allowed to name its value. Used
 * by /swap to tell a real holding from the airdrop spam that lands in every wallet.
 */
export async function tokenUsdPrices(ctx: ChainCtx, addresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  for (let i = 0; i < uniq.length; i += 30) {
    const batch = uniq.slice(i, i + 30);
    const j = await fetch(`${DEXSCREENER_TOKENS}/${batch.join(',')}`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const deepest = new Map<string, number>();
    for (const p of (j as any)?.pairs ?? []) {
      if (p?.chainId !== ctx.dexKey) continue;
      const ca = String(p?.baseToken?.address ?? '').toLowerCase();
      const px = Number(p?.priceUsd ?? 0);
      const liq = Number(p?.liquidity?.usd ?? 0);
      if (!ca || !(px > 0)) continue;
      if (liq >= (deepest.get(ca) ?? -1)) {
        deepest.set(ca, liq);
        out.set(ca, px);
      }
    }
  }
  return out;
}

async function dexPairs(ctx: ChainCtx, tokenAddress: string): Promise<DexPair[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let json: any;
  try {
    const res = await fetch(`${DEXSCREENER_TOKENS}/${tokenAddress}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const out: DexPair[] = [];
  for (const p of json?.pairs ?? []) {
    if (p?.chainId !== ctx.dexKey) continue;
    if (!(p?.labels ?? []).includes('v3')) continue; // v2 has no range, so it cannot be single-sided
    // liquidity.usd is allowed to be empty: DexScreener sometimes leaves it out for a
    // perfectly real v3 pool. Dropping those here once made existing pools report as
    // "no pool found".
    const liq = Number(p?.liquidity?.usd ?? 0);
    if (!p.pairAddress) continue;
    const symByAddr: Record<string, string> = {};
    for (const t of [p?.baseToken, p?.quoteToken]) {
      if (t?.address) symByAddr[String(t.address).toLowerCase()] = t.symbol ?? '?';
    }
    out.push({
      pairAddress: p.pairAddress,
      liquidityUsd: liq,
      vol24hUsd: Number(p?.volume?.h24 ?? 0),
      vol1hUsd: Number(p?.volume?.h1 ?? 0),
      symByAddr,
    });
  }
  return out;
}

/**
 * v4 pools discovered through DexScreener, for chains the Uniswap gateway does not index.
 *
 * DexScreener lists a v4 pool by its POOL ID, which is keccak(abi.encode(PoolKey)) -- an
 * identifier, not an address, and not invertible. But the key has only two unknowns once
 * the pair is known: the fee and the tick spacing. Hashing the plausible combinations and
 * matching the result against the listed id recovers the whole PoolKey, which is what
 * opening a position needs.
 *
 * It only works for pools with NO hook: a hook address is 160 bits and cannot be guessed.
 * That costs nothing here, because hooked pools are skipped anyway.
 *
 * Found on Arc, 17 Sep 2026: a token whose liquidity sat in v4 showed ONE dust v3 pool in
 * /add while a $52k v4 pool with $974k daily volume was invisible to every source.
 */
const V4_FEE_TIERS = [100, 500, 2500, 3000, 4000, 5000, 10000, 20000, 30000, 50000, 100000];
/** The spacings Uniswap's own deployments pair with those fees, plus the fee/50 rule. */
const V4_SPACINGS = [1, 2, 5, 10, 20, 30, 50, 60, 100, 120, 200, 500, 1000, 2000];

async function dexV4Pools(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  let pairs: Array<{ id: string; liq: number; vol: number; sym: Record<string, string> }> = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let json: any;
    try {
      const res = await fetch(`${DEXSCREENER_TOKENS}/${token}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`dexscreener ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }
    for (const p of json?.pairs ?? []) {
      if (p?.chainId !== ctx.dexKey) continue;
      if (!(p?.labels ?? []).includes('v4')) continue;
      if (!p.pairAddress) continue;
      const sym: Record<string, string> = {};
      for (const t of [p?.baseToken, p?.quoteToken]) if (t?.address) sym[String(t.address).toLowerCase()] = t.symbol ?? '?';
      pairs.push({ id: String(p.pairAddress).toLowerCase(), liq: Number(p?.liquidity?.usd ?? 0), vol: Number(p?.volume?.h24 ?? 0), sym });
    }
  } catch {
    return []; // no DexScreener, no v4 discovery -- the other sources still run
  }
  if (!pairs.length) return [];

  const byId = new Map(pairs.map((p) => [p.id, p]));
  const out: TokenPool[] = [];
  const tl = token.toLowerCase();
  for (const base of ctx.bases) {
    const bl = base.address.toLowerCase();
    const [c0, c1] = [tl, bl].sort();
    const baseIsCurrency0 = c0 === bl;
    for (const fee of V4_FEE_TIERS) {
      // fee/50 is the rule Uniswap's own pools follow; the list covers the rest.
      for (const tickSpacing of new Set([...V4_SPACINGS, Math.round(fee / 50)])) {
        if (!(tickSpacing > 0)) continue;
        const poolKey = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: ethers.ZeroAddress };
        const hit = byId.get(poolIdV4(poolKey as any).toLowerCase());
        if (!hit) continue;
        out.push({
          protocol: 'v4',
          base: base.kind,
          baseSymbol: base.symbol,
          otherSymbol: hit.sym[tl] ?? '?',
          fee,
          tvlUsd: hit.liq,
          vol24hUsd: hit.vol,
          aprPct: aprOf(hit.vol, fee, hit.liq),
          poolKey,
          baseIsCurrency0,
        });
      }
    }
  }
  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return out;
}

/** Read the pool's fee and pair on chain, and PROVE it belongs to this chain's factory. */
async function verifyPool(
  pairAddress: string,
  ctx: ChainCtx,
): Promise<{ fee: number; token0: string; token1: string } | null> {
  try {
    const c = new ethers.Contract(pairAddress, POOL_META_ABI, ctx.provider);
    const [fee, token0, token1] = await Promise.all([c.fee(), c.token0(), c.token1()]);
    const feeNum = Number(fee);
    if (!ctx.feeTiers.includes(feeNum)) return null;
    const expect: string = await ctx.factory.getPool(token0, token1, feeNum);
    if (expect.toLowerCase() !== pairAddress.toLowerCase()) return null; // a pool on another DEX
    return { fee: feeNum, token0, token1 };
  } catch {
    return null;
  }
}

/**
 * The smallest TVL an APR may be divided by. Below this the figure is not a yield, it is
 * an artefact of the denominator: a pool holding a fraction of a cent with one $12 trade
 * through it reported ~373,403,973%, which is arithmetic, not an opportunity. Such a pool
 * also cannot absorb a deposit, so there is nothing the number could inform.
 */
const MIN_TVL_FOR_APR = 100;

export const aprOf = (vol24h: number, fee: number, tvl: number): number | null =>
  tvl >= MIN_TVL_FOR_APR && vol24h > 0 ? ((vol24h * (fee / 1e6) * 365) / tvl) * 100 : null;

/**
 * Pools for one token on a chain with no Uniswap gateway.
 *
 * The PRIMARY source is the on-chain factory (getPool per base, per fee tier), not
 * DexScreener: it demonstrably returns valid v3 pairs with `liquidity: undefined` (the
 * 黄金时代/USDT token did), and filtering those out reported existing pools as missing.
 * DexScreener is used only to fill in 24h volume so an APR can be computed.
 */
async function poolsForTokenDex(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  // Per-pool volume, best effort: a failure here must never drop the pool.
  const volByPool = new Map<string, number>();
  const symByAddr: Record<string, string> = {};
  try {
    for (const p of await dexPairs(ctx, token)) {
      volByPool.set(p.pairAddress.toLowerCase(), p.vol24hUsd);
      Object.assign(symByAddr, p.symByAddr);
    }
  } catch {
    /* without DexScreener the pools are still found; only their APR reads '?' */
  }

  const tokenC = new ethers.Contract(token, ERC20_SYM_ABI, ctx.provider);
  const otherSymbol = symByAddr[token.toLowerCase()] ?? (await tokenC.symbol().catch(() => '?'));
  const nativeUsd = await getBaseUsd(ctx);

  // Sweep EVERY DEX the bot has contracts for on this chain: the default one, plus each
  // venue. Without this, only PancakeSwap was visible on BSC even though Uniswap v3 also
  // runs there with its own factory -- and for some tokens Uniswap is the only one with a
  // pool at all.
  const venues: Array<string | undefined> = [undefined, ...venuesFor(ctx.key)];
  const found = await Promise.all(
    venues.flatMap((venue) => {
      const vctx = venueCtx(ctx, venue);
      return vctx.bases.flatMap((base) =>
        vctx.feeTiers.map(async (fee): Promise<TokenPool | null> => {
          try {
            const pool: string = await vctx.factory.getPool(base.address, token, fee);
            if (!pool || pool === ethers.ZeroAddress) return null;
            const baseC = new ethers.Contract(base.address, ERC20_BAL_ABI, vctx.provider);
            const reserve: bigint = await baseC.balanceOf(pool);
            if (reserve <= 0n) return null; // the pool is listed but empty
            const amt = Number(ethers.formatUnits(reserve, base.decimals));
            // TVL is roughly 2x the base side, since a pool balances by value. A stablecoin is $1.
            const usdPerBase = base.kind === 'weth' ? nativeUsd : 1;
            const tvlUsd = usdPerBase !== null ? amt * usdPerBase * 2 : 0;
            const vol = volByPool.get(pool.toLowerCase()) ?? 0;
            return {
              protocol: 'v3',
              base: base.kind,
              baseSymbol: base.symbol,
              otherSymbol: String(otherSymbol),
              fee,
              tvlUsd,
              vol24hUsd: vol,
              aprPct: aprOf(vol, fee, tvlUsd),
              ...(venue ? { venue } : {}),
            };
          } catch {
            return null;
          }
        }),
      );
    }),
  );
  const out = found.filter((p): p is TokenPool => p !== null);
  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return out;
}

/** A chain's top pools by APR via DexScreener: the deepest pair for each base asset. */
async function fetchTopPoolsDex(ctx: ChainCtx, limit: number): Promise<ExplorePool[]> {
  const lists = await Promise.all(ctx.bases.map((b) => dexPairs(ctx, b.address).catch(() => [])));
  const seen = new Set<string>();
  const cand = lists
    .flat()
    .filter((p) => (seen.has(p.pairAddress.toLowerCase()) ? false : seen.add(p.pairAddress.toLowerCase())))
    .filter((p) => p.liquidityUsd >= MIN_TVL_USD && p.vol24hUsd > 0)
    // Sorted by 24h volume rather than liquidity: the deepest pool on BSC is always
    // USDT/WBNB, so sorting by liquidity fills the list with stablecoins and the tokens
    // actually being traded never reach the candidates.
    .sort((a, b) => b.vol24hUsd - a.vol24hUsd)
    .slice(0, 25); // cap how many are verified on-chain
  const pools: ExplorePool[] = [];
  await Promise.all(
    cand.map(async (p) => {
      const v = await verifyPool(p.pairAddress, ctx);
      if (!v) return;
      const b0 = baseKindOf(null, v.token0, ctx);
      const b1 = baseKindOf(null, v.token1, ctx);
      if (!b0 && !b1) return;
      const apr = aprOf(p.vol24hUsd, v.fee, p.liquidityUsd);
      if (apr === null) return;
      const bothBase = !!b0 && !!b1;
      const otherAddr = bothBase ? undefined : b0 ? v.token1 : v.token0;
      const symOf = (a: string) => p.symByAddr[a.toLowerCase()] ?? '?';
      // The base goes LAST so it reads "TOKEN/BASE", just as the gateway path does.
      const pair = bothBase
        ? `${symOf(v.token0)}/${symOf(v.token1)}`
        : b0
          ? `${symOf(v.token1)}/${symOf(v.token0)}`
          : `${symOf(v.token0)}/${symOf(v.token1)}`;
      pools.push({
        ver: 'v3',
        pair,
        feeTier: v.fee,
        tvlUsd: p.liquidityUsd,
        vol1dUsd: p.vol24hUsd,
        vol1hUsd: p.vol1hUsd,
        apr,
        otherAddr,
      });
    }),
  );
  pools.sort((a, b) => b.apr - a.apr);
  return pools.slice(0, limit).map((p) => ({ ...p, chain: ctx.key, chainLabel: ctx.label }));
}

// --- market cap, for translating a price range into an mcap range ---------

const mcapCache = new Map<string, { t: number; v: number | null }>();
// 30 seconds, down from 120. The main position-card path now derives market cap from the
// pool price it reads on every refresh, so this cache only serves the fallback path and
// token exploration -- where two minutes is too stale for a fast-moving token.
const MCAP_TTL_MS = 30_000;

/**
 * A token's market cap from DexScreener. null means unread -- never 0, which reads as the
 * fact that the token is worthless. Cached briefly: a position card can be refreshed many
 * times and the market cap does not move that fast.
 */
export async function tokenMarketCap(ctx: ChainCtx, token: string): Promise<number | null> {
  const key = `${ctx.dexKey}:${token.toLowerCase()}`;
  const hit = mcapCache.get(key);
  if (hit && Date.now() - hit.t < MCAP_TTL_MS) return hit.v;
  let v: number | null = null;
  try {
    const res = await fetch(`${DEXSCREENER_TOKENS}/${token}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const j: any = await res.json();
      for (const p of j?.pairs ?? []) {
        if (p?.chainId !== ctx.dexKey) continue;
        const n = Number(p?.marketCap ?? p?.fdv ?? NaN);
        if (Number.isFinite(n) && n > 0) {
          v = n;
          break;
        }
      }
    }
  } catch {
    /* a failure returns null and the card prints '?' */
  }
  // FALLBACK: when DexScreener is empty or down, GMGN (mcap = price x supply).
  if (v === null) {
    const g = await gmgnPrice(token, ctx.key).catch(() => null);
    if (g && g.mcapUsd && g.mcapUsd > 0) v = g.mcapUsd;
  }
  mcapCache.set(key, { t: Date.now(), v });
  return v;
}

/** A compact USD figure: $1.2M / $340K / $820. */
export function usdShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
