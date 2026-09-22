/**
 * The Meteora DLMM positions a wallet holds, read straight from the chain.
 *
 * There is no API left to ask. Meteora's own endpoints answer 404 for pairs and return
 * nothing for wallets, so every field here comes out of account data.
 *
 * Positions are found with getProgramAccounts filtered on the owner field, which is why
 * this needs a keyed RPC: during the survey that built this, publicnode refused
 * getProgramAccounts outright with a 410 and mainnet-beta rate-limited every burst.
 *
 * PositionV2 is `repr(C)` with a fixed 8120-byte layout:
 *
 *   8     discriminator
 *   8     lb_pair            pubkey
 *   40    owner              pubkey
 *   72    liquidity_shares   u128 x 70   (1120 bytes)
 *   1192  reward_infos       48 x 70
 *   4552  fee_infos          48 x 70
 *   7912  lower_bin_id       i32
 *   7916  upper_bin_id       i32
 *
 * The two bin ids were located empirically and then cross-checked: scanning a live
 * position for any i32 pair that could be a bin range produced exactly ONE candidate, at
 * 7912, and the same offset then decoded correctly for positions in three other pools
 * (widths 8, 70, 69 and 56 bins, all within the 70-bin maximum). lb_pair at offset 8 also
 * matched the pool each position was queried under, every time.
 *
 * What this does NOT do is value the position. Converting a bin's liquidity share into
 * token amounts needs the BinArray accounts behind every bin, several more reads per
 * position, so it is left out rather than estimated. A range and an in/out answer are
 * exact; a made-up value would not be.
 */
import { isSolAddress, encodeBase58 } from './addr.js';
import { baseOfMint, type SolBase } from './bases.js';
import { binPrice, decodeLbPair, type LbPairInfo } from './lbpair.js';
import { accountData, solRpc } from './rpc.js';

export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

const OFF_LB_PAIR = 8;
const OFF_OWNER = 40;
const OFF_LOWER_BIN = 7912;
const OFF_UPPER_BIN = 7916;
const POSITION_LEN = OFF_UPPER_BIN + 4;

export type SolPosition = {
  position: string;
  pool: string;
  lowerBinId: number;
  upperBinId: number;
  /** The pool's live bin, so range is judged against the same read the prices came from. */
  activeBinId: number;
  binStep: number;
  baseFeePct: number;
  inRange: boolean;
  /** The LP base this position is paired against, or null when it is neither SOL nor USDC. */
  base: SolBase | null;
  /** The non-base mint: the token actually being LP'd. */
  tokenMint: string;
  /** Decimals of the LP'd token, READ FROM ITS MINT. Never assumed: pump.fun tokens are
   *  mostly 6, but plenty are 9, and guessing 6 misprices such a pool by 1000x. Null when
   *  the mint could not be read, which makes the price bounds unusable rather than wrong. */
  tokenDecimals: number | null;
  /** Price bounds in base per token, with decimals already applied. Null when the token's
   *  decimals could not be read. */
  lowerPrice: number | null;
  upperPrice: number | null;
};

/** Mint decimals, cached forever: a mint's decimals are fixed at creation. */
const decimalsCache = new Map<string, number>();

export async function mintDecimals(mint: string): Promise<number | null> {
  const hit = decimalsCache.get(mint);
  if (hit !== undefined) return hit;
  try {
    const r = await solRpc<{ value?: { data?: { parsed?: { info?: { decimals?: number } } } } }>(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed' }],
    );
    const d = r?.value?.data?.parsed?.info?.decimals;
    if (typeof d !== 'number') return null;
    decimalsCache.set(mint, d);
    return d;
  } catch {
    return null;
  }
}

export function decodePosition(data: Uint8Array): { pool: string; owner: string; lowerBinId: number; upperBinId: number } | null {
  if (data.length < POSITION_LEN) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lowerBinId = v.getInt32(OFF_LOWER_BIN, true);
  const upperBinId = v.getInt32(OFF_UPPER_BIN, true);
  // A position always spans at least one bin and never more than the 70 the account has
  // room for. Anything else means this is not a PositionV2, so say so rather than
  // returning a confident range read off the wrong account.
  if (upperBinId < lowerBinId || upperBinId - lowerBinId >= 70) return null;
  return {
    pool: encodeBase58(data.subarray(OFF_LB_PAIR, OFF_LB_PAIR + 32)),
    owner: encodeBase58(data.subarray(OFF_OWNER, OFF_OWNER + 32)),
    lowerBinId,
    upperBinId,
  };
}

/** Every DLMM position this wallet owns. Empty when it holds none. */
export async function solPositions(owner: string): Promise<SolPosition[]> {
  if (!isSolAddress(owner)) throw new Error('not a Solana address');
  const accounts = await solRpc<Array<{ pubkey: string; account: { data: [string, string] } }>>(
    'getProgramAccounts',
    [
      DLMM_PROGRAM,
      {
        encoding: 'base64',
        // The owner goes in verbatim. Base58 is case-sensitive, and a folded key here
        // would match nothing and read as "you have no positions".
        filters: [{ memcmp: { offset: OFF_OWNER, bytes: owner } }],
      },
    ],
    60_000,
  );

  const decoded = accounts
    .map((a) => ({ pubkey: a.pubkey, d: decodePosition(Uint8Array.from(Buffer.from(a.account.data[0], 'base64'))) }))
    .filter((x): x is { pubkey: string; d: NonNullable<ReturnType<typeof decodePosition>> } => x.d !== null);

  // One pool read per DISTINCT pool, not per position: a ladder puts several positions in
  // the same pool and would otherwise fetch the same account many times over.
  const pools = new Map<string, LbPairInfo | null>();
  await Promise.all(
    [...new Set(decoded.map((x) => x.d.pool))].map(async (p) => {
      const raw = await accountData(p).catch(() => null);
      pools.set(p, raw ? decodeLbPair(raw) : null);
    }),
  );

  // Decimals for every distinct LP'd token, fetched once each and cached across calls.
  const mints = new Set<string>();
  for (const { d } of decoded) {
    const pool = pools.get(d.pool);
    if (pool) mints.add(baseOfMint(pool.tokenX) ? pool.tokenY : pool.tokenX);
  }
  const decs = new Map<string, number | null>();
  await Promise.all([...mints].map(async (m) => decs.set(m, await mintDecimals(m))));

  const out: SolPosition[] = [];
  for (const { pubkey, d } of decoded) {
    const pool = pools.get(d.pool);
    if (!pool) continue; // an unreadable pool cannot be judged; it is not reported as flat
    const baseX = baseOfMint(pool.tokenX);
    const baseY = baseOfMint(pool.tokenY);
    const tokenMint = baseX ? pool.tokenY : pool.tokenX;
    const tokenDecimals = decs.get(tokenMint) ?? null;
    const baseDecimals = (baseX ?? baseY)?.decimals ?? null;
    // The scale is the decimal DIFFERENCE between the two sides. Without it the bin price
    // is a raw ratio of base units and can be off by many orders of magnitude.
    const scale =
      tokenDecimals !== null && baseDecimals !== null ? Math.pow(10, tokenDecimals - baseDecimals) : null;
    out.push({
      position: pubkey,
      pool: d.pool,
      lowerBinId: d.lowerBinId,
      upperBinId: d.upperBinId,
      activeBinId: pool.activeId,
      binStep: pool.binStep,
      baseFeePct: pool.baseFeePct,
      inRange: pool.activeId >= d.lowerBinId && pool.activeId <= d.upperBinId,
      base: baseX ?? baseY ?? null,
      tokenMint,
      tokenDecimals,
      lowerPrice: scale === null ? null : binPrice(pool.binStep, d.lowerBinId) * scale,
      // The upper BOUND is the top of the last bin, not its floor, so it takes +1.
      upperPrice: scale === null ? null : binPrice(pool.binStep, d.upperBinId + 1) * scale,
    });
  }
  return out;
}
