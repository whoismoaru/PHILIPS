/**
 * What a transaction may pay in gas, on every chain:
 *
 *   allowed = max(3% of the value moved, $0.10), never above $2
 *
 * The $0.10 allowance keeps small trades, approvals and closes from being priced out (a pure
 * 3% let 0.001 SOL bid 0.00003 SOL and expire, 23 Sep 2026); the $2 ceiling means the same on
 * every chain, unlike a native-unit cap where 0.005 is $20 in ETH and $3 in BNB.
 *
 * The EVM broadcast hook only sees raw bytes: a token sell or an approve carries no native
 * value. So each money flow states its value up front, per chain and in native units, and
 * every tx sent inside that same update is measured against it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const GAS_CAP_PCT = 3;
export const GAS_MIN_USD = 0.1;
export const GAS_MAX_USD = 2;

/** Dollars of gas a trade worth `valueUsd` may spend. Unknown value gets the allowance. */
export function allowedGasUsd(valueUsd: number | null | undefined): number {
  const pct = valueUsd && valueUsd > 0 ? (valueUsd * GAS_CAP_PCT) / 100 : 0;
  return Math.min(GAS_MAX_USD, Math.max(GAS_MIN_USD, pct));
}

const als = new AsyncLocalStorage<Map<string, number>>();

/** Run one Telegram update inside its own budget scope. */
export const withGasScope = <T>(fn: () => T): T => als.run(new Map(), fn);

/** The value this flow moves on `chainKey`, in native units. The largest stated wins. */
export function setGasValue(chainKey: string, nativeAmount: number): void {
  const m = als.getStore();
  if (!m || !(nativeAmount > 0)) return;
  m.set(chainKey, Math.max(m.get(chainKey) ?? 0, nativeAmount));
}

export const gasValue = (chainKey: string): number | undefined => als.getStore()?.get(chainKey);

/**
 * The native price, injected by index.ts: the price code lives in screening.ts, which imports
 * chains.ts, and chains.ts is where the hook runs -- importing it here would be a cycle.
 */
let priceFn: (chainKey: string) => Promise<number | null> = async () => null;
export const setNativePriceFn = (fn: typeof priceFn): void => {
  priceFn = fn;
};
export const nativeUsd = (chainKey: string): Promise<number | null> => priceFn(chainKey).catch(() => null);
