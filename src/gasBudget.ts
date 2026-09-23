/**
 * Gas may cost at most 3% of what the transaction moves. Fixed, not configurable.
 *
 * The broadcast hook in chains.ts only sees raw bytes: a token sell or an approve carries no
 * native value, so the percentage would have nothing to measure against. Each money flow
 * therefore states its value up front, per chain and in that chain's native units, and every
 * tx sent inside that same update -- approvals included -- is measured against it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const GAS_CAP_PCT = 3;

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
