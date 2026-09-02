/**
 * Pengisi celah screening dari GoPlus Security (https://gopluslabs.io).
 *
 * Gratis, tanpa API key. Dipakai KHUSUS di BSC: chain itu tak punya Blockscout
 * (chains.ts → blockscout: null), jadi Verified / Proxy / Total Holders selama
 * ini kosong. GoPlus menutup ketiganya sekaligus.
 *
 * Robinhood SENGAJA tidak dipetakan. Chain 4663 memang terdaftar di
 * /supported_chains, tapi jawabannya cuma nama & simbol — bahkan is_in_dex=0
 * untuk token yang jelas ada di Uniswap. Terdaftar bukan berarti terindeks.
 *
 * SEMUA kegagalan fail-open (null), seperti gmgn.ts dan insightx.ts.
 */

const BASE = 'https://api.gopluslabs.io/api/v1/token_security';
const TIMEOUT_MS = 4_000;

/** PHILIPS key → chain id GoPlus. Tak ada di peta = tak dipanggil sama sekali. */
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

// GoPlus mengirim SEMUA field sebagai string ('0'/'1'), dan MENGHILANGKAN field
// yang tak bisa ia tentukan. Absen = '?', bukan 'tidak' — membaca field hilang
// sebagai 0 persis cara kartu ini berbohong ke arah aman.
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
      // Kunci result-nya alamat lowercase, tapi jangan dipatok: token tak dikenal
      // dijawab result kosong, bukan error.
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
    /* fail-open */
  } finally {
    clearTimeout(t);
  }

  cache.set(`${chainId}:${addr}`, { t: Date.now(), v });
  return v;
}
