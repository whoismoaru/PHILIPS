import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Setelan notifikasi (/alerts). Disimpan di data/alerts.json.
 *
 * `ilPct` = ambang RUGI BERSIH posisi: nilai posisi + fee belum diklaim,
 * dibandingkan modal saat buka. Untuk LP satu sisi, "hodl" = modal itu sendiri,
 * jadi angka ini memang impermanent loss yang sudah dikurangi fee — bukan
 * rumus IL teoretis yang mengabaikan fee dan menakuti tanpa sebab.
 */

export type AlertSettings = {
  rangeNotify: boolean; // masuk/keluar rentang
  dropPct: number | null; // harga token anjlok X% dari harga buka (null = mati)
  ilPct: number | null; // rugi bersih posisi X% (null = mati)
};

const FILE = join(process.cwd(), 'data', 'alerts.json');
const DEFAULTS: AlertSettings = { rangeNotify: true, dropPct: 25, ilPct: null };

let cache: AlertSettings | null = null;

export function get(): AlertSettings {
  if (cache) return cache;
  if (existsSync(FILE)) {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AlertSettings>;
      cache = {
        rangeNotify: raw.rangeNotify ?? DEFAULTS.rangeNotify,
        dropPct: raw.dropPct === undefined ? DEFAULTS.dropPct : raw.dropPct,
        ilPct: raw.ilPct === undefined ? DEFAULTS.ilPct : raw.ilPct,
      };
      return cache;
    } catch {
      /* berkas rusak → pakai default, jangan matikan monitor */
    }
  }
  cache = { ...DEFAULTS };
  return cache;
}

export function set(patch: Partial<AlertSettings>): AlertSettings {
  cache = { ...get(), ...patch };
  writeFileSync(FILE, JSON.stringify(cache, null, 2));
  return cache;
}

/** Putar nilai ke pilihan berikutnya (dipakai tombol). null = mati. */
export function cycle(current: number | null, options: Array<number | null>): number | null {
  const i = options.findIndex((o) => o === current);
  return options[(i + 1) % options.length];
}
