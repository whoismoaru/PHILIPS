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
 * A deposit of the TOKEN counts too, valued in base at the active bin of its own deposit.
 * DLMM emits an AddLiquidity event (self-CPI) carrying both amounts and that bin. Counting
 * base alone left a token-side position with no entry at all: HUNG 6EH5 (12 Nov 2026) was
 * opened with 159,100 HUNG and 0 SOL, so it never got an entry, and PHILIPS closed it with
 * no PnL card and nothing in /pnl.
 *
 * ponytail: only DEPOSITS are counted. A withdrawal moves base back out and would reduce
 * the basis, but so does a fee claim, and the two are not worth telling apart for a number
 * that exists to answer "am I up". A position that has been partially withdrawn therefore
 * reads as though it still holds its whole deposit. Split them by instruction name if that
 * ever matters.
 */
import { decodeBase58, toBeArray } from 'ethers';
import { encodeBase58 } from './addr.js';
import { solRpc } from './rpc.js';
import { lbPair, binPrice } from './lbpair.js';

/** Enough for an open plus a few follow-ups; a position with more history is not a fresh entry. */
const MAX_TXS = 20;

export type SolEntryFacts = { entryBaseRaw: bigint; openedAt: number };

const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
// Anchor's event-CPI tag, then the AddLiquidity event's discriminator. Layout after them:
// lb_pair, from, position (32 bytes each), amounts [u64; 2] (X, Y), active_bin_id i32.
const EVENT_TAG = 'e445a52e51cb9a1d';
const ADD_LIQUIDITY = '1f5e7d5ae3343dba';

/** Every AddLiquidity event for `position` in one transaction: [amountX, amountY, activeBin]. */
export function addLiquidityEvents(tx: any, position: string): Array<[bigint, bigint, number]> {
  const out: Array<[bigint, bigint, number]> = [];
  for (const g of tx?.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions ?? []) {
      if (ix.programId !== DLMM || typeof ix.data !== 'string') continue;
      let d: Buffer;
      try {
        d = Buffer.from(toBeArray(decodeBase58(ix.data))); // the event tag leads with 0xe4, so no zero bytes are lost
      } catch {
        continue;
      }
      if (d.length < 132 || d.subarray(0, 8).toString('hex') !== EVENT_TAG || d.subarray(8, 16).toString('hex') !== ADD_LIQUIDITY) continue;
      if (encodeBase58(d.subarray(80, 112)) !== position) continue;
      out.push([d.readBigUInt64LE(112), d.readBigUInt64LE(120), d.readInt32LE(128)]);
    }
  }
  return out;
}

export async function backfillEntry(position: string, pool: string, baseMint: string): Promise<SolEntryFacts | null> {
  const sigs = await solRpc<Array<{ signature: string; blockTime: number | null }>>(
    'getSignaturesForAddress',
    [position, { limit: MAX_TXS }],
  ).catch(() => []);
  if (sigs.length === 0) return null;
  // Oldest last: that one created the position.
  const oldest = sigs[sigs.length - 1];
  if (!oldest?.blockTime) return null;
  const lp = await lbPair(pool).catch(() => null);

  let deposited = 0n;
  let fromEvents = 0n;
  let sawEvent = false;
  for (const s of sigs) {
    const tx = await solRpc<any>('getTransaction', [
      s.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]).catch(() => null);
    if (!tx?.meta || tx.meta.err) continue;
    // Both sides from the event: raw bin price is Y raw per X raw, so no decimals apply.
    if (lp) {
      const baseIsX = lp.tokenX === baseMint;
      for (const [x, y, active] of addLiquidityEvents(tx, position)) {
        sawEvent = true;
        const px = binPrice(lp.binStep, active);
        fromEvents += baseIsX ? x + BigInt(Math.round(Number(y) / px)) : y + BigInt(Math.round(Number(x) * px));
      }
    }
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
  // The events where they exist (they price the token side too); the base delta otherwise.
  const entry = sawEvent ? fromEvents : deposited;
  if (entry <= 0n) return null;
  return { entryBaseRaw: entry, openedAt: oldest.blockTime * 1000 };
}
