/**
 * Screening gap-filler backed by GoPlus Security (https://gopluslabs.io).
 *
 * Free, no API key. Used specifically for BSC: that chain has no Blockscout
 * (chains.ts -> blockscout: null), so Verified / Proxy / Total Holders had been
 * blank all along. GoPlus fills all three at once.
 *
 * Robinhood is left unmapped DELIBERATELY. Chain 4663 is listed under
 * /supported_chains, but the answer carries only a name and symbol — even
 * is_in_dex=0 for tokens plainly trading on Uniswap. Listed is not indexed.
 *
 * EVERY failure fails open (null), like gmgn.ts and insightx.ts.
 */

const BASE = 'https://api.gopluslabs.io/api/v1/token_security';
const TIMEOUT_MS = 4_000;

/** PHILIPS key -> GoPlus chain id. Not in the map means no call is made. */
const CHAIN: Record<string, string> = { bsc: '56' };

export type GoPlusInfo = {
  verified: boolean | null; // is_open_source
  isProxy: boolean | null;
  holderCount: number | null;
  honeypot: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  renounced: boolean | null; // owner_address = 0x0/dead
  mintable: boolean | null;
  pausable: boolean | null; // transfer_pausable / blacklist
  creatorPct: number | null;
};

const cache = new Map<string, { t: number; v: GoPlusInfo | null }>();
const TTL = 60_000;

// GoPlus sends EVERY field as a string ('0'/'1') and OMITS the ones it cannot
// determine. Absent means '?', not 'no' — reading a missing field as 0 is exactly
// how this card ends up lying in the safe direction.
const bit = (v: unknown): boolean | null => (v === '1' ? true : v === '0' ? false : null);
const flt = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '']);

export async function goplusInfo(tokenAddress: string, chainKey: string): Promise<GoPlusInfo | null> {
  const chainId = CHAIN[chainKey];
  if (!chainId) return null;

  const addr = tokenAddress.toLowerCase();
  const hit = cache.get(`${chainId}:${addr}`);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  let v: GoPlusInfo | null = null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${chainId}?contract_addresses=${addr}`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.ok) {
      const j: any = await res.json();
      // The result is keyed by lowercase address, but do not count on it: an
      // unknown token comes back with an empty result rather than an error.
      const r = j?.result?.[addr] ?? Object.values(j?.result ?? {})[0];
      if (r && typeof r === 'object' && Object.keys(r).length > 2) {
        const d: any = r;
        const owner = String(d.owner_address ?? '').toLowerCase();
        const tax = (x: unknown): number | null => {
          const n = flt(x);
          return n === null ? null : n * 100; // GoPlus: 0.02 = 2%
        };
        v = {
          verified: bit(d.is_open_source),
          isProxy: bit(d.is_proxy),
          holderCount: flt(d.holder_count),
          honeypot: bit(d.is_honeypot),
          buyTaxPct: tax(d.buy_tax),
          sellTaxPct: tax(d.sell_tax),
          renounced: d.owner_address === undefined ? null : DEAD.has(owner),
          mintable: bit(d.is_mintable),
          pausable: bit(d.transfer_pausable) ?? bit(d.is_blacklisted),
          creatorPct: (() => {
            const n = flt(d.creator_percent);
            return n === null ? null : n * 100;
          })(),
        };
      }
    }
  } catch {
    /* fail open */
  } finally {
    clearTimeout(t);
  }

  cache.set(`${chainId}:${addr}`, { t: Date.now(), v });
  return v;
}
