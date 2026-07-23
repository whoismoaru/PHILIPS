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

// ---------- pengaturan (preset nominal ETH, dst) ----------

const SETTINGS_FILE = join(process.cwd(), 'data', 'settings.json');
const DEFAULT_SIZES = [0.01, 0.05, 0.1, 0.5];

type Settings = { sizes: number[] };

let settings: Settings = loadSettings();

function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
    if (Array.isArray(s.sizes) && s.sizes.every((x) => typeof x === 'number' && x > 0)) return s;
  } catch {
    /* pakai default */
  }
  return { sizes: [...DEFAULT_SIZES] };
}

function persistSettings() {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export const getSizes = (): number[] => [...settings.sizes];

export function setSizes(sizes: number[]) {
  settings.sizes = [...new Set(sizes.filter((x) => x > 0))].sort((a, b) => a - b);
  if (settings.sizes.length === 0) settings.sizes = [...DEFAULT_SIZES];
  persistSettings();
}
