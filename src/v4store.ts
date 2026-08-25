import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './store.js';

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
  entryEthUsd?: number; // harga base(USD) saat open — PnL USD ala LP Agent (ETH: harga ETH; USDG: 1)
  entryTick?: number; // tick pool saat open — range % kartu dipatok ke sini (biar diam)
  entryMcap?: number; // market cap USD saat open — batas mcap kartu dipatok ke sini
  groupId?: string; // ladder Bid-Ask v4: N leg berbagi groupId = 1 posisi logis
  legIndex?: number;
  legCount?: number;
  shape?: 'spot' | 'bidask';
  openedAt: number;
  lastInRange?: boolean;
  dropTier?: number; // tangga alert anjlok yang sudah bunyi (setara v3)
  dropAlerted?: boolean;
  ilAlerted?: boolean; // alert rugi bersih sudah bunyi (re-arm saat pulih)
};

/** Semua leg satu grup ladder v4 (urut legIndex). */
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
    if (err.code !== 'ENOENT') console.error('[v4store] v4positions.json tak terbaca — mulai KOSONG:', err.message);
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

/** Tambal sebagian record (penanda alert). Tak ada = no-op. */
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
