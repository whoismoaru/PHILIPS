import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Penyimpanan posisi LP sederhana (file JSON).
 * Dipakai untuk PnL, status ACTIVE/STOPPED, dan auto-monitor.
 */

export type PosRecord = {
  tokenId: string;
  chain?: string; // kunci chain ('robinhood' dst); kosong = robinhood (posisi lama)
  ca: string; // alamat token (non-base)
  fee: number;
  symbol: string;
  baseKind?: 'weth' | 'usdg' | 'usdt'; // aset pasangan; kosong = weth (posisi lama)
  initialWethWei: string; // modal awal (base disetor) dalam unit base (WETH 18-dec / USDG 6-dec)
  nominalEth?: string; // nominal yang dipilih user (tampilan bersih)
  rangeLowPct?: number; // % ujung terjauh dari harga saat buka
  rangeHighPct?: number; // % ujung terdekat
  openedAt: number; // epoch ms
  status: 'ACTIVE' | 'STOPPED';
  lastInRange?: boolean; // untuk notifikasi auto-monitor
  entryPrice?: string; // harga token dalam base saat buka (untuk alert anjlok); kosong = posisi lama
  dropAlerted?: boolean; // sudah kirim alert anjlok? (reset saat harga pulih — anti-spam)
  stoppedAt?: number;
  resultEthWei?: string; // ETH diterima saat stop (untuk PnL final)
  imported?: boolean; // ditemukan on-chain (bukan dibuka via bot) → entry tak diketahui
};

const FILE = join(process.cwd(), 'data', 'positions.json');

let records: PosRecord[] = load();

function load(): PosRecord[] {
  try {
    if (!existsSync(FILE)) return [];
    return JSON.parse(readFileSync(FILE, 'utf8')) as PosRecord[];
  } catch {
    return [];
  }
}

function persist() {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(records, null, 2));
}

export const all = (): PosRecord[] => records;
export const active = (): PosRecord[] => records.filter((r) => r.status === 'ACTIVE');
export const get = (tokenId: string): PosRecord | undefined => records.find((r) => r.tokenId === tokenId);

/** Impor posisi yang ditemukan on-chain (bukan dibuka via bot). No-op bila sudah ada. */
export function addImported(rec: {
  tokenId: string;
  chain: string;
  ca: string;
  fee: number;
  symbol: string;
  baseKind: 'weth' | 'usdg' | 'usdt';
}): void {
  if (records.some((r) => r.tokenId === rec.tokenId)) return;
  records.push({
    tokenId: rec.tokenId,
    chain: rec.chain,
    ca: rec.ca,
    fee: rec.fee,
    symbol: rec.symbol,
    baseKind: rec.baseKind,
    initialWethWei: '0', // entry tak diketahui
    openedAt: Date.now(),
    status: 'ACTIVE',
    imported: true,
  });
  persist();
}

export function add(rec: PosRecord) {
  records = records.filter((r) => r.tokenId !== rec.tokenId).concat(rec);
  persist();
}

export function update(tokenId: string, patch: Partial<PosRecord>) {
  const r = records.find((x) => x.tokenId === tokenId);
  if (!r) return;
  Object.assign(r, patch);
  persist();
}

/** Keluarkan posisi dari store live (history sudah pindah ke jurnal). */
export function remove(tokenId: string) {
  const before = records.length;
  records = records.filter((r) => r.tokenId !== tokenId);
  if (records.length !== before) persist();
}

// ---------- pengaturan (preset nominal per-aset: ETH & Stablecoin) ----------
// 'stable' dipakai bersama USDG+USDT (dua-duanya $1, 6-desimal).

const SETTINGS_FILE = join(process.cwd(), 'data', 'settings.json');
export type SizeKind = 'eth' | 'stable';
const DEFAULT_SIZES: Record<SizeKind, number[]> = {
  eth: [0.01, 0.05, 0.1, 0.5],
  stable: [10, 50, 100, 250],
};

type Settings = { sizes: Record<SizeKind, number[]> };

const cleanList = (a: unknown, kind: SizeKind): number[] => {
  const arr = Array.isArray(a) ? a.filter((x): x is number => typeof x === 'number' && x > 0) : [];
  const uniq = [...new Set(arr)].sort((x, y) => x - y);
  return uniq.length ? uniq : [...DEFAULT_SIZES[kind]];
};

let settings: Settings = loadSettings();

function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { sizes?: unknown };
    // Migrasi format lama (sizes = array ETH) → { eth, stable }.
    if (Array.isArray(s.sizes)) {
      return { sizes: { eth: cleanList(s.sizes, 'eth'), stable: [...DEFAULT_SIZES.stable] } };
    }
    if (s.sizes && typeof s.sizes === 'object') {
      const o = s.sizes as Record<string, unknown>;
      return { sizes: { eth: cleanList(o.eth, 'eth'), stable: cleanList(o.stable, 'stable') } };
    }
  } catch {
    /* pakai default */
  }
  return { sizes: { eth: [...DEFAULT_SIZES.eth], stable: [...DEFAULT_SIZES.stable] } };
}

function persistSettings() {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export const getSizes = (kind: SizeKind): number[] => [...settings.sizes[kind]];

export function setSizes(kind: SizeKind, sizes: number[]) {
  settings.sizes[kind] = cleanList(sizes, kind);
  persistSettings();
}
