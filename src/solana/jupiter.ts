/**
 * Buying a token on Solana, through Jupiter.
 *
 * Jupiter, not LI.FI. LI.FI reaches Solana only as the far end of a bridge and quotes
 * through partner routes; Jupiter is the native aggregator and is what every Solana venue
 * this bot cares about (Meteora, pump.fun AMM, Raydium, Orca) is routed by. For a swap
 * that begins and ends on Solana there is nothing for a bridge aggregator to do, and its
 * quote would be a worse copy of this one.
 *
 * The transaction is signed here without @solana/web3.js. A Jupiter swap comes back as a
 * serialised versioned transaction whose signature slots are zero-filled, and its layout
 * is fixed: a compact-u16 count, that many 64-byte slots, then the message. The fee payer
 * signs slot 0. Everything this module needs is that one insertion, so the SDK's whole
 * transaction stack would be carried for a memcpy.
 */
import { highPriorityMicro, broadcastOfficial } from './fees.js';

import { signMessage, type SolKeypair } from './keys.js';
import { solRpc } from './rpc.js';

/**
 * Two routes to the same Jupiter router, tried in order:
 *  1. api.jup.ag with the free API key (JUP_API_KEY): 1 req/s, the supported path.
 *  2. lite-api.jup.ag, keyless: the public backup (being phased out by Jupiter).
 * Without a key the first is skipped: keyless api.jup.ag is 0.5 req/s and 429'd a burst
 * of 8 after 5 in testing (24 Sep 2026), where lite-api took all 8.
 */
// Read on each call, so the key is picked up however late .env is loaded.
const jupHosts = (): Array<{ url: string; headers: Record<string, string> }> => [
  ...(process.env.JUP_API_KEY ? [{ url: 'https://api.jup.ag/swap/v1', headers: { 'x-api-key': process.env.JUP_API_KEY } }] : []),
  { url: 'https://lite-api.jup.ag/swap/v1', headers: {} },
];
export const WSOL = 'So11111111111111111111111111111111111111112';
/** Lamports per SOL. */
export const LAMPORTS = 1_000_000_000;

export type Quote = {
  inAmount: string;
  outAmount: string;
  /** The minimum the swap may return at the quoted slippage: what "worst case" means. */
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
  [k: string]: unknown;
};

async function jup<T>(path: string, init?: RequestInit): Promise<T> {
  let last: Error | null = null;
  for (const h of jupHosts()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(`${h.url}${path}`, { ...init, headers: { ...(init?.headers as any), ...h.headers }, signal: ctrl.signal });
      const body = await res.text();
      // Rate limit, server error or a bad key: the next route may still answer. A 400 is
      // the request itself (no route, bad amount) and would fail the same way everywhere.
      if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
        last = new Error(`jupiter ${res.status}: ${body.slice(0, 200)}`);
        console.error(`[jupiter] ${new URL(h.url).host} ${res.status}, trying the next route`);
        continue;
      }
      if (!res.ok) throw new Error(`jupiter ${res.status}: ${body.slice(0, 200)}`);
      return JSON.parse(body) as T;
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !(e instanceof TypeError)) throw e;
      last = e as Error;
      console.error(`[jupiter] ${new URL(h.url).host} unreachable, trying the next route`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error('jupiter: no route answered');
}

/** A quote for spending `amount` base units of inputMint. */
export function quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  // The mints go in verbatim: base58 is case-sensitive and a folded mint quotes a
  // different token, or nothing at all.
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps),
  });
  return jup<Quote>(`/quote?${q}`);
}

/** The route's venues, for the confirm card. */
export function routeLabel(q: Quote): string {
  const names = (q.routePlan ?? []).map((r) => r?.swapInfo?.label).filter(Boolean) as string[];
  return names.length ? [...new Set(names)].join(' → ') : 'Jupiter';
}

/** Build the swap transaction for this quote, base64. */
async function buildSwap(q: Quote, userPublicKey: string): Promise<string> {
  const r = await jup<{ swapTransaction?: string }>('/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey,
      // Jupiter wraps and unwraps SOL itself. Doing it by hand is an extra transaction and
      // an account that has to be closed afterwards.
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // A swap that lands three blocks late on a token minutes old is a different trade.
      // The official RPC's "high" rate (fees.ts), per compute unit, uncapped. A small floor
      // so a quiet reading still bids something.
      computeUnitPriceMicroLamports: Math.max(10_000, (await highPriorityMicro())?.micro ?? 0),
    }),
  });
  if (!r.swapTransaction) throw new Error('jupiter returned no transaction');
  return r.swapTransaction;
}

/** Insert `signature` into slot 0 of a serialised versioned transaction. */
export function signTransaction(txBase64: string, kp: SolKeypair): string {
  const raw = Buffer.from(txBase64, 'base64');
  // compact-u16: a 1-byte count for anything under 128, which every real fee-payer count is.
  const sigCount = raw[0];
  if (!sigCount || sigCount > 127) throw new Error('unexpected transaction layout');
  const sigsEnd = 1 + sigCount * 64;
  const message = raw.subarray(sigsEnd);
  const sig = signMessage(Uint8Array.from(message), kp.seed);
  const out = Buffer.from(raw);
  Buffer.from(sig).copy(out, 1);
  return out.toString('base64');
}

/** Broadcast, and wait for the network to accept or reject it. */
async function sendAndConfirm(signedBase64: string): Promise<string> {
  const sig = await solRpc<string>('sendTransaction', [
    signedBase64,
    { encoding: 'base64', skipPreflight: false, maxRetries: 3 },
  ]);
  broadcastOfficial(signedBase64);
  // Polled rather than subscribed: one websocket for one confirmation is not worth the
  // reconnect handling, and 60 seconds covers a congested slot.
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_000));
    // Re-broadcast the SAME signed bytes each round: a node drops a transaction it could not
    // forward in time, and the one-shot send let 4oFxQdqm… (23 Sep, 0.01 SOL) vanish without
    // ever landing. Same signature, so it can land at most once.
    solRpc('sendTransaction', [signedBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {});
    broadcastOfficial(signedBase64);
    const st = await solRpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>(
      'getSignatureStatuses',
      [[sig], { searchTransactionHistory: true }],
    ).catch(() => null);
    const s = st?.value?.[0];
    if (!s) continue;
    // An error here is the whole point of waiting. A transaction that lands and FAILS is
    // not a completed buy, and reporting the signature as success is the same mistake that
    // untracked a live BSC position on 20 Sep.
    if (s.err) {
      console.error(`[sol-swap] ${sig} landed and failed:`, JSON.stringify(s.err));
      throw new Error(`the swap failed on-chain (${sig})`);
    }
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return sig;
  }
  console.error(`[sol-swap] ${sig} not confirmed within 60s`);
  throw new Error(`the swap was sent but not confirmed within 60s (${sig})`);
}

/** Quote -> transaction -> signature. Returns the confirmed signature. */
export async function executeSwap(q: Quote, kp: SolKeypair): Promise<string> {
  return sendAndConfirm(signTransaction(await buildSwap(q, kp.publicKey), kp));
}

/** A wallet's SOL balance, in lamports. */
export async function solBalance(owner: string): Promise<bigint> {
  const r = await solRpc<{ value: number }>('getBalance', [owner]);
  return BigInt(r?.value ?? 0);
}
