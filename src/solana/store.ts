/**
 * What the bot knows about the Solana positions IT opened.
 *
 * The chain holds the position but not the trade: an account says how much liquidity sits
 * in which bins, never what was deposited or when. Without that there is no entry to
 * measure against, and /positions can only ever say "entry unknown" -- which is exactly
 * what it said for the first Solana row.
 *
 * Positions opened elsewhere (Meteora's own site, another bot) are still shown; they simply
 * have no entry, and the card says so rather than inventing one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../store.js';

const FILE = join(process.cwd(), 'data', 'solpositions.json');

export type SolEntry = {
  position: string;
  pool: string;
  /** The token that was LP'd against the base. */
  mint: string;
  symbol: string;
  baseSymbol: string;
  /** Deposit in the BASE's own base units, as a decimal string: lamports for SOL. */
  entryBase: string;
  openedAt: number;
  /** The range as opened, for the card. */
  rangePct: number;
  bins: number;
  /** Dollars per base unit when it opened (SOL price, or 1 for USDC), for a dollar PnL. */
  entryUsd?: number;
  /** Market cap and pool price (base per token) captured together once, so the card's
   *  range bounds are fixed ratios of one snapshot instead of drifting with every read. */
  anchorMcap?: number;
  anchorPrice?: number;
  /** A ladder's legs share one id; each leg is still its own position. */
  groupId?: string;
  legIndex?: number;
  legCount?: number;
  /** 'spot' when a wide SPOT range was split into equal positions; empty means bid-ask. */
  shape?: 'spot' | 'bidask';
};

let cache: Record<string, SolEntry> | null = null;

function load(): Record<string, SolEntry> {
  if (cache) return cache;
  cache = {};
  if (existsSync(FILE)) {
    try {
      cache = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, SolEntry>;
    } catch {
      // A corrupt file loses the entries, not the positions: they are still on-chain and
      // still listed, just without a PnL.
      cache = {};
    }
  }
  return cache;
}

export const getEntry = (position: string): SolEntry | undefined => load()[position];
/** Every leg of one ladder, nearest the price first. */
export const group = (groupId: string): SolEntry[] =>
  Object.values(load())
    .filter((e) => e.groupId === groupId)
    .sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0));

export function record(e: SolEntry): void {
  const next = { ...load(), [e.position]: e };
  cache = next;
  writeJson(FILE, next);
}

/** Drop entries whose positions are gone, so the file does not grow forever. */
export function keepOnly(positions: string[]): void {
  const live = new Set(positions);
  const cur = load();
  const next = Object.fromEntries(Object.entries(cur).filter(([k]) => live.has(k)));
  if (Object.keys(next).length === Object.keys(cur).length) return;
  cache = next;
  writeJson(FILE, next);
}
