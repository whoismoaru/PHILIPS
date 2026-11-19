/**
 * A DLMM position's PnL exactly as Meteora's own app shows it, from Meteora's DLMM Data API.
 *
 * Meteora prices every deposit, withdrawal and fee claim in dollars at the moment it happened,
 * and an open position's live balance and unclaimed fees at the current price: pnlUsd is all
 * of that against the deposits, and pnlPctChange is pnlUsd over the deposits, in percent. The
 * owner sets a take profit off that number, so the bot has to read the same one: its own
 * SOL-based figure said +5.91% for Mandy (19 Nov 2026) where Meteora showed +5.58%.
 *
 * Calculated on the fly per request; the API allows 30 requests a second.
 * https://docs.meteora.ag/api-reference/dlmm/positions/get-position-pnl-data-open-and-closed-positions-with-on-the-fly-calculation
 */
const API = 'https://dlmm.datapi.meteora.ag';

export type MeteoraPnl = { pct: number; usd: number };

/** A string or number field as a number; NaN for anything else, an empty string included. */
const num = (x: unknown): number => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '') ? Number(x) : NaN);

/** One position's PnL out of a /pnl response; null when it is not listed or not readable. */
export function pickPnl(body: any, position: string): MeteoraPnl | null {
  const p = Array.isArray(body?.positions) ? body.positions.find((x: any) => x?.positionAddress === position) : undefined;
  const pct = num(p?.pnlPctChange), usd = num(p?.pnlUsd);
  return p && Number.isFinite(pct) && Number.isFinite(usd) ? { pct, usd } : null;
}

/** null when the API is down or slow, or has not indexed the position yet: the caller falls back. */
export async function meteoraPnl(pool: string, owner: string, position: string): Promise<MeteoraPnl | null> {
  try {
    const r = await fetch(`${API}/positions/${pool}/pnl?user=${owner}&status=open&page_size=100`, { signal: AbortSignal.timeout(8_000) });
    return r.ok ? pickPnl(await r.json(), position) : null;
  } catch {
    return null;
  }
}
