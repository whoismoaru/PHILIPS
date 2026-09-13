import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The percentages that appear as buttons on every amount step, stored in
 * data/pctpresets.json so they survive a restart.
 *
 * Each flow used to carry its own hardcoded set, and they disagreed: /add offered
 * 30/50/70/90 while the rest offered 25/50/75/100. Changing one meant editing four places
 * and restarting, so in practice they were never changed at all.
 */
export type PctFlow = 'buy' | 'sell' | 'add' | 'stop' | 'bridge' | 'legs' | 'send';

export const FLOW_LABEL: Record<PctFlow, string> = {
  buy: 'Buy',
  sell: 'Sell',
  add: 'Add LP',
  stop: 'Withdraw',
  bridge: 'Bridge',
  legs: 'Ladder legs',
  send: 'Send',
};

// `stop` deliberately omits 100: pulling everything out means closing the position, which
// has its own button and its own path -- not a partial decreaseLiquidity.
const DEFAULTS: Record<PctFlow, number[]> = {
  buy: [25, 50, 75, 100],
  sell: [25, 50, 75, 100],
  add: [30, 50, 70, 90],
  stop: [25, 50, 75],
  bridge: [25, 50, 75, 100],
  // Not a percentage: the number of rungs in a bid-ask ladder.
  legs: [8, 9, 10, 69],
  send: [25, 50, 75, 100],
};

const FILE = join(process.cwd(), 'data', 'pctpresets.json');
// Six, not four. A limit of four forced the owner to drop a number they wanted: on 28 Aug
// 2026 four attempts to set presets were rejected in a row because the list held five
// values, and what finally saved was the version without 100%. The buttons now wrap onto
// several rows, so screen width is no longer a reason to stop at four.
const MAX_BUTTONS = 6;

/** Split buttons into rows of at most four; beyond that they truncate on a narrow phone. */
export function chunkButtons<T>(items: T[], per = 4): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out;
}

let cache: Record<PctFlow, number[]> | null = null;

/**
 * The valid range for each flow.
 *
 * `stop` stops at 99: taking 100% out means CLOSING the position, which is a different code
 * path with its own button. `legs` is not a percentage at all -- it is a number of rungs,
 * at least 2 (one leg is not a ladder) and capped at 69, matching the open path.
 */
const BOUNDS: Record<PctFlow, { min: number; max: number }> = {
  buy: { min: 1, max: 100 },
  sell: { min: 1, max: 100 },
  add: { min: 1, max: 100 },
  stop: { min: 1, max: 99 },
  bridge: { min: 1, max: 100 },
  legs: { min: 2, max: 69 },
  send: { min: 1, max: 100 },
};
export const boundsFor = (flow: PctFlow) => BOUNDS[flow];
/** The unit the settings card shows: '%' for amounts, 'legs' for a ladder. */
export const unitFor = (flow: PctFlow): string => (flow === 'legs' ? 'legs' : '%');

/** Valid values: whole numbers inside the flow's range, ascending, no duplicates, at most 4. */
export function sanitize(values: number[], flow: PctFlow): number[] | null {
  // Out-of-range numbers are REJECTED rather than quietly filtered: "0 50" is almost certainly
  // a typo, and storing it as "50" would let the user believe the 0 was accepted.
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
      /* a corrupt file falls back to the defaults rather than killing the amount flow */
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

/**
 * Who is currently being asked to type numbers (userId -> flow).
 *
 * It EXPIRES. It used to have no deadline: tap Edit, walk away without answering, and this
 * marker stayed forever -- and because its answer is checked FIRST in the text handler,
 * every later message (an /add amount, a /buy amount, anything) was swallowed as a
 * "percentage list" and rejected. It happened on 28 Aug 2026: four rejections in a row
 * before the attempt was abandoned.
 */
const PENDING_TTL_MS = 5 * 60_000;
const pending = new Map<number, { flow: PctFlow; at: number }>();
export const askEdit = (userId: number, flow: PctFlow): void => void pending.set(userId, { flow, at: Date.now() });
export function pendingEdit(userId: number): PctFlow | undefined {
  const p = pending.get(userId);
  if (!p) return undefined;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(userId);
    return undefined;
  }
  return p.flow;
}
export const clearEdit = (userId: number): void => void pending.delete(userId);

/** "10 25 50, 90" / "10/25/50/90" → [10,25,50,90]. Anything else returns null. */
export function parseList(raw: string): number[] | null {
  const parts = raw.split(/[\s,/|]+/).map((x) => x.replace('%', '').trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  return nums.some((n) => !Number.isFinite(n)) ? null : nums;
}

// ─── default LP shape ────────────────────────────────────────────────────────
/**
 * SPOT or BID-ASK, chosen once in /settings instead of on every deposit.
 *
 * It used to be a wizard step, which asked the same question every time for an answer
 * that almost never changes. Stored beside the presets so it survives a restart.
 */
export type LpShape = 'spot' | 'bidask';
const SHAPE_FILE = join(process.cwd(), 'data', 'lpshape.json');

export function shape(): LpShape {
  try {
    const v = JSON.parse(readFileSync(SHAPE_FILE, 'utf8'))?.shape;
    return v === 'bidask' ? 'bidask' : 'spot';
  } catch {
    return 'spot'; // one position that earns fees -- the safer default of the two
  }
}

export function setShape(v: LpShape): LpShape {
  writeFileSync(SHAPE_FILE, JSON.stringify({ shape: v }), 'utf8');
  return v;
}
