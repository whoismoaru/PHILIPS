import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pelacakan RINGAN posisi Uniswap v4 yang DIBUKA oleh bot (terpisah dari store v3
 * agar tak mengganggu jalur v3). Menyimpan entry supaya /positions bisa hitung PnL
 * dan monitor bisa alert in/out-range. Posisi v4 yang dibuka di luar bot tetap
 * tampil (read-only) tanpa entry.
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
  entryBaseWei: string; // base disetor saat open (raw, desimal base)
  openedAt: number;
  lastInRange?: boolean;
};

const FILE = join(process.cwd(), 'data', 'v4positions.json');

let records: V4Record[] = load();

function load(): V4Record[] {
  try {
    const r = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  } catch {
    /* ada */
  }
  writeFileSync(FILE, JSON.stringify(records, null, 2));
}

export const allV4 = (): V4Record[] => records;
export const getV4 = (tokenId: string): V4Record | undefined => records.find((r) => r.tokenId === tokenId);

export function trackV4(rec: Omit<V4Record, 'openedAt' | 'lastInRange'> & { openedAt?: number }): void {
  if (records.some((r) => r.tokenId === rec.tokenId)) return;
  records.push({ ...rec, openedAt: rec.openedAt ?? Date.now() });
  persist();
}

export function removeV4(tokenId: string): void {
  const before = records.length;
  records = records.filter((r) => r.tokenId !== tokenId);
  if (records.length !== before) persist();
}

/**
 * Set status in-range. Return true HANYA bila berubah dari nilai yang sudah
 * pernah tercatat (set pertama tak memicu alert — hindari notifikasi palsu saat
 * posisi single-sided baru dibuka yang memang mulai out-of-range).
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
