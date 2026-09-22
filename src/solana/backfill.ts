/**
 * The entry for a position the bot did not open.
 *
 * A DLMM position account carries no cost basis and no opening time, so a position created
 * on Meteora's own site showed "PnL: — (entry unknown)" and an empty age forever. Both are
 * recoverable from the position's own transaction history: the deposit is the base that
 * moved INTO the pool in those transactions, and the opening time is the oldest one.
 *
 * Verified against a real position on 23 Sep 2026: AJYVacgq… was opened across two
 * transactions, 1.97183098 and 0.02816901 SOL into the pool account, which is the 2.0 SOL
 * that was actually deposited.
 *
 * ponytail: only DEPOSITS are counted. A withdrawal moves base back out and would reduce
 * the basis, but so does a fee claim, and the two are not worth telling apart for a number
 * that exists to answer "am I up". A position that has been partially withdrawn therefore
 * reads as though it still holds its whole deposit. Split them by instruction name if that
 * ever matters.
 */
import { solRpc } from './rpc.js';

/** Enough for an open plus a few follow-ups; a position with more history is not a fresh entry. */
const MAX_TXS = 20;

export type SolEntryFacts = { entryBaseRaw: bigint; openedAt: number };

export async function backfillEntry(position: string, pool: string, baseMint: string): Promise<SolEntryFacts | null> {
  const sigs = await solRpc<Array<{ signature: string; blockTime: number | null }>>(
    'getSignaturesForAddress',
    [position, { limit: MAX_TXS }],
  ).catch(() => []);
  if (sigs.length === 0) return null;
  // Oldest last: that one created the position.
  const oldest = sigs[sigs.length - 1];
  if (!oldest?.blockTime) return null;

  let deposited = 0n;
  for (const s of sigs) {
    const tx = await solRpc<any>('getTransaction', [
      s.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]).catch(() => null);
    if (!tx?.meta || tx.meta.err) continue;
    const pre: any[] = tx.meta.preTokenBalances ?? [];
    const post: any[] = tx.meta.postTokenBalances ?? [];
    for (const p of post) {
      // The POOL's own reserve, not the owner's wallet: a deposit is base arriving there.
      // Matching on the mint alone would also catch the wrapped-SOL account the deposit
      // passes through, and count the same lamports twice.
      if (p.mint !== baseMint || p.owner !== pool) continue;
      const b = pre.find((x) => x.accountIndex === p.accountIndex);
      const delta = BigInt(p.uiTokenAmount.amount) - BigInt(b?.uiTokenAmount?.amount ?? '0');
      if (delta > 0n) deposited += delta;
    }
  }
  if (deposited <= 0n) return null;
  return { entryBaseRaw: deposited, openedAt: oldest.blockTime * 1000 };
}
