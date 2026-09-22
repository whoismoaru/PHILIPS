/**
 * The Meteora DLMM positions a wallet holds, with what is actually in them.
 *
 * This used to decode PositionV2 by hand, at offsets established empirically (lb_pair at 8,
 * owner at 40, the bin ids at 7912/7916 in an 8120-byte account). That read a RANGE, which
 * was honest but thin: it could not say how much was deposited or what fees had accrued,
 * because converting a bin's liquidity share into token amounts needs every BinArray behind
 * the position. /positions could only print "value not read".
 *
 * The SDK is here now for opening positions, and it already does that conversion, so this
 * asks it instead. One call returns every position the wallet owns, per pool, with token
 * amounts and unclaimed fees. The hand decode is gone rather than kept as a second path:
 * two ways to read the same account is how the two drift.
 */
import { createRequire } from 'node:module';
import { Connection, PublicKey } from '@solana/web3.js';
import { isSolAddress } from './addr.js';
import { baseOfMint, type SolBase } from './bases.js';
import { binPrice } from './lbpair.js';
import { rpcUrl, solRpc } from './rpc.js';

const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const DLMM: any = req('@meteora-ag/dlmm');

export const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

export type SolPosition = {
  position: string;
  pool: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  binStep: number;
  inRange: boolean;
  /** The LP base this position is paired against, or null when it is neither SOL nor USDC. */
  base: SolBase | null;
  /** The non-base mint: the token actually being LP'd. */
  tokenMint: string;
  tokenDecimals: number | null;
  /** What is in the position NOW, in whole units of each side. */
  baseAmount: number;
  tokenAmount: number;
  /** Unclaimed fees, in whole units. */
  feeBase: number;
  feeToken: number;
  /** Price bounds in base per token, decimals already applied. */
  lowerPrice: number | null;
  upperPrice: number | null;
  /** The pool's current price, on the same scale as the bounds. */
  currentPrice: number | null;
  /** Everything valued in the base: the token side is priced at the current bin. */
  valueBase: number;
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

/** Every DLMM position this wallet owns. Empty when it holds none. */
export async function solPositions(owner: string): Promise<SolPosition[]> {
  if (!isSolAddress(owner)) throw new Error('not a Solana address');
  const url = rpcUrl();
  if (!url) throw new Error('SOLANA_RPC_URL is not set');
  const conn = new Connection(url, 'confirmed');
  // The owner goes in verbatim. Base58 is case-sensitive, and a folded key would match
  // nothing and read as "you have no positions".
  const byPair: Map<string, any> = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(owner));

  const out: SolPosition[] = [];
  for (const [pool, pair] of byPair) {
    const xMint = pair.tokenX.publicKey.toBase58();
    const yMint = pair.tokenY.publicKey.toBase58();
    const baseX = baseOfMint(xMint);
    const baseY = baseOfMint(yMint);
    const base = baseX ?? baseY ?? null;
    const baseIsX = !!baseX;
    const tokenMint = baseIsX ? yMint : xMint;
    const tokenDecimals = (baseIsX ? pair.tokenY.mint.decimals : pair.tokenX.mint.decimals) ?? null;
    const baseDecimals = base?.decimals ?? null;
    const binStep = Number(pair.lbPair.binStep);
    const activeBinId = Number(pair.lbPair.activeId);
    // The scale is the decimal DIFFERENCE between the two sides. Without it a bin price is
    // a raw ratio of base units and can be off by many orders of magnitude -- the bug that
    // misread a 9-decimal token as a 6-decimal one by a factor of 1000.
    const scale =
      tokenDecimals !== null && baseDecimals !== null ? Math.pow(10, tokenDecimals - baseDecimals) : null;
    const priceAt = (binId: number) => (scale === null ? null : binPrice(binStep, binId) * scale);

    for (const p of pair.lbPairPositionsData) {
      const d = p.positionData;
      const lowerBinId = Number(d.lowerBinId);
      const upperBinId = Number(d.upperBinId);
      // The SDK returns whole-unit strings for the amounts and raw units for the fees.
      const xAmount = Number(d.totalXAmount);
      const yAmount = Number(d.totalYAmount);
      const feeXRaw = Number(d.feeX?.toString() ?? 0);
      const feeYRaw = Number(d.feeY?.toString() ?? 0);
      const xDec = pair.tokenX.mint.decimals ?? 0;
      const yDec = pair.tokenY.mint.decimals ?? 0;
      const baseAmount = (baseIsX ? xAmount : yAmount) / Math.pow(10, baseIsX ? xDec : yDec);
      const tokenAmount = (baseIsX ? yAmount : xAmount) / Math.pow(10, baseIsX ? yDec : xDec);
      const feeBase = (baseIsX ? feeXRaw : feeYRaw) / Math.pow(10, baseIsX ? xDec : yDec);
      const feeToken = (baseIsX ? feeYRaw : feeXRaw) / Math.pow(10, baseIsX ? yDec : xDec);
      const currentPrice = priceAt(activeBinId);
      out.push({
        position: p.publicKey.toBase58(),
        pool,
        lowerBinId,
        upperBinId,
        activeBinId,
        binStep,
        inRange: activeBinId >= lowerBinId && activeBinId <= upperBinId,
        base,
        tokenMint,
        tokenDecimals,
        baseAmount,
        tokenAmount,
        feeBase,
        feeToken,
        lowerPrice: priceAt(lowerBinId),
        // The upper BOUND is the top of the last bin, not its floor, so it takes +1.
        upperPrice: priceAt(upperBinId + 1),
        currentPrice,
        // The token side is worth what it would sell for at the CURRENT bin. With no price
        // it is left out entirely rather than counted as zero, which would read as a loss.
        valueBase: baseAmount + (currentPrice !== null ? tokenAmount * currentPrice : 0),
      });
    }
  }
  return out;
}
