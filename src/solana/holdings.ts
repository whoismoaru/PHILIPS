/**
 * Everything the Solana wallet holds, valued in dollars, for /portfolio.
 *
 * Balances come from the node (both token programs: classic SPL and Token-2022), prices
 * and symbols from DexScreener in one batch -- the same source the rest of the Solana path
 * reads. A token DexScreener has never seen gets usd null rather than $0: unpriced is not
 * the same as worthless.
 */
import { solRpc } from './rpc.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

/** `mint` and `raw` (base units) are what a swap needs; the native row carries the WSOL mint. */
export type SolHolding = { symbol: string; amount: number; usd: number | null; mint: string; raw: bigint };

async function prices(mints: string[]): Promise<Map<string, { px: number; sym: string }>> {
  const out = new Map<string, { px: number; sym: string }>();
  // DexScreener takes 30 addresses per call.
  for (let i = 0; i < mints.length; i += 30) {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`).catch(() => null);
    const pairs: any[] = res?.ok ? ((await res.json().catch(() => [])) as any[]) : [];
    // The deepest pair wins, so a thin scam pool cannot set the price.
    const best = new Map<string, { liq: number; px: number; sym: string }>();
    for (const p of pairs) {
      const m = p?.baseToken?.address;
      const px = Number(p?.priceUsd);
      const liq = Number(p?.liquidity?.usd ?? 0);
      if (!m || !(px > 0)) continue;
      if ((best.get(m)?.liq ?? -1) < liq) best.set(m, { liq, px, sym: String(p.baseToken.symbol ?? '?') });
    }
    for (const [m, b] of best) out.set(m, { px: b.px, sym: b.sym });
  }
  return out;
}

let solPxCache: { v: number; t: number } | null = null;
/** SOL in dollars, cached for a minute. Null when DexScreener cannot answer. */
export async function solUsd(): Promise<number | null> {
  if (solPxCache && Date.now() - solPxCache.t < 60_000) return solPxCache.v;
  const v = (await prices([WSOL]).catch(() => new Map())).get(WSOL)?.px ?? null;
  if (v) solPxCache = { v, t: Date.now() };
  return v;
}

export async function solHoldings(owner: string): Promise<SolHolding[]> {
  const [lamports, ...lists] = await Promise.all([
    solRpc<{ value: number }>('getBalance', [owner]),
    ...PROGRAMS.map((programId) =>
      solRpc<{ value: any[] }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]).catch(() => ({ value: [] })),
    ),
  ]);
  const bal = new Map<string, number>();
  const raws = new Map<string, bigint>();
  for (const l of lists)
    for (const a of l.value) {
      const info = a?.account?.data?.parsed?.info;
      const n = Number(info?.tokenAmount?.uiAmount ?? 0);
      if (!info?.mint || !(n > 0)) continue;
      bal.set(info.mint, (bal.get(info.mint) ?? 0) + n);
      raws.set(info.mint, (raws.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount ?? '0'));
    }
  const px = await prices([WSOL, ...bal.keys()]);
  const sol = lamports.value / 1e9;
  const solPx = px.get(WSOL)?.px;
  const out: SolHolding[] = [{ symbol: 'SOL', amount: sol, usd: solPx ? sol * solPx : null, mint: WSOL, raw: BigInt(lamports.value) }];
  for (const [m, n] of bal) {
    const p = px.get(m);
    // Wrapped SOL is SOL: folded into the native row rather than listed twice.
    if (m === WSOL) {
      out[0].amount += n;
      out[0].usd = solPx ? out[0].amount * solPx : null;
      continue;
    }
    out.push({ symbol: p?.sym ?? `${m.slice(0, 4)}…`, amount: n, usd: p ? n * p.px : null, mint: m, raw: raws.get(m) ?? 0n });
  }
  return out;
}
