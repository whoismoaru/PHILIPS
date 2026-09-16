import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './store.js';

/**
 * Notification settings (/alerts), stored in data/alerts.json.
 *
 * `ilPct` is the NET LOSS threshold: the position's value plus its unclaimed fees, against
 * the capital put in. For a single-sided LP, holding is exactly that capital, so this
 * figure is impermanent loss with the fees already netted off -- not the theoretical IL
 * formula, which ignores fees and alarms people for no reason.
 */

export type AlertSettings = {
  rangeNotify: boolean; // entering and leaving the range
  dropPct: number | null; // the token price fell X% from the open price (null turns it off)
  ilPct: number | null; // the position is X% net down (null turns it off)
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
      /* a corrupt file falls back to the defaults rather than killing the monitor */
    }
  }
  cache = { ...DEFAULTS };
  return cache;
}

export function set(patch: Partial<AlertSettings>): AlertSettings {
  cache = { ...get(), ...patch };
  writeJson(FILE, cache);
  return cache;
}

/** Cycle the value to the next option, used by the buttons. null turns it off. */
export function cycle(current: number | null, options: Array<number | null>): number | null {
  const i = options.findIndex((o) => o === current);
  return options[(i + 1) % options.length];
}
