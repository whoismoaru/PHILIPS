/**
 * Opening a single-sided Meteora DLMM position.
 *
 * This is the one place the Meteora SDK is used. Everything else on the Solana side reads
 * accounts directly, because reading is a decode; opening a position is not. It creates a
 * position account, initialises whichever bin arrays do not exist yet, wraps SOL, and
 * encodes a per-bin liquidity distribution -- several instructions whose layouts change
 * with the program. Hand-rolling that would be a bug farm holding real money.
 *
 * The SDK ships a broken ESM build (its anchor dependency uses a directory import that
 * Node refuses), so it is loaded through createRequire as CJS. Its CommonJS export IS the
 * DLMM class, with the named exports hung off it.
 *
 * Single-sided only, and always the BASE side, which is the same invariant the EVM paths
 * carry: deposit SOL or USDC into bins BELOW the active one and wait for price to fall
 * into the token. The token side is never deposited.
 */
import { highPriorityMicro, broadcastOfficial } from './fees.js';
import { createRequire } from 'node:module';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import { rpcUrl } from './rpc.js';
import { baseOfMint } from './bases.js';
import type { SolKeypair } from './keys.js';
import { encodeBase58 } from './addr.js';

const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const DLMM: any = req('@meteora-ag/dlmm');
const BN: any = req('bn.js');

/** A position account holds 70 bins, so a range spans at most 69 steps from the edge. */
export const MAX_BINS = 69;

export type OpenPlan = {
  /** Bins the deposit is spread across. */
  bins: number;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  /** The base being deposited. */
  baseSymbol: string;
  baseDecimals: number;
  /** True when the base is token X, which puts the range ABOVE the active bin instead. */
  baseIsX: boolean;
};

function connection(): Connection {
  const url = rpcUrl();
  if (!url) throw new Error('SOLANA_RPC_URL is not set');
  return new Connection(url, 'confirmed');
}

/**
 * How many bins a percentage range covers at this bin step.
 *
 * Each bin is (1 + binStep/10000) wide, so a range of p percent needs
 * log(1 - p/100) / log(1 + binStep/10000) of them. Rounded UP: a range that comes out
 * short would stop earning before the price the owner asked for.
 */
export function binsForRange(binStep: number, rangePct: number): number {
  if (!(binStep > 0) || !(rangePct > 0) || rangePct >= 100) return 1;
  const n = Math.ceil(Math.log(1 - rangePct / 100) / Math.log(1 / (1 + binStep / 10_000)));
  return Math.max(1, Math.min(MAX_BINS, n));
}

/** Bins a range needs, with no per-position cap: a ladder splits them across legs. */
export function binsForRangeUncapped(binStep: number, rangePct: number): number {
  if (!(binStep > 0) || !(rangePct > 0) || rangePct >= 100) return 1;
  return Math.max(1, Math.ceil(Math.log(1 - rangePct / 100) / Math.log(1 / (1 + binStep / 10_000))));
}

/** One leg of a Solana ladder: its own bin span and its share of the deposit. */
export type LadderLeg = { minBinId: number; maxBinId: number; amount: bigint };

/**
 * Split `rangePct` below the price into `legs` positions, each its own contiguous span,
 * nearest the price first. Bid-ask weighting, the EVM ladder's rule: leg k gets weight
 * k+1, so the deepest leg holds the most -- buy the dip. Each leg is SPOT inside its span;
 * the legs together make the bid-ask shape. A span over the 69-bin position limit raises
 * the leg count until every leg fits. Legs never outnumber bins.
 */
export async function planLadder(pool: string, rangePct: number, legs: number, amount: bigint): Promise<{ plan: OpenPlan; legs: LadderLeg[] }> {
  const dlmm = await DLMM.create(connection(), new PublicKey(pool));
  const plan = await planOpen(pool, rangePct);
  const total = binsForRangeUncapped(Number(dlmm.lbPair.binStep), rangePct);
  const n = Math.min(total, Math.max(legs, Math.ceil(total / MAX_BINS)));
  const per = Math.floor(total / n);
  const extra = total % n;
  const wsum = BigInt((n * (n + 1)) / 2);
  const out: LadderLeg[] = [];
  let offset = 0;
  let given = 0n;
  for (let k = 0; k < n; k++) {
    const width = per + (k < extra ? 1 : 0);
    const near = offset + 1, far = offset + width; // distance from the active bin, in bins
    offset += width;
    const amt = k === n - 1 ? amount - given : (amount * BigInt(k + 1)) / wsum;
    given += amt;
    out.push(
      plan.baseIsX
        ? { minBinId: plan.activeBinId + near, maxBinId: plan.activeBinId + far, amount: amt }
        : { minBinId: plan.activeBinId - far, maxBinId: plan.activeBinId - near, amount: amt },
    );
  }
  return { plan: { ...plan, bins: total }, legs: out };
}

/** What the deposit would look like, without sending anything. */
export async function planOpen(pool: string, rangePct: number): Promise<OpenPlan> {
  const dlmm = await DLMM.create(connection(), new PublicKey(pool));
  const active = await dlmm.getActiveBin();
  const binStep = Number(dlmm.lbPair.binStep);
  const xMint = dlmm.lbPair.tokenXMint.toBase58();
  const yMint = dlmm.lbPair.tokenYMint.toBase58();
  const baseX = baseOfMint(xMint);
  const baseY = baseOfMint(yMint);
  const base = baseX ?? baseY;
  if (!base) throw new Error('this pool is not quoted in SOL or USDC');
  const bins = binsForRange(binStep, rangePct);
  const activeBinId = Number(active.binId);
  // The base side decides WHICH WAY the range points. With the base as token Y the deposit
  // sits below the active bin and converts as price falls; with the base as token X it is
  // the mirror image. Getting this backwards would open a position that is already fully
  // converted -- an instant market order, not a limit order.
  const baseIsX = !!baseX;
  return {
    bins,
    activeBinId,
    minBinId: baseIsX ? activeBinId + 1 : activeBinId - bins,
    maxBinId: baseIsX ? activeBinId + bins : activeBinId - 1,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    baseIsX,
  };
}

/**
 * What opening this position costs in rent, as Meteora's own quote puts it. The position
 * account comes back on close; a bin array or bitmap extension this range is the first to
 * need is created by us and stays with the pool: that part is NOT refunded.
 */
export type OpenCost = { refundable: number; nonRefundable: number; total: number };

export async function quoteOpenCost(
  pool: string,
  rangePct: number,
  shape: 'bidask' | 'spot',
  span?: { minBinId: number; maxBinId: number },
): Promise<OpenCost> {
  const dlmm = await DLMM.create(connection(), new PublicKey(pool));
  const plan = span ?? (await planOpen(pool, rangePct));
  const q = await dlmm.quoteCreatePosition({
    strategy: {
      minBinId: plan.minBinId,
      maxBinId: plan.maxBinId,
      strategyType: shape === 'bidask' ? DLMM.StrategyType.BidAsk : DLMM.StrategyType.Spot,
    },
  });
  const refundable = Number(q.positionCost) + Number(q.positionReallocCost ?? 0);
  const nonRefundable = Number(q.binArrayCost) + Number(q.bitmapExtensionCost);
  return { refundable, nonRefundable, total: refundable + nonRefundable };
}

export type OpenResult = { signature: string; position: string; plan: OpenPlan };

/**
 * Open the position. `amount` is in the BASE's own base units (lamports for SOL).
 *
 * `shape` matches the EVM setting: 'bidask' concentrates at the range edges, 'spot' spreads
 * evenly.
 */
export async function openPosition(
  pool: string,
  amount: bigint,
  rangePct: number,
  shape: 'bidask' | 'spot',
  kp: SolKeypair,
  /** A ladder leg's own span; without it the whole range is one position. */
  span?: { minBinId: number; maxBinId: number },
): Promise<OpenResult> {
  const conn = connection();
  const dlmm = await DLMM.create(conn, new PublicKey(pool));
  const whole = await planOpen(pool, rangePct);
  const plan = span ? { ...whole, ...span, bins: span.maxBinId - span.minBinId + 1 } : whole;
  const user = Keypair.fromSeed(Buffer.from(kp.seed));
  const positionKp = Keypair.generate();
  const zero = new BN(0);
  const amt = new BN(amount.toString());
  const tx: Transaction = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    user: user.publicKey,
    // Only the base side is funded; the other side is zero. This is the single-side
    // invariant, in the one place it can actually be broken.
    totalXAmount: plan.baseIsX ? amt : zero,
    totalYAmount: plan.baseIsX ? zero : amt,
    strategy: {
      minBinId: plan.minBinId,
      maxBinId: plan.maxBinId,
      strategyType: shape === 'bidask' ? DLMM.StrategyType.BidAsk : DLMM.StrategyType.Spot,
    },
  });
  // A PRICE for the compute units, which the SDK does not set.
  //
  // It emits SetComputeUnitLimit and nothing else, so the transaction goes out bidding
  // zero. On 22 Sep 2026 at 21:15 WIB that is exactly what happened: signature 2kwdfKed…
  // never landed and died with "block height exceeded" after sitting behind everything
  // that did pay. The Jupiter buy path has always set a fee; this one now matches it.
  await addPriorityFee(tx, pool);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = user.publicKey;
  // Signed here rather than inside sendAndConfirmTransaction, because the SIGNATURE is what
  // makes an expiry answerable: without it there is nothing to ask the chain about.
  tx.sign(user, positionKp);
  const signature = encodeBase58(Uint8Array.from(tx.signature!));
  await conn.sendRawTransaction(tx.serialize(), {
    // The position keypair is single-use, so a resend cannot duplicate the position: the
    // second attempt collides with an account that already exists and fails.
    maxRetries: 3,
  });

  // Re-sent every 2s until confirmed or expired: a node that cannot forward in time drops
  // it. Same bytes and a single-use position key, so it can land at most once.
  const raw = tx.serialize();
  const b64 = Buffer.from(raw).toString('base64');
    broadcastOfficial(b64);
    const resend = setInterval(() => {
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      broadcastOfficial(b64);
    }, 2_000);
  try {
    const r = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed').finally(() => clearInterval(resend));
    if (r.value.err) throw new Error(`the position failed on-chain (${signature})`);
  } catch (e) {
    // An expiry is not an answer, it is the absence of one. A transaction whose blockhash
    // ran out can still have landed, and telling the owner to "try again" then opens a
    // SECOND position. So the chain is asked before anything is claimed -- the same rule
    // the four EVM close paths carry since 20 Sep 2026.
    const landed = await landedStatus(conn, signature);
    if (landed === 'ok') return { signature, position: positionKp.publicKey.toBase58(), plan };
    if (landed === 'failed') throw new Error(`the position failed on-chain (${signature})`);
    console.error(`[sol-lp] open did not land: ${signature} — ${(e as Error).message}`);
    throw new Error(`the transaction never landed (${signature}); nothing was deposited, so it is safe to try again`);
  }
  return { signature, position: positionKp.publicKey.toBase58(), plan };
}

/**
 * Did this signature actually land? 'ok', 'failed', or 'absent'.
 *
 * Polled for a few seconds rather than asked once: a transaction that lands in the same
 * moment its blockhash expires shows up a beat later, and answering "absent" too early is
 * what would let a second position be opened on top of a first.
 */
async function landedStatus(conn: Connection, signature: string): Promise<'ok' | 'failed' | 'absent'> {
  for (let i = 0; i < 5; i++) {
    const st = await conn
      .getSignatureStatus(signature, { searchTransactionHistory: true })
      .catch(() => null);
    const v = st?.value;
    if (v) return v.err ? 'failed' : 'ok';
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return 'absent';
}

/** A floor, so a quiet market still does not bid zero. */
const MIN_MICRO_LAMPORTS = 50_000;

/**
 * Add SetComputeUnitPrice at the official RPC's "high" rate for THIS pool: the 75th
 * percentile of what its own writers paid (fees.ts). No ceiling -- a bid below the going
 * rate does not land, it expires (23 Sep 2026, GIGACAT/SOL).
 */
async function addPriorityFee(tx: Transaction, pool: string): Promise<void> {
  const micro = Math.max(MIN_MICRO_LAMPORTS, (await highPriorityMicro(pool))?.micro ?? 0);
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
}

export type CloseResult = {
  signatures: string[];
  /** What came back on each side, principal plus claimed fees, in raw units. */
  baseOut: bigint;
  tokenOut: bigint;
  /** The fee share of baseOut + tokenOut, for the PnL card's fees box. */
  baseFee: bigint;
  tokenFee: bigint;
  baseMint: string;
  tokenMint: string;
};

/**
 * Close a DLMM position: withdraw 100% from every bin, claim its fees, and close the
 * account so its rent comes back. The amounts are read from the position BEFORE the
 * withdrawal, not from balance deltas -- a SOL delta would fold in the returned rent and
 * the network fee, and overstate the PnL by ~0.057 SOL.
 *
 * Each transaction the SDK returns is sent, re-broadcast and confirmed in order, the same
 * way the open path does it. A transaction that expires is asked about before anything is
 * claimed: an expiry is not an answer.
 */
export async function closePosition(pool: string, position: string, kp: SolKeypair): Promise<CloseResult> {
  const conn = connection();
  const dlmm = await DLMM.create(conn, new PublicKey(pool));
  const user = Keypair.fromSeed(Buffer.from(kp.seed));
  const pos = await dlmm.getPosition(new PublicKey(position));
  const pd: any = pos.positionData;
  const xMint = dlmm.lbPair.tokenXMint.toBase58();
  const yMint = dlmm.lbPair.tokenYMint.toBase58();
  const baseIsX = !!baseOfMint(xMint);
  const big = (v: unknown) => BigInt(String(v ?? '0').split('.')[0] || '0');
  const x = big(pd.totalXAmount), y = big(pd.totalYAmount);
  const fx = big(pd.feeX?.toString?.() ?? pd.feeX), fy = big(pd.feeY?.toString?.() ?? pd.feeY);
  // The position's own figures round up per bin; what lands in the wallet can be a few
  // units less, and a swap for the reported amount then fails (Jupiter 0x1788). So each
  // SPL side is capped at the wallet's actual balance change.
  const splBal = async (mint: string): Promise<bigint | null> => {
    if (mint === 'So11111111111111111111111111111111111111112') return null;
    try {
      const r = await conn.getParsedTokenAccountsByOwner(user.publicKey, { mint: new PublicKey(mint) }, 'confirmed');
      return r.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
    } catch {
      return null;
    }
  };
  const [preX, preY] = await Promise.all([splBal(xMint), splBal(yMint)]);

  const txs: Transaction[] = await dlmm.removeLiquidity({
    user: user.publicKey,
    position: new PublicKey(position),
    fromBinId: pd.lowerBinId,
    toBinId: pd.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  const signatures: string[] = [];
  for (const tx of txs) {
    await addPriorityFee(tx, pool);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;
    tx.sign(user);
    const signature = encodeBase58(Uint8Array.from(tx.signature!));
    const raw = tx.serialize();
    await conn.sendRawTransaction(raw, { maxRetries: 3 });
    const b64 = Buffer.from(raw).toString('base64');
    broadcastOfficial(b64);
    const resend = setInterval(() => {
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      broadcastOfficial(b64);
    }, 2_000);
    try {
      const r = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed').finally(() => clearInterval(resend));
      if (r.value.err) throw new Error(`the close failed on-chain (${signature})`);
    } catch (e) {
      const landed = await landedStatus(conn, signature);
      if (landed === 'failed') throw new Error(`the close failed on-chain (${signature})`);
      if (landed === 'absent') {
        console.error(`[sol-lp] close did not land: ${signature} — ${(e as Error).message}`);
        throw new Error(`the close never landed (${signature}); the position is untouched, so it is safe to try again`);
      }
    }
    signatures.push(signature);
  }
  const [postX, postY] = await Promise.all([splBal(xMint), splBal(yMint)]);
  const cap = (want: bigint, pre: bigint | null, post: bigint | null) =>
    pre != null && post != null && post >= pre && post - pre < want ? post - pre : want;
  const outX = cap(x + fx, preX, postX), outY = cap(y + fy, preY, postY);
  return {
    signatures,
    baseOut: baseIsX ? outX : outY,
    tokenOut: baseIsX ? outY : outX,
    baseFee: baseIsX ? fx : fy,
    tokenFee: baseIsX ? fy : fx,
    baseMint: baseIsX ? xMint : yMint,
    tokenMint: baseIsX ? yMint : xMint,
  };
}
