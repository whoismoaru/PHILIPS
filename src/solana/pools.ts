/**
 * Solana token facts and its Meteora DLMM pools, from DexScreener plus one chain read.
 *
 * Scope is deliberately narrow and matches how the wallet actually trades: DLMM only. A
 * survey of 1000 transactions found 133 LP positions opened, every one of them on the DLMM
 * program; DAMM v2, Orca and Raydium appeared 15 times and only ever as Jupiter swap
 * routing, never as liquidity. Filtering to DLMM therefore throws away nothing that is
 * used.
 *
 * Because it throws pools away, this module reports WHY a token has no pools. "No DLMM
 * pool" and "no such token" look identical on a card and mean opposite things: the first
 * is a live token we cannot serve yet, the second is a dead address. Two BSC tokens asked
 * about earlier were exactly the first case, and a card saying "not found" would have been
 * a lie.
 *
 * Bin step and base fee come from the pool account (see lbpair.ts) because DexScreener
 * does not carry them and Meteora's own API now answers 404. Without an RPC they are null
 * and the card must say the endpoint is missing rather than print '?', which would read as
 * "the data is unavailable" instead of "you have not configured this".
 */
import { aprOf } from '../explore.js';
import { isSolAddress } from './addr.js';
import { baseOfMint } from './bases.js';
import { lbPair } from './lbpair.js';
import { rpcUrl } from './rpc.js';

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';

export type DlmmPool = {
  pairAddress: string;
  /** The asset paired against the pasted token: what would actually be deposited. */
  baseMint: string;
  baseSymbol: string;
  tokenSymbol: string;
  liquidityUsd: number;
  vol24hUsd: number;
  /** null when no SOLANA_RPC_URL is configured; the card must say so. */
  binStep: number | null;
  baseFeePct: number | null;
  aprPct: number | null;
};

export type SolTokenFacts = {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: string | null;
  /** The same price in the pair's QUOTE asset. With a SOL-quoted pair the two together
   *  give the SOL price, which is the only way a Solana row reaches dollars at all. */
  priceNative: string | null;
  /** The quote mint the price above is denominated in. */
  quoteMint: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  pairAgeHours: number | null;
};

export type SolTokenView = {
  facts: SolTokenFacts | null;
  pools: DlmmPool[];
  /** Pairs that exist but are out of scope, so the card can say "no DLMM" not "not found". */
  otherVenueCount: number;
  /** DLMM pools quoted in something other than SOL or USDC. */
  offBaseCount: number;
  /** True when bin step and fee could not be read because no RPC is configured. */
  chainReadSkipped: boolean;
};

async function fetchPairs(mint: string): Promise<any[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // The mint goes into the URL EXACTLY as given. Base58 is case-sensitive; normalising
    // it here would look harmless and quietly ask about a different token.
    const res = await fetch(`${DEXSCREENER_TOKENS}/${mint}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const j = (await res.json()) as { pairs?: any[] };
    return (j?.pairs ?? []).filter((p) => p?.chainId === 'solana');
  } finally {
    clearTimeout(timer);
  }
}

/** DexScreener marks DLMM pairs with the label 'DLMM'; DAMM v2 carries 'DYN2'. */
const isDlmm = (p: any): boolean => (p?.labels ?? []).includes('DLMM');

/** What the DexScreener payload says, with no network and no chain read: the whole
 *  filtering decision, kept separate from I/O so it can be tested against a recorded
 *  payload instead of against a live token whose pools change by the hour. */
export type Classified = {
  facts: SolTokenFacts | null;
  inScope: Array<{ pair: any; base: ReturnType<typeof baseOfMint> & object }>;
  otherVenueCount: number;
  offBaseCount: number;
};

export function classifyPairs(mint: string, allPairs: any[]): Classified {
  const pairs = (allPairs ?? []).filter((p) => p?.chainId === 'solana');
  if (pairs.length === 0) return { facts: null, inScope: [], otherVenueCount: 0, offBaseCount: 0 };

  // Token facts come from the DEEPEST pair, DLMM or not: identity and market cap belong to
  // the token, not to the venue we happen to support.
  const deepest = [...pairs].sort(
    (a, b) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0),
  )[0];
  const tok = deepest?.baseToken?.address === mint ? deepest?.baseToken : deepest?.quoteToken;
  const facts: SolTokenFacts = {
    mint,
    name: String(tok?.name ?? '?'),
    symbol: String(tok?.symbol ?? '?'),
    priceUsd: deepest?.priceUsd ?? null,
    priceNative: deepest?.priceNative ?? null,
    quoteMint: deepest?.quoteToken?.address ?? null,
    marketCapUsd: Number(deepest?.marketCap ?? deepest?.fdv ?? 0) || null,
    liquidityUsd: Number(deepest?.liquidity?.usd ?? 0) || null,
    volume24h: Number(deepest?.volume?.h24 ?? 0) || null,
    buys24h: Number(deepest?.txns?.h24?.buys ?? 0) || null,
    sells24h: Number(deepest?.txns?.h24?.sells ?? 0) || null,
    pairAgeHours: deepest?.pairCreatedAt
      ? Math.max(0, (Date.now() - Number(deepest.pairCreatedAt)) / 3_600_000)
      : null,
  };

  const dlmm = pairs.filter(isDlmm);
  const otherVenueCount = pairs.length - dlmm.length;

  let offBaseCount = 0;
  const inScope: Classified['inScope'] = [];
  for (const p of dlmm) {
    // Which side is the PAIRED asset: compare mints exactly, never by position and never
    // case-folded. DexScreener's base/quote order does not always match the pool's.
    const other = p?.baseToken?.address === mint ? p?.quoteToken : p?.baseToken;
    const base = other?.address ? baseOfMint(String(other.address)) : undefined;
    if (!base) {
      offBaseCount++;
      continue;
    }
    inScope.push({ pair: p, base });
  }
  return { facts, inScope, otherVenueCount, offBaseCount };
}

/**
 * A pool's bin step and fee, retried and remembered. A rate-limited read (429) used to come
 * back as "bin ?", and an LP opened from that card could not size its range.
 */
const lbCache = new Map<string, Awaited<ReturnType<typeof lbPair>>>();
async function lbPairSteady(pool: string): Promise<Awaited<ReturnType<typeof lbPair>>> {
  const hit = lbCache.get(pool);
  if (hit) return hit;
  for (let i = 0; i < 3; i++) {
    const info = await lbPair(pool).catch(() => null);
    if (info) {
      lbCache.set(pool, info);
      return info;
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return null;
}

export async function solTokenView(mint: string): Promise<SolTokenView> {
  if (!isSolAddress(mint)) throw new Error('not a Solana address');
  const { facts, inScope, otherVenueCount, offBaseCount } = classifyPairs(mint, await fetchPairs(mint));

  const chainReadSkipped = rpcUrl() === null;
  const pools: DlmmPool[] = await Promise.all(
    inScope.map(async ({ pair: p, base }) => {
      const liquidityUsd = Number(p?.liquidity?.usd ?? 0);
      const vol24hUsd = Number(p?.volume?.h24 ?? 0);
      // A failed pool read must not lose the pool: TVL and volume are still worth showing.
      const info = chainReadSkipped ? null : await lbPairSteady(String(p.pairAddress));
      const tokenSide = p?.baseToken?.address === mint ? p?.baseToken : p?.quoteToken;
      return {
        pairAddress: String(p.pairAddress),
        baseMint: base.mint,
        // The symbol comes from our own table, not from DexScreener: a pool can label WSOL
        // however it likes, and the deposit prompt must name the asset we actually send.
        baseSymbol: base.symbol,
        tokenSymbol: String(tokenSide?.symbol ?? '?'),
        liquidityUsd,
        vol24hUsd,
        binStep: info?.binStep ?? null,
        baseFeePct: info?.baseFeePct ?? null,
        // aprOf is imported, never re-derived: three copies of this formula once drifted
        // apart and printed 373,403,973%.
        aprPct: info ? aprOf(vol24hUsd, info.baseFeePct * 10_000, liquidityUsd) : null,
      };
    }),
  );
  pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  return { facts, pools, otherVenueCount, offBaseCount, chainReadSkipped };
}
