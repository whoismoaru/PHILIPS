import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './store.js';
import { ownerOf } from './owner.js';

/**
 * What the bot paid for tokens it bought through /buy, in dollars, so a later sell can
 * say whether it made money. Average-cost: a sell takes its share of the cost pro rata to
 * the tokens it sells. Tokens that arrived some other way have no entry, and their sell
 * gets no PnL card rather than an invented one.
 */
const FILE = join(process.cwd(), 'data', 'costbasis.json');

type Lot = { symbol: string; tokens: number; costUsd: number; firstAt: number };
let db: Record<string, Lot> = {};
try {
  db = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
} catch {
  // A bad file costs the PnL cards, never the bot's startup.
  console.error('[costbasis] unreadable, starting empty');
}
const save = () => writeJson(FILE, db);
// Keyed by owner too: a lot bought by one wallet is not the cost of another's sell.
const key = (chain: string, ca: string) => `${ownerOf(chain)}:${chain}:${chain === 'solana' ? ca : ca.toLowerCase()}`;

export function addBuy(chain: string, ca: string, symbol: string, tokens: number, costUsd: number): void {
  if (!(tokens > 0) || !(costUsd > 0)) return;
  const k = key(chain, ca);
  const l = db[k] ?? { symbol, tokens: 0, costUsd: 0, firstAt: Date.now() };
  db[k] = { ...l, symbol, tokens: l.tokens + tokens, costUsd: l.costUsd + costUsd };
  save();
}

export type Realized = { symbol: string; costUsd: number; proceedsUsd: number; pnlUsd: number; pnlPct: number; firstAt: number };

/** Books a sell and returns its PnL, or null when the token has no recorded buy. */
export function takeSell(chain: string, ca: string, tokens: number, proceedsUsd: number): Realized | null {
  const k = key(chain, ca);
  const l = db[k];
  if (!l || !(l.tokens > 0) || !(tokens > 0)) return null;
  // Selling more than the bot bought (an airdrop, a transfer in) counts only the bought part.
  const frac = Math.min(1, tokens / l.tokens);
  const costUsd = l.costUsd * frac;
  const proceeds = proceedsUsd * Math.min(1, l.tokens / tokens);
  // A near-full sell closes the lot, so dust left by rounding does not linger as a position.
  if (frac > 0.99) delete db[k];
  else db[k] = { ...l, tokens: l.tokens - tokens, costUsd: l.costUsd - costUsd };
  save();
  const pnlUsd = proceeds - costUsd;
  return { symbol: l.symbol, costUsd, proceedsUsd: proceeds, pnlUsd, pnlPct: (pnlUsd / costUsd) * 100, firstAt: l.firstAt };
}
