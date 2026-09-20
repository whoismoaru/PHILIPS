/**
 * A minimal Solana JSON-RPC client.
 *
 * Deliberately not @solana/web3.js. The Solana side reads exactly two kinds of account
 * (an LbPair and a position) and sends nothing, so the SDK's transaction machinery,
 * keypair handling and its dependency tree would all be carried for two getAccountInfo
 * calls. This is the whole surface that is actually used.
 *
 * Two things learned the hard way while surveying Meteora from this machine, both encoded
 * below. A plain Node fetch is rejected 403 by some public endpoints unless it carries a
 * browser User-Agent, and an endpoint that answers getAccountInfo may still refuse
 * getProgramAccounts with a 410 -- so a failure has to name WHICH call was refused, or a
 * feature looks broken when only one method is unavailable.
 */
import { config } from '../config.js';

/** The configured endpoint, or null when none is set. Never a public default: see config.ts. */
export function rpcUrl(): string | null {
  return config.solana.rpcUrl || null;
}

export class SolRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = 'SolRpcError';
  }
}

/**
 * One JSON-RPC call, with a single retry on a transport failure.
 *
 * Read-only by construction: there is no signer here and no sendTransaction, so a retry
 * can never double-spend. That is what makes retrying safe here and not in retry.ts.
 */
export async function solRpc<T>(method: string, params: unknown[], timeoutMs = 20_000): Promise<T> {
  const url = rpcUrl();
  if (!url) throw new SolRpcError(method, 'SOLANA_RPC_URL is not set');
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        // The User-Agent is not decoration: without it some endpoints answer 403 to Node.
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
      // Naming the method matters: an endpoint can serve getAccountInfo happily and still
      // refuse getProgramAccounts, and "RPC failed" would hide which half is missing.
      if (j.error) throw new SolRpcError(method, `${method}: ${j.error.message ?? j.error.code ?? 'error'}`);
      if (j.result === undefined) throw new SolRpcError(method, `${method}: empty result`);
      return j.result;
    } catch (e) {
      // A refusal by the node is an answer, not a transport hiccup: retrying cannot change it.
      if (e instanceof SolRpcError) throw e;
      lastErr = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SolRpcError(method, `${method}: ${lastErr}`);
}

/** Raw account data, or null when the account does not exist (closed, or never created). */
export async function accountData(pubkey: string): Promise<Uint8Array | null> {
  const r = await solRpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [
    pubkey,
    { encoding: 'base64' },
  ]);
  if (!r?.value) return null;
  return Uint8Array.from(Buffer.from(r.value.data[0], 'base64'));
}
