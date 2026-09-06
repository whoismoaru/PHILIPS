import { ethers } from 'ethers';
import { bold, code, esc, italic, nowWib } from './messages.js';
import { getChain, basesFor, type ChainCtx } from './chains.js';
import { EXPLORER_HEADERS } from './chain.js';
import { gmgnExtra, gmgnPrice, bustGmgnCache, type GmgnExtra } from './gmgn.js';
import { insightxMetrics, type InsightXMetrics } from './insightx.js';
import { goplusInfo, type GoPlusInfo } from './goplus.js';
import { serializedInfo, bustSerializedCache, type SerializedInfo } from './serialized.js';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];
const BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const FEE_TIERS = [100, 500, 2500, 3000, 10000]; // gabungan Uniswap + PancakeSwap; pool yang tak ada dilewati
type SellStatus = 'ok' | 'blocked' | 'costly' | 'unknown';

/**
 * Simulate the SELL PATH (exit liquidity) before providing LP: a Quoter round-trip
 * (base -> token -> base) through the deepest base pool. Catches a missing sell path
 * (a sell that reverts means the token cannot be sold) and a ruinously expensive one
 * (thin liquidity). Same pattern other bots use: buy-then-sell via Quoter, revert
 * means blocked.
 * NOTE: the Quoter computes pool maths, it does NOT execute token transfers — pure
 * sell-tax and transfer-block tokens are not always caught (a stateOverride upgrade
 * would fix that). Read-only and fails open: an error becomes 'unknown', never a block.
 */
async function simulateSellPath(
  tokenAddress: string,
  ctx: ChainCtx,
): Promise<{ status: SellStatus; flag: Flag | null }> {
  try {
    // The deepest base pool for this token.
    type Cand = { baseAddr: string; decimals: number; fee: number; reserve: bigint };
    // Every (base x fee) checked at once, so the deepest pool is found without a serial loop.
    const cands = await Promise.all(
      basesFor(ctx).flatMap((base) => {
        const baseC = new ethers.Contract(base.address, BAL_ABI, ctx.provider);
        return FEE_TIERS.map(async (fee): Promise<Cand | null> => {
          const pool: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
          if (!pool || pool === ethers.ZeroAddress) return null;
          const reserve: bigint = await baseC.balanceOf(pool);
          return { baseAddr: base.address, decimals: base.decimals, fee, reserve };
        });
      }),
    );
    let best: Cand | null = null;
    for (const c of cands) if (c && (!best || c.reserve > best.reserve)) best = c;
    if (!best || best.reserve === 0n) return { status: 'unknown', flag: null };

    const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, ctx.provider);
    // A probe small relative to the pool, to avoid inventing price impact.
    const probe = best.decimals >= 18 ? '0.01' : '10';
    const baseIn = ethers.parseUnits(probe, best.decimals);

    let tokenOut: bigint;
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: best.baseAddr, tokenOut: tokenAddress, amountIn: baseIn, fee: best.fee, sqrtPriceLimitX96: 0n,
      });
      tokenOut = BigInt(q[0]);
    } catch {
      return { status: 'unknown', flag: null }; // gagal quote BELI → jangan blokir
    }
    if (tokenOut === 0n) return { status: 'unknown', flag: null };

    let baseBack: bigint;
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenAddress, tokenOut: best.baseAddr, amountIn: tokenOut, fee: best.fee, sqrtPriceLimitX96: 0n,
      });
      baseBack = BigInt(q[0]);
    } catch {
      return { status: 'blocked', flag: { level: 'BAHAYA', msg: 'Sell simulation reverted — this token may be unsellable' } };
    }
    if (baseBack === 0n)
      return { status: 'blocked', flag: { level: 'BAHAYA', msg: 'Sell simulation returned 0 — no exit route' } };

    const loss = 1 - Number(baseBack) / Number(baseIn);
    const feeRoundtrip = (2 * best.fee) / 1_000_000; // 3000 → 0.006
    if (loss > Math.max(0.2, feeRoundtrip * 4))
      return {
        status: 'costly',
        flag: { level: 'HATI-HATI', msg: `Round-trip loss ~${(loss * 100).toFixed(0)}% — thin liquidity` },
      };
    return { status: 'ok', flag: null };
  } catch {
    return { status: 'unknown', flag: null }; // fail-open
  }
}

/**
 * Anti-anomaly token screening before providing LP.
 * Data sources: Blockscout (Robinhood Chain's official explorer) plus DexScreener.
 * All of it is heuristic — NOT a safety guarantee, but it catches common scam shapes.
 */

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';

type Level = 'BAHAYA' | 'HATI-HATI' | 'INFO';
export type Flag = { level: Level; msg: string };

export type ScreenResult = {
  ok: boolean;
  name: string;
  symbol: string;
  verified: boolean | null;
  isProxy: boolean | null;
  holdersCount: number | null;
  top1Pct: number | null;
  top10Pct: number | null;
  top1IsContract: boolean;
  liquidityUsd: number | null;
  volume24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  priceUsd: string | null;
  marketCapUsd: number | null; // dari DexScreener (marketCap, fallback fdv)
  pairAgeHours: number | null;
  dexName: string | null; // 'uniswap' | 'pancakeswap' | … dari DexScreener
  renounced: boolean | null; // null = tak bisa ditentukan (owner() tak ada / RPC gagal)
  gmgn: GmgnExtra | null; // pengisi celah dari GMGN; null = tak dipanggil/gagal
  insightx: InsightXMetrics | null; // klaster holder InsightX; null = chain tak didukung/gagal
  goplus: GoPlusInfo | null; // penambal BSC (chain tanpa Blockscout); null = tak dipakai/gagal
  serialized: SerializedInfo | null; // audit kontrak + hook v4; null = chain tak didukung/gagal
  scamFlag: boolean; // token ditandai scam oleh explorer
  sellPath: SellStatus; // simulasi jalur jual (exit-liquidity)
  flags: Flag[];
  verdict: 'AMAN' | 'HATI-HATI' | 'BAHAYA';
};

// Per-URL cache for off-chain reads (Blockscout/DexScreener). Screening data is
// advisory and does not change second to second, so running /add on the same token
// again is instant. The sell path (on-chain quoter) does NOT go through here and
// stays live.
const _jsonCache = new Map<string, { t: number; v: any }>();
const JSON_TTL = 60_000;

/**
 * Drop the off-chain cache for one token, used by the audit card's Refresh button.
 *
 * Without it, tapping Refresh within 60 seconds returns exactly the same figures:
 * the cache answered, not the network. A Refresh that refreshes nothing is worse
 * than no button at all.
 */
export function bustScreenCache(addr: string): void {
  const a = addr.toLowerCase();
  for (const k of [..._jsonCache.keys()]) if (k.toLowerCase().includes(a)) _jsonCache.delete(k);
  // The GMGN answer is cached separately and for far longer, so clearing only the
  // HTTP cache would leave Refresh redrawing the same GMGN figures.
  bustGmgnCache(a);
  bustSerializedCache(a);
}

async function fetchJson(url: string): Promise<any | null> {
  const hit = _jsonCache.get(url);
  if (hit && Date.now() - hit.t < JSON_TTL) return hit.v;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000); // cap worst-case; fail-open (null) sudah ditangani
  try {
    const res = await fetch(url, { headers: EXPLORER_HEADERS, signal: ctrl.signal });
    if (!res.ok) return null;
    const v = await res.json();
    _jsonCache.set(url, { t: Date.now(), v });
    return v;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function worst(flags: Flag[]): ScreenResult['verdict'] {
  if (flags.some((f) => f.level === 'BAHAYA')) return 'BAHAYA';
  if (flags.some((f) => f.level === 'HATI-HATI')) return 'HATI-HATI';
  return 'AMAN';
}

/**
 * Has contract ownership been renounced? Read from owner()/getOwner().
 * null means it CANNOT BE DETERMINED (the function is absent, or the RPC failed) and
 * must never be read as safe: the card shows it as '?', not a tick.
 */
async function readRenounced(addr: string, ctx: ChainCtx): Promise<boolean | null> {
  const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
  for (const fn of ['owner', 'getOwner']) {
    try {
      const c = new ethers.Contract(addr, [`function ${fn}() view returns (address)`], ctx.provider);
      const o: string = await c[fn]();
      return DEAD.has(o.toLowerCase());
    } catch {
      /* try the next name */
    }
  }
  return null; // tak ada owner() yang bisa dibaca
}

export async function screenToken(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<ScreenResult> {
  const addr = ethers.getAddress(tokenAddress);
  const flags: Flag[] = [];
  const bs = ctx.blockscout; // null = explorer tak tersedia (mis. BSC)

  // Fire every request at once, including the on-chain sell-path simulation.
  const [tokenInfo, holders, contract, dex, sell, renounced, gmgn, insightx, goplus, counters, serialized] = await Promise.all([
    bs ? fetchJson(`${bs}/tokens/${addr}`) : Promise.resolve(null),
    bs ? fetchJson(`${bs}/tokens/${addr}/holders`) : Promise.resolve(null),
    bs ? fetchJson(`${bs}/smart-contracts/${addr}`) : Promise.resolve(null),
    fetchJson(`${DEXSCREENER}/${addr}`),
    simulateSellPath(addr, ctx),
    readRenounced(addr, ctx),
    gmgnExtra(addr, ctx.key).catch(() => null), // fail-open: data tambahan
    insightxMetrics(addr, ctx.key).catch(() => null), // fail-open: klaster holder
    goplusInfo(addr, ctx.key).catch(() => null), // fail-open: penambal BSC
    bs ? fetchJson(`${bs}/tokens/${addr}/counters`) : Promise.resolve(null),
    serializedInfo(addr, ctx.key).catch(() => null), // fail-open: audit kontrak + hook
  ]);
  if (sell.flag) flags.push(sell.flag);

  // A failed audit is a BLOCKING verdict, not a display row: `verdict` feeds the
  // /add guard. The hook is judged separately and counts the same — a clean token
  // behind a draining hook is still a position you cannot get out of.
  if (serialized?.tokenSafe === false)
    flags.push({ level: 'BAHAYA', msg: 'Audit: token contract is UNSAFE' });
  if (serialized?.hookSafe === false)
    flags.push({ level: 'BAHAYA', msg: 'Audit: V4 hook is UNSAFE' });

  const dexBase = (dex?.pairs ?? []).find(
    (p: any) => p.chainId === ctx.dexKey && (p.baseToken?.address || '').toLowerCase() === addr.toLowerCase(),
  )?.baseToken;
  const name = tokenInfo?.name ?? dexBase?.name ?? 'Tidak diketahui';
  const symbol = tokenInfo?.symbol ?? dexBase?.symbol ?? '???';
  // Total holders: /counters is fresher than the token payload (5311 against 5223
  // measured on the same CA); GoPlus fills in for BSC, which has no explorer.
  const holdersCount =
    (counters?.token_holders_count ? Number(counters.token_holders_count) : null) ??
    (tokenInfo?.holders_count ? Number(tokenInfo.holders_count) : null) ??
    goplus?.holderCount ??
    null;
  // transfers_count from /counters is DELIBERATELY unused: it reported 44,604
  // lifetime transfers for a 20-hour-old token that logged ~80,000 swaps over the
  // same period — a figure corroborated independently by DexScreener AND
  // GeckoTerminal. Its index lags; showing it means showing a wrong number.
  // The explorer also flags contracts reported as scams. That field already rides
  // along in the payload we fetch — no extra call, and it had simply been discarded.
  const scamFlag = tokenInfo?.reputation === 'scam' || tokenInfo?.is_scam === true;
  if (scamFlag) flags.push({ level: 'BAHAYA', msg: 'Explorer flags this contract as a SCAM' });
  const totalSupply = tokenInfo?.total_supply ? BigInt(tokenInfo.total_supply) : null;

  // --- Contract verification ---
  let verified: boolean | null = null;
  // null means CANNOT BE DETERMINED. It used to default to `false` and stay that way
  // on chains without an explorer, so BSC always printed 'Proxy: ✅ No' with no
  // evidence behind it — exactly the lie-in-the-safe-direction this card forbids.
  let isProxy: boolean | null = null;
  if (contract) {
    verified = Boolean(contract.source_code || contract.is_verified || contract.is_fully_verified);
    isProxy = Boolean(
      contract.proxy_type ||
        (Array.isArray(contract.implementations) && contract.implementations.length > 0) ||
        /proxy/i.test(contract.name ?? ''),
    );
  } else {
    // With no explorer (BSC) the answer comes from GoPlus; if that is empty too, null.
    verified = bs ? false : (goplus?.verified ?? serialized?.verified ?? null);
    isProxy = goplus?.isProxy ?? serialized?.isProxy ?? null;
  }
  if (verified === false) flags.push({ level: 'HATI-HATI', msg: 'Contract is NOT verified (source code unavailable)' });
  if (isProxy) flags.push({ level: 'INFO', msg: 'Upgradeable contract (proxy) — the dev can change its logic' });

  // --- Holder concentration ---
  let top1Pct: number | null = null;
  let top10Pct: number | null = null;
  let top1IsContract = false;
  const items: any[] = holders?.items ?? [];
  if (items.length > 0 && totalSupply && totalSupply > 0n) {
    const val = (h: any) => {
      try {
        return BigInt(h.value ?? '0');
      } catch {
        return 0n;
      }
    };
    top1IsContract = Boolean(items[0]?.address?.is_contract);
    top1Pct = Number((val(items[0]) * 10000n) / totalSupply) / 100;
    const sum10 = items.slice(0, 10).reduce((a, h) => a + val(h), 0n);
    top10Pct = Number((sum10 * 10000n) / totalSupply) / 100;

    // Top-10 concentration is handled below, where GMGN's cleaner figure is
    // available; this only catches a SINGLE wallet holding the majority.
    if (top1Pct > 50 && !top1IsContract)
      flags.push({ level: 'BAHAYA', msg: `One wallet holds ${top1Pct.toFixed(1)}% of supply` });
  }
  if (holdersCount !== null && holdersCount < 30)
    flags.push({ level: 'HATI-HATI', msg: `Very few holders (${holdersCount})` });

  // --- Market data (DexScreener) ---
  let liquidityUsd: number | null = null;
  let volume24h: number | null = null;
  let buys24h: number | null = null;
  let sells24h: number | null = null;
  let priceUsd: string | null = null;
  let marketCapUsd: number | null = null;
  let pairAgeHours: number | null = null;
  let dexName: string | null = null; // venue pair terlikuid — baris Liquidity menyebutnya

  // Same-chain pairs only (a token address can exist on several chains).
  const pairs: any[] = (dex?.pairs ?? []).filter((p: any) => p.chainId === ctx.dexKey);
  if (pairs.length > 0) {
    // Take the most liquid pair.
    const p = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    liquidityUsd = p.liquidity?.usd ?? null;
    dexName = p.dexId ?? null;
    // 24h volume and trades are SUMMED across EVERY pair for this token on its
    // chain. They used to come from the most liquid pair alone: UBIK has 30 pairs,
    // its top pair showed $3.0M against a $24.1M total — off by 8x. Worse, the
    // figure jumped whenever the liquidity ranking swapped (the same card had read
    // $15.4M an hour earlier). Volume is a FLOW metric: the total belongs to the
    // token, not to one pool.
    //
    // Liquidity DELIBERATELY stays the deepest pair — that is the pool /add will
    // actually enter, and the card's row names its venue.
    const sum = (f: (x: any) => number | null | undefined): number | null => {
      const vals = pairs.map(f).filter((v): v is number => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    volume24h = sum((x) => x.volume?.h24);
    buys24h = sum((x) => x.txns?.h24?.buys);
    sells24h = sum((x) => x.txns?.h24?.sells);
    priceUsd = p.priceUsd ?? null;
    marketCapUsd = p.marketCap ?? p.fdv ?? null;
    if (p.pairCreatedAt) pairAgeHours = (Date.now() - p.pairCreatedAt) / 3_600_000;

    if (liquidityUsd !== null && liquidityUsd < 2000)
      flags.push({ level: 'BAHAYA', msg: `Very thin liquidity ($${Math.round(liquidityUsd)})` });
    else if (liquidityUsd !== null && liquidityUsd < 20000)
      flags.push({ level: 'HATI-HATI', msg: `Low liquidity ($${Math.round(liquidityUsd)})` });

    if (pairAgeHours !== null && pairAgeHours < 24)
      flags.push({ level: 'HATI-HATI', msg: `Pool is very new (${pairAgeHours.toFixed(0)}h old)` });

    if (buys24h !== null && sells24h !== null && buys24h > 20 && sells24h === 0)
      flags.push({ level: 'BAHAYA', msg: 'Many buys but almost no sells — possible honeypot' });

    if (volume24h !== null && volume24h < 1000)
      flags.push({ level: 'HATI-HATI', msg: 'Almost no trades in the last 24h' });
  } else {
    flags.push({ level: 'HATI-HATI', msg: 'No market or liquidity data on DexScreener' });
  }

  // Top-10 wallet concentration. Checked HERE rather than in the Blockscout holders
  // block because GMGN's number only exists after the await above — and GMGN's is the
  // one the card uses: Blockscout counts the pool contract as a 'holder', which sends
  // the percentage soaring (41.27% against 16.72% on the same CA). The 50% threshold
  // means CAUTION: LP is still allowed, the verdict just drops to "SAFE TO LP
  // (Moderate Risk)" so the decision stays with the user.
  const top10Concentration = gmgn?.top10Pct ?? top10Pct;
  if (top10Concentration !== null && top10Concentration >= 50) {
    flags.push({
      level: 'HATI-HATI',
      msg: `Top 10 wallets hold ${top10Concentration.toFixed(1)}% of supply`,
    });
  }

  // Being blind is NOT the same as being safe. Flags are only added when data EXISTS
  // and looks bad; if the sources go quiet (no Blockscout on BSC, GMGN rate-limited),
  // every one of those checks passes without a sound and the verdict reads "SAFE TO
  // LP" — when in fact nothing was checked. Downgrade the verdict and name what could
  // not be read, so the user decides knowing they are blind.
  const takTerbaca = [
    top10Concentration === null && 'holder concentration',
    verified === null && 'contract verification',
    (gmgn?.buyTaxPct ?? null) === null && 'buy/sell tax',
    (gmgn?.lpLockedPct ?? null) === null && 'liquidity lock',
  ].filter(Boolean) as string[];
  if (takTerbaca.length >= 3) {
    flags.push({
      level: 'HATI-HATI',
      msg: `${takTerbaca.length} safety checks unreadable (${takTerbaca.slice(0, 2).join(', ')}…) — not verified as safe`,
    });
  }

  return {
    ok: true,
    name,
    symbol,
    verified,
    isProxy,
    holdersCount,
    top1Pct,
    top10Pct,
    top1IsContract,
    liquidityUsd,
    volume24h,
    buys24h,
    sells24h,
    priceUsd,
    marketCapUsd,
    pairAgeHours,
    dexName,
    renounced,
    gmgn,
    insightx,
    goplus,
    serialized,
    scamFlag,
    sellPath: sell.status,
    flags,
    verdict: worst(flags),
  };
}

/** Format a screening report into text ready to send to Telegram. */
const ethUsdCache = new Map<string, { v: number | null; t: number }>();

/**
 * The token's MARKET price in native terms (ETH per token) from the DEEPEST
 * DexScreener pair on this chain. Used to check whether a position's v4 pool is
 * "dying" (its on-chain price drifting far from the market). null when unreadable.
 */
const tokenEthCache = new Map<string, { v: number | null; t: number }>();
export async function getTokenEthPrice(tokenAddress: string, ctx: ChainCtx = getChain()): Promise<number | null> {
  const key = `${ctx.key}:${tokenAddress.toLowerCase()}`;
  const cached = tokenEthCache.get(key);
  if (cached && Date.now() - cached.t < 60_000) return cached.v;
  const dex = await fetchJson(`${DEXSCREENER}/${tokenAddress}`);
  const w = ctx.wethAddress.toLowerCase();
  const isEthQuote = (a: string) => a === '0x0000000000000000000000000000000000000000' || a.toLowerCase() === w;
  const t = tokenAddress.toLowerCase();
  let best: number | null = null;
  let bestLiq = -1;
  for (const p of (dex?.pairs ?? []) as any[]) {
    if (p.chainId !== ctx.dexKey) continue;
    const liq = p.liquidity?.usd ?? 0;
    let ethPerTok: number | null = null;
    // base=token, quote=ETH means priceNative is already ETH per token.
    if ((p.baseToken?.address || '').toLowerCase() === t && isEthQuote(p.quoteToken?.address || '')) {
      const pn = Number(p.priceNative);
      if (pn > 0) ethPerTok = pn;
    }
    if (ethPerTok && isFinite(ethPerTok) && liq > bestLiq) {
      best = ethPerTok;
      bestLiq = liq;
    }
  }
  tokenEthCache.set(key, { v: best, t: Date.now() });
  return best;
}

/** Native asset price (ETH/BNB) in USD. DexScreener is PRIMARY (HTTP, ~60ms), GMGN
 *  the FALLBACK (a subprocess at ~470ms, used only when DexScreener fails, so the
 *  command does not drag). Cached for 60s. */
export async function getEthUsd(
  wethAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<number | null> {
  const cached = ethUsdCache.get(ctx.key);
  if (cached && Date.now() - cached.t < 60_000) return cached.v;
  const w = wethAddress.toLowerCase();
  // WETH price from the most liquid pool: base=WETH gives priceUsd; quote=WETH gives priceUsd/priceNative.
  const pick = (pairs: any[]): number | null => {
    let best: number | null = null;
    let bestLiq = -1;
    for (const p of pairs) {
      const liq = p.liquidity?.usd ?? 0;
      let eu: number | null = null;
      if ((p.baseToken?.address || '').toLowerCase() === w) {
        eu = Number(p.priceUsd);
      } else if ((p.quoteToken?.address || '').toLowerCase() === w) {
        const pn = Number(p.priceNative);
        const pu = Number(p.priceUsd);
        if (pn > 0) eu = pu / pn;
      }
      if (eu && isFinite(eu) && eu > 0 && liq > bestLiq) {
        best = eu;
        bestLiq = liq;
      }
    }
    return best;
  };
  // 1) The CHAIN-SCOPED endpoint returns only this chain's pairs, which avoids
  //    address collisions. OP-stack WETH (0x4200..0006) is identical on Base, Ink and
  //    Soneium, and the cross-chain tokens/ endpoint squeezes a small chain's pair
  //    (Ink) out of the list, leaving a null price. Chain-scoped avoids that.
  const scoped = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${ctx.dexKey}/${wethAddress}`);
  let best = pick(Array.isArray(scoped) ? scoped : (scoped?.pairs ?? []));
  // 2) Fallback: the older tokens/ endpoint, filtered by dexKey (Robinhood, say,
  //    which is absent from token-pairs/v1). Keeps chains that already worked working.
  if (best === null) {
    const dex = await fetchJson(`${DEXSCREENER}/${wethAddress}`);
    best = pick((dex?.pairs ?? []).filter((p: any) => p.chainId === ctx.dexKey));
  }
  // FALLBACK: DexScreener empty or down -> GMGN (supported chains: robinhood/bsc/base).
  if (best === null) {
    const g = await gmgnPrice(wethAddress, ctx.key).catch(() => null);
    if (g && g.priceUsd > 0) best = g.priceUsd;
  }
  ethUsdCache.set(ctx.key, { v: best, t: Date.now() });
  return best;
}

/**
 * The TOKEN DETAIL card shown after screening.
 *
 * THE RULE THAT CANNOT BE BROKEN: a field with NO data source is written as '?',
 * never as a tick. Showing "Renounced ✓" for something never checked is a false
 * safety claim — precisely the kind of lie that walks people into the wrong token.
 *
 * Real sources today: DexScreener (price, MC, liquidity, volume, pool age),
 * Blockscout (holders, concentration, verification), and on-chain reads (owner() for
 * renounced, the sell-path simulation for honeypots). The rest has no source on this
 * chain yet.
 */
export function formatScreen(s: ScreenResult, opts?: { ca?: string; chainLabel?: string; heldLabel?: string | null; lpCount?: number }): string {
  const UNK = '?';
  const compact = (n: number | null | undefined): string => {
    if (n == null) return UNK;
    const a = Math.abs(n);
    if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    // One decimal in the K range: $452.5K against $453K. Micro-cap tokens live in
    // exactly this band, so rounding whole erases the digit people read most.
    if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };
  const pct = (n: number | null | undefined): string => (n == null ? UNK : `${Number(n.toFixed(2))}%`);
  // Yes/no answers: '?' when the data really is unreadable — NEVER invent a '✅'.
  const yes = (v: boolean | null): string => (v === null ? `${UNK} unreadable` : v ? '✅ Yes' : '❌ No');
  const no = (v: boolean | null): string => (v === null ? `${UNK} unreadable` : v ? '⚠️ Yes' : '✅ No');

  const g = s.gmgn;
  const gp = s.goplus; // penambal BSC
  const symUp = s.symbol.toUpperCase().replace(/^\$+/, '');

  // NoHoneypot: PHILIPS's own sell-path simulation is trusted more (on-chain, live);
  // GMGN is used only when the simulation gives no answer.
  const sellable =
    s.sellPath === 'ok'
      ? true
      : s.sellPath === 'blocked'
        ? false
        : g?.honeypot != null
          ? !g.honeypot
          : gp?.honeypot == null
            ? null
            : !gp.honeypot;

  // Top 10: PREFER GMGN. Blockscout's figure counts the pool contract as a 'holder'
  // and runs high (41.27% measured against 16.72% on the same CA).
  const top10 = g?.top10Pct != null ? g.top10Pct : s.top10Pct;
  const top10Line =
    top10 === null ? UNK : `${pct(top10)} ${top10 >= 50 ? '🔴 (high whale risk)' : top10 >= 20 ? '⚠️ (moderate whale risk)' : '✅'}`;
  const verified = s.verified !== null ? s.verified : (g?.openSource ?? gp?.verified ?? null);
  const renounced = s.renounced !== null ? s.renounced : (g?.renounced ?? gp?.renounced ?? null);
  const taxLine = (n: number | null): string => (n === null ? UNK : `${Number(n.toFixed(1))}% ${n <= 5 ? '✅' : n <= 10 ? '⚠️' : '🔴'}`);
  const lpLocked = g?.lpLockedPct ?? null;
  const burnt = g?.burntPct ?? null;

  const num = (n: number | null | undefined): string => (n == null ? UNK : n.toLocaleString('en-US'));

  // Pausable / cooldown: GMGN sends the owner's privilege list. An EMPTY list is an
  // answer of 'none', not 'unknown'; an unreadable payload (null) stays '?'.
  const privHas = (re: RegExp): boolean | null => {
    if (g?.privileges != null) return g.privileges.some((p) => re.test(p));
    // BSC has no GMGN privilege payload; GoPlus answers the two that matter most.
    if (gp) {
      if (/mint/i.test(re.source)) return gp.mintable;
      if (/paus|freeze|blacklist/i.test(re.source)) return gp.pausable;
    }
    return null;
  };

  // Pool age written for humans: "1h 45m", not "2 hours", which rounds a 90-minute
  // pool into sounding twice as mature as it is.
  const age = (h: number | null): string => {
    if (h === null) return UNK;
    const menit = Math.round(h * 60);
    if (menit < 60) return `${menit}m`;
    const hari = Math.floor(menit / 1440);
    const jam = Math.floor((menit % 1440) / 60);
    return hari > 0 ? `${hari}d ${jam}h` : `${jam}h ${menit % 60}m`;
  };
  const venue = s.dexName ? ` (${esc(s.dexName.replace(/^\w/, (c) => c.toUpperCase()))})` : '';

  // "Authority" is Solana's term; the EVM equivalent is an owner privilege still live
  // in the contract. Read from GMGN's privilege list: an EMPTY list genuinely means
  // none (Disabled), an unreadable payload means '?', NOT 'Disabled'. Saying
  // "Disabled" without data is the most expensive lie this card can tell.
  const authority = (re: RegExp): string => {
    const v = privHas(re);
    return v === null ? UNK : v ? 'Enabled ⚠️' : 'Disabled ✅';
  };

  // LP: burn takes precedence (permanent) over lock (which can expire).
  const lpStatus =
    burnt !== null && burnt >= 50
      ? `${pct(burnt)} Burned ✅`
      : lpLocked !== null && lpLocked >= 50
        ? `${pct(lpLocked)} Locked ✅`
        : burnt !== null || lpLocked !== null
          ? `burned ${pct(burnt)} · locked ${pct(lpLocked)} ⚠️`
          : UNK;

  const buyTax = g?.buyTaxPct ?? gp?.buyTaxPct ?? null;
  const sellTax = g?.sellTaxPct ?? gp?.sellTaxPct ?? null;
  const taxPair = buyTax === null && sellTax === null ? UNK : `${taxLine(buyTax)} / ${taxLine(sellTax)}`;

  const dev = g?.devPct ?? gp?.creatorPct ?? null;
  const snipers = g?.sniperCount ?? null;
  // InsightX counts across EVERY holder, while GMGN's tag figure covers only the top
  // 100 (tagsFromTop100). When both exist, the more complete one wins.
  const ix = s.insightx;
  const bundle = ix?.bundlersPct ?? g?.bundlerPct ?? null;
  const insiders = ix?.insidersPct ?? g?.insidersPct ?? null;
  const cluster = ix?.clusterPct ?? null;

  // The same thresholds for all three: >=20% red, >=5% amber. Not magic numbers,
  // just consistent with the Sniper Bundles row that has been here from the start.
  const risky = (n: number | null): string =>
    n === null ? UNK : `${pct(n)} ${n >= 20 ? '\u{1F534}' : n >= 5 ? '\u26A0\uFE0F' : '\u2705'}`;

  // Risk lines from the audit. The description is the only part worth showing —
  // the payload also carries the offending SOURCE CODE, which would blow past
  // Telegram's 4096-char limit on a token with three findings.
  const CAP = 88;
  const riskLine = (r: { type: string; impact: string; description: string }): string => {
    const d = r.description.length > CAP ? `${r.description.slice(0, CAP - 1)}…` : r.description;
    return `${esc(r.type)} ${/crit|high/i.test(r.impact) ? '🔴' : '⚠️'} ${esc(d)}`;
  };
  const sa = s.serialized;
  // The warning count rides along with the verdict. Serialized does NOT flip
  // isSafe for warning-impact findings, so a bare "SAFE ✅" above two ⚠️ lines
  // reads as a contradiction — the card would look like it disagrees with itself.
  const safeMark = (v: boolean | null, risks: number): string => {
    const n = risks ? ` · ${risks} warning${risks > 1 ? 's' : ''}` : '';
    return v === null ? UNK : v ? `SAFE ✅${n}` : `UNSAFE 🚫${n}`;
  };

  // Tree layout: each section is separated so its last row uses the └ elbow.
  const tree = (rows: Array<[string, string]>): string[] =>
    rows.map(([k, v], i) => `${i === rows.length - 1 ? '└' : '├'}  ${esc(k)}: ${v}`);

  const out: string[] = [
    bold('TOKEN SECURITY AUDIT'),
    '',
    `📊 ${bold('BASIC STATS :')}`,
    ...tree([
      ['Network', esc(opts?.chainLabel ?? UNK)],
      ['Name', `${bold(`$${esc(symUp)}`)} · ${esc(s.name)}`],
      ['Price', s.priceUsd ? `$${esc(s.priceUsd)}` : UNK],
      ['Market Cap', bold(compact(s.marketCapUsd))],
      ['Liquidity', `${bold(compact(s.liquidityUsd))}${venue}`],
      ['Age', age(s.pairAgeHours)],
    ]),
    '',
    `🛡 ${bold('CONTRACT :')}`,
    ...tree([
      ['Mint Authority', authority(/mint/i)],
      ['Freeze Authority', authority(/paus|freeze|blacklist/i)],
      ['LP Status', lpStatus],
      ['Honeypot', sellable === null ? UNK : sellable ? 'PASS ✅' : 'FAIL 🚫 cannot sell'],
      ['Tax (Buy/Sell)', taxPair],
      // Verified and Proxy are not in the brief but are kept here anyway: a proxy
      // contract can be SWAPPED OUT after this audit runs, so removing them would
      // mean an "all clear" card for a token whose logic can change at any moment.
      ['Verified', yes(verified)],
      ['Proxy', no(s.isProxy)],
      ['Ownership', renounced === null ? UNK : renounced ? 'Renounced ✅' : 'Owned ⚠️'],
    ]),
    '',
    // Only rendered when the audit answered. An empty "AUDIT: unknown" section
    // reads as a verdict of its own; absence should just be absence.
    ...(sa
      ? [
          `🔬 ${bold('AUDIT :')}`,
          ...tree([
            ['Contract', safeMark(sa.tokenSafe, sa.risks.length)],
            ...(sa.hookAddress
              ? ([['V4 Hook', safeMark(sa.hookSafe, sa.hookRisks.length)]] as Array<[string, string]>)
              : []),
          ]),
          ...[...sa.risks, ...sa.hookRisks].slice(0, 4).map((r) => `   • ${riskLine(r)}`),
          '',
        ]
      : []),
    `👥 ${bold('HOLDER RISK :')}`,
    ...tree([
      ['Dev Wallet', dev === null ? UNK : `${pct(dev)} ${dev >= 10 ? '🔴' : dev >= 5 ? '⚠️' : '✅'}`],
      [
        'Sniper Bundles',
        bundle === null && snipers === null
          ? UNK
          : `${pct(bundle)}${snipers ? ` (${num(snipers)} wallets)` : ''} ${(bundle ?? 0) >= 20 ? '🔴' : (bundle ?? 0) >= 5 ? '⚠️' : '✅'}`,
      ],
      ['Insiders', risky(insiders)],
      ['Cluster', risky(cluster)],
      ['Top 10 Holders', top10Line],
      ['Total Holders', num(s.holdersCount)],
    ]),
    '',
    `💸 ${bold('MARKET :')}`,
    ...tree([
      ['24H Volume', compact(s.volume24h)],
      ['24H Trades', `${num(s.buys24h)} buys / ${num(s.sells24h)} sells`],
    ]),
  ];

  // The verdict line was REMOVED at the owner's request (28 Aug 2026): the card now
  // presents figures and leaves the judgement to the reader. `s.verdict` itself is
  // STILL computed and still used by the /add flow to BLOCK tokens judged dangerous —
  // what went away is the display, not the guard.

  if (opts?.ca) out.push('', `CA : ${code(opts.ca)}`);

  // Ownership context is only relevant when the caller passes it (the CA hub card).
  if (opts?.heldLabel || opts?.lpCount)
    out.push(
      '',
      `-> Holding Token: ${bold(opts.heldLabel ? esc(opts.heldLabel) : 'No')}`,
      `-> Active LP: ${bold(opts.lpCount ? `${opts.lpCount} position(s)` : 'No')}`,
    );

  out.push('', nowWib());
  return out.join('\n');
}

