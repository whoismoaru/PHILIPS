import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Angka persen yang muncul sebagai tombol di alur nominal. Disimpan di
 * data/pctpresets.json supaya bertahan lintas restart.
 *
 * Sebelumnya keempat alur memakai angka yang dipatok di kode (dan berbeda-beda:
 * /add memakai 30/50/70/90, sisanya 25/50/75/100). Mengubahnya berarti mengedit
 * empat tempat lalu restart, jadi praktis tak pernah diubah.
 */
export type PctFlow = 'buy' | 'sell' | 'add' | 'stop' | 'bridge' | 'legs';

export const FLOW_LABEL: Record<PctFlow, string> = {
  buy: 'Buy',
  sell: 'Sell',
  add: 'Add LP',
  stop: 'Withdraw',
  bridge: 'Bridge',
  legs: 'Ladder legs',
};

// `stop` sengaja tanpa 100: menarik seluruhnya = menutup posisi, dan itu punya
// tombolnya sendiri (jalur close, bukan decreaseLiquidity sebagian).
const DEFAULTS: Record<PctFlow, number[]> = {
  buy: [25, 50, 75, 100],
  sell: [25, 50, 75, 100],
  add: [30, 50, 70, 90],
  stop: [25, 50, 75],
  bridge: [25, 50, 75, 100],
  // Bukan persen: jumlah anak tangga ladder bid-ask.
  legs: [8, 9, 10, 69],
};

const FILE = join(process.cwd(), 'data', 'pctpresets.json');
const MAX_BUTTONS = 4; // lebih dari ini tombolnya terpotong di layar sempit

let cache: Record<PctFlow, number[]> | null = null;

/**
 * Batas nilai yang sah per alur.
 *
 * `stop` berhenti di 99: menarik 100% berarti MENUTUP posisi, dan itu jalur kode
 * yang berbeda dengan tombolnya sendiri. `legs` bukan persen sama sekali — itu
 * jumlah anak tangga, minimal 2 (satu leg bukan ladder) dan dibatasi 69 seperti
 * jalur open-nya.
 */
const BOUNDS: Record<PctFlow, { min: number; max: number }> = {
  buy: { min: 1, max: 100 },
  sell: { min: 1, max: 100 },
  add: { min: 1, max: 100 },
  stop: { min: 1, max: 99 },
  bridge: { min: 1, max: 100 },
  legs: { min: 2, max: 69 },
};
export const boundsFor = (flow: PctFlow) => BOUNDS[flow];
/** Satuan yang dipakai kartu setelan — '%' untuk nominal, 'legs' untuk ladder. */
export const unitFor = (flow: PctFlow): string => (flow === 'legs' ? 'legs' : '%');

/** Nilai sah: bilangan bulat dalam jangkauan alurnya, urut naik, tanpa kembar, maksimal 4. */
export function sanitize(values: number[], flow: PctFlow): number[] | null {
  // Angka di luar jangkauan DITOLAK, bukan disaring diam-diam: "0 50" hampir pasti
  // salah ketik, dan menyimpannya sebagai "50" membuat user mengira 0 diterima.
  const { min, max } = BOUNDS[flow];
  if (values.some((v) => !Number.isInteger(v) || v < min || v > max)) return null;
  const clean = [...new Set(values)].sort((a, b) => a - b);
  if (clean.length === 0 || clean.length > MAX_BUTTONS) return null;
  return clean;
}

function load(): Record<PctFlow, number[]> {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  if (existsSync(FILE)) {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Record<PctFlow, number[]>>;
      for (const f of Object.keys(DEFAULTS) as PctFlow[]) {
        const v = raw[f];
        const ok = Array.isArray(v) ? sanitize(v, f) : null;
        if (ok) cache[f] = ok;
      }
    } catch {
      /* berkas rusak → pakai bawaan, jangan matikan alur nominal */
    }
  }
  return cache;
}

export const get = (flow: PctFlow): number[] => [...load()[flow]];
export const all = (): Record<PctFlow, number[]> => ({ ...load() });
export const defaultsFor = (flow: PctFlow): number[] => [...DEFAULTS[flow]];

export function set(flow: PctFlow, values: number[]): number[] | null {
  const ok = sanitize(values, flow);
  if (!ok) return null;
  const next = { ...load(), [flow]: ok };
  cache = next;
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return ok;
}

export function reset(flow: PctFlow): number[] {
  return set(flow, DEFAULTS[flow]) ?? DEFAULTS[flow];
}

/** Siapa yang sedang diminta mengetik angka persen (userId → alur). */
const pending = new Map<number, PctFlow>();
export const askEdit = (userId: number, flow: PctFlow): void => void pending.set(userId, flow);
export const pendingEdit = (userId: number): PctFlow | undefined => pending.get(userId);
export const clearEdit = (userId: number): void => void pending.delete(userId);

/** "10 25 50, 90" / "10/25/50/90" → [10,25,50,90]. Gagal → null. */
export function parseList(raw: string): number[] | null {
  const parts = raw.split(/[\s,/|]+/).map((x) => x.replace('%', '').trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  return nums.some((n) => !Number.isFinite(n)) ? null : nums;
}
