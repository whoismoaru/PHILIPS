import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseKind } from './chains.js';

/**
 * Atomic JSON writes: write a temporary file, then rename, which is atomic on POSIX.
 * A crash or an OOM mid-write can no longer truncate the real file.
 */
export function writeJson(file: string, data: unknown): void {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  renameSync(file + '.tmp', file);
}

/**
 * Simple LP position storage, in a JSON file.
 * It backs PnL, the ACTIVE/STOPPED status, and the automatic monitor.
 */

export type PosRecord = {
  tokenId: string;
  chain?: string; // the chain key ('robinhood' and so on); empty means robinhood, an older position
  venue?: string; // a non-default DEX on the chain ('uniswapv3' on BSC); empty means the default
  ca: string; // alamat token (non-base)
  fee: number;
  symbol: string;
  baseKind?: BaseKind; // the paired asset; empty means weth, an older position
  initialWethWei: string; // the capital deposited, in base units (WETH 18-dec, USDG 6-dec)
  nominalEth?: string; // the amount the user picked, for a clean display
  rangeLowPct?: number; // the far end as a % of the price at open
  rangeHighPct?: number; // % ujung terdekat
  openedAt: number; // epoch ms
  status: 'ACTIVE' | 'STOPPED';
  lastInRange?: boolean; // for the auto-monitor notifications
  entryPrice?: string; // the token price in the base at open, for the drop alert; empty means an older position
  entryMcap?: number; // the USD market cap at open; the card's mcap bounds anchor here so they stay still
  entryEthUsd?: number; // the base price in USD at open; LP-Agent-style USD PnL anchors here (ETH's price for weth, 1 for a stable)
  convertedAlerted?: boolean; // has the fully-converted alert been sent? reset once back in range
  ilAlerted?: boolean; // has the net-loss alert been sent? reset on recovery
  dropAlerted?: boolean; // LEGACY: has the drop alert been sent? migrated into dropTier
  dropTier?: number; // how many drop rungs have already alerted (0 means none)
  stoppedAt?: number;
  resultEthWei?: string; // the ETH received at stop, for the final PnL
  imported?: boolean; // found on chain rather than opened by the bot, so its entry is unknown
  leftoverWei?: string; // tokens from this position not yet cashed out; it caps what auto-sweep may sell, protecting a spot bag
  /** The side deposited at open. Always 'base' since 16 Sep 2026 -- the token side was
   *  removed. 'token' is still READ so records written before then keep working. */
  side?: 'base' | 'token';
  nominalToken?: string; // the token amount deposited, on the token side
  groupId?: string; // a bid-ask or spot ladder: N legs sharing a groupId make one logical position; empty means a single position
  legIndex?: number; // the leg's order within the group (0 is nearest the price)
  legCount?: number; // the total number of legs in the group
  shape?: 'spot' | 'bidask'; // how the ladder distributes its capital
};

/** Every leg of one ladder group, ordered by legIndex. An empty groupId returns an empty array. */
export function group(groupId: string): PosRecord[] {
  return records.filter((r) => r.groupId === groupId).sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0));
}

const FILE = join(process.cwd(), 'data', 'positions.json');

let records: PosRecord[] = load();

function load(): PosRecord[] {
  try {
    if (!existsSync(FILE)) return [];
    return JSON.parse(readFileSync(FILE, 'utf8')) as PosRecord[];
  } catch (e) {
    // Starting EMPTY would be suicide: the monitor calls update() within the first 60
    // seconds, and persist() would overwrite the only copy of every position's deposit
    // (initialWethWei), entry price and status. Set the damaged file aside and STOP -- far
    // better to let systemd restart noisily than to amputate positions in silence.
    const aside = `${FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(FILE, aside);
    } catch {
      /* even if it cannot be moved aside, do not carry on */
    }
    console.error(`[store] positions.json is corrupt (${(e as Error).message}), moved aside to ${aside}`);
    throw e;
  }
}

function persist() {
  writeJson(FILE, records);
}

/**
 * Token ids currently being closed, valued by the epoch the close began. Read by the
 * monitor and by the double-tap guard. It lives here rather than in index.ts so monitor.ts
 * can see it too.
 */
export const closing = new Map<string, number>();

/**
 * Money operations in flight (add, close, swap, bridge). The monitor must not sweep or
 * unwrap while this is above zero: two transactions from one wallet collide on the nonce,
 * and sweepStuckWeth could swallow WETH that was just wrapped for a mint.
 */
let moneyOps = 0;
export const beginMoneyOp = (): void => {
  moneyOps++;
};
export const endMoneyOp = (): void => {
  moneyOps = Math.max(0, moneyOps - 1);
};
export const isBusy = (): boolean => moneyOps > 0 || closing.size > 0;

export const all = (): PosRecord[] => records;
export const active = (): PosRecord[] => records.filter((r) => r.status === 'ACTIVE');
export const get = (tokenId: string): PosRecord | undefined => records.find((r) => r.tokenId === tokenId);

/** Import a position found on chain rather than opened here. A no-op if it already exists. */
export function addImported(rec: {
  tokenId: string;
  chain: string;
  ca: string;
  fee: number;
  symbol: string;
  baseKind: BaseKind;
}): void {
  if (records.some((r) => r.tokenId === rec.tokenId)) return;
  records.push({
    tokenId: rec.tokenId,
    chain: rec.chain,
    ca: rec.ca,
    fee: rec.fee,
    symbol: rec.symbol,
    baseKind: rec.baseKind,
    initialWethWei: '0', // the entry is unknown
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

/** Drop a position from the live store; its history already moved to the journal. */
export function remove(tokenId: string) {
  const before = records.length;
  records = records.filter((r) => r.tokenId !== tokenId);
  if (records.length !== before) persist();
}
