import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './store.js';

/**
 * Limit orders, kept in data/limits.json so they survive a restart.
 *
 * Nothing here is on-chain. The bot watches market cap and, when a target is crossed,
 * replays the same taps the owner would have made: an ENTRY opens an LP (paste CA, pool,
 * range, legs, amount), a TAKE PROFIT closes a position. Every guard those paths carry
 * still applies, because it is those paths that run.
 */
export type LimitEntry = {
  id: string;
  kind: 'entry';
  chain: string; // a CHAINS key, or 'solana'
  ca: string;
  symbol: string;
  /** Which pool, matched again at trigger time: the card's pool order can change. */
  poolRef: string;
  poolLabel: string;
  rangePct: number;
  legs?: number;
  /** The amount exactly as it would be typed at the amount step ("100", "0.5"). */
  amount: string;
  unit: string;
  targetMcap: number;
  /** 'below' fires when mcap falls to the target, 'above' when it rises to it. */
  dir: 'below' | 'above';
  createdAt: number;
};

export type LimitTp = {
  id: string;
  kind: 'tp';
  chain: string;
  ca: string;
  symbol: string;
  /** What closes it: 'v3:<tokenId>', 'v4:<tokenId>' or 'sol:<position>'. */
  posRef: string;
  targetMcap: number;
  createdAt: number;
};

export type Limit = LimitEntry | LimitTp;

const FILE = join(process.cwd(), 'data', 'limits.json');
let cache: Limit[] | null = null;

function load(): Limit[] {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Limit[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export const all = (): Limit[] => [...load()];
export const get = (id: string): Limit | undefined => load().find((l) => l.id === id);

export function add(l: Omit<LimitEntry, 'id' | 'createdAt'> | Omit<LimitTp, 'id' | 'createdAt'>): Limit {
  const full = { ...l, id: Date.now().toString(36).slice(-6), createdAt: Date.now() } as Limit;
  cache = [...load(), full];
  writeJson(FILE, cache);
  return full;
}

export function remove(id: string): boolean {
  const before = load().length;
  cache = load().filter((l) => l.id !== id);
  writeJson(FILE, cache);
  return cache.length !== before;
}

/** "500k" / "1.2M" / "$2,5M" / "750000" -> dollars. null when it is not a market cap. */
export function parseMcap(raw: string): number | null {
  const m = raw.trim().replace(/^\$/, '').replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!m) return null;
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] : 1;
  const v = Number(m[1]) * mult;
  return v > 0 && isFinite(v) ? v : null;
}
