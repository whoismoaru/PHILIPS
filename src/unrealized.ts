import { ethers } from 'ethers';
import { CHAINS, ctxOf, isStableBase, type ChainCtx } from './chains.js';
import { getEthUsd } from './screening.js';
import { getPositionDetail } from './uniswap.js';
import { listPositionsV4, v4BaseDecimals } from './uniswapV4.js';
import * as store from './store.js';
import * as v4store from './v4store.js';

/**
 * Unrealized PnL: what the OPEN positions are worth against what went into them, in USD.
 *
 * The journal only knows trades that have already closed, so a recap built from it alone
 * reports a quiet day as flat while the money on the table moves. This reads the live
 * positions instead — v3 from the store, v4 from the chain — and values both the same way
 * their cards do: current value plus uncollected fees, minus the deposit.
 *
 * A position whose price or detail cannot be read is SKIPPED, never counted as zero, and
 * `read`/`total` say how much of the book the figure actually covers. null means nothing
 * could be read at all, which is not the same as "no profit".
 */
export async function unrealizedUsd(chain?: string): Promise<{ usd: number | null; read: number; total: number }> {
  const want = (k: string) => !chain || chain === k;
  let usd = 0;
  let read = 0;
  let total = 0;

  const rate = new Map<string, number | null>();
  const usdPer = async (cc: ChainCtx, stable: boolean): Promise<number | null> => {
    if (stable) return 1;
    if (!rate.has(cc.key)) rate.set(cc.key, await getEthUsd(cc.wethAddress, cc).catch(() => null));
    return rate.get(cc.key) ?? null;
  };

  // v3 — the bot's own records carry the deposit.
  for (const rec of store.active()) {
    if (!want(rec.chain ?? 'robinhood')) continue;
    total++;
    if (rec.imported) continue; // no cost basis was ever recorded, so there is no PnL to state
    try {
      const cc = ctxOf(rec);
      const d = await getPositionDetail(rec.tokenId, cc);
      const dec = d.baseDecimals;
      const now = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
      const cost = Number(ethers.formatUnits(BigInt(rec.initialWethWei || '0'), dec));
      if (cost <= 0) continue;
      const per = await usdPer(cc, isStableBase(d.baseKind));
      if (per === null) continue;
      usd += (now - cost) * per;
      read++;
    } catch {
      /* one unreadable position must not take the whole figure down with it */
    }
  }

  // v4 — enumerated from the chain, but only the ones the bot opened have a deposit to
  // compare against. An adopted position has no entry, so it is left out of the figure.
  for (const cc of Object.values(CHAINS)) {
    if (!want(cc.key)) continue;
    let ps: Awaited<ReturnType<typeof listPositionsV4>>;
    try {
      ps = await listPositionsV4(cc);
    } catch {
      continue;
    }
    for (const p of ps) {
      const tracked = v4store.getV4(p.tokenId);
      if (!tracked) continue;
      total++;
      if (p.valueBaseWei === null) continue;
      const dec = v4BaseDecimals(cc, p.base);
      const now = Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), dec));
      const cost = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
      if (cost <= 0) continue;
      const per = await usdPer(cc, p.base === 'USDG');
      if (per === null) continue;
      // The entry's OWN rate when it was stamped, so a move in ETH's price does not read
      // as LP profit. Without it a USDG figure and an ETH figure are not comparable.
      const entryPer = tracked.entryEthUsd && tracked.entryEthUsd > 0 ? tracked.entryEthUsd : per;
      usd += now * per - cost * entryPer;
      read++;
    }
  }

  return { usd: read ? usd : null, read, total };
}
