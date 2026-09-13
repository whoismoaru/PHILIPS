import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './store.js';

/**
 * Lightweight tracking for the Uniswap v4 positions the bot OPENED, kept separate from the
 * v3 store so it cannot disturb that path. It holds the entry data so /positions can
 * compute PnL and the monitor can alert on range changes. A v4 position opened elsewhere
 * still shows up, read-only, with no entry data.
 */
export type V4Record = {
  tokenId: string;
  chain: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  base: 'ETH' | 'USDG' | null;
  baseIsCurrency0: boolean;
  entryBaseWei: string; // the base deposited at open (raw, base decimals)
  entryEthUsd?: number; // the base price in USD at open, for LP-Agent-style USD PnL (ETH's price for ETH, 1 for USDG)
  entryTick?: number; // the pool tick at open; the card's range % is anchored here so it stays still
  entryMcap?: number; // the USD market cap at open; the card's mcap bounds are anchored here
  groupId?: string; // a v4 bid-ask ladder: N legs sharing a groupId make one logical position
  legIndex?: number;
  legCount?: number;
  shape?: 'spot' | 'bidask';
  openedAt: number;
  lastInRange?: boolean;
  dropTier?: number; // the drop-alert rung that already fired (same as v3)
  dropAlerted?: boolean;
  ilAlerted?: boolean; // the net-loss alert already fired; it re-arms on recovery
};

/** Every leg of one v4 ladder group, ordered by legIndex. */
export function groupV4(groupId: string): V4Record[] {
  return records.filter((r) => r.groupId === groupId).sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0));
}

const FILE = join(process.cwd(), 'data', 'v4positions.json');

let records: V4Record[] = load();

function load(): V4Record[] {
  try {
    const r = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(r) ? r : [];
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') console.error('[v4store] v4positions.json could not be read, starting EMPTY:', err.message);
    return [];
  }
}

function persist(): void {
  writeJson(FILE, records);
}

export const allV4 = (): V4Record[] => records;
export const getV4 = (tokenId: string): V4Record | undefined => records.find((r) => r.tokenId === tokenId);

export function trackV4(rec: Omit<V4Record, 'openedAt' | 'lastInRange'> & { openedAt?: number }): void {
  if (records.some((r) => r.tokenId === rec.tokenId)) return;
  records.push({ ...rec, openedAt: rec.openedAt ?? Date.now() });
  persist();
}

/** Patch part of a record, the alert markers. A missing record is a no-op. */
export function updateV4(tokenId: string, patch: Partial<V4Record>): void {
  const r = records.find((x) => x.tokenId === tokenId);
  if (!r) return;
  Object.assign(r, patch);
  persist();
}

export function removeV4(tokenId: string): void {
  const before = records.length;
  records = records.filter((r) => r.tokenId !== tokenId);
  if (records.length !== before) persist();
}

/**
 * Record the in-range status. Returns true ONLY when it changed from a value already
 * stored -- the first write never fires an alert, which would otherwise be a false alarm
 * every time a single-sided position opens, since those start out of range by design.
 */
export function setV4InRange(tokenId: string, inRange: boolean): boolean {
  const r = records.find((x) => x.tokenId === tokenId);
  if (!r) return false;
  const was = r.lastInRange;
  if (was === inRange) return false;
  r.lastInRange = inRange;
  persist();
  return was !== undefined;
}
