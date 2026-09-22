/**
 * An ed25519 keypair for Solana, with no SDK behind it.
 *
 * node:crypto speaks ed25519 natively, so @solana/web3.js is not carried here for what is
 * a key derivation and one signature. The only awkward part is that node will not take a
 * raw 32-byte seed: it wants PKCS8 DER, which for ed25519 is a fixed 16-byte prefix in
 * front of the seed. That prefix is a constant, not a computation.
 *
 * Phantom exports a 64-byte secret key in base58: 32 bytes of seed followed by the 32-byte
 * public key. Both halves are used. The public key is DERIVED from the seed and then
 * checked against the half that came with it, so a truncated or mistyped paste is refused
 * here rather than producing a valid-looking keypair that signs for an address the owner
 * does not own.
 */
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { encodeBase58, isSolAddress } from './addr.js';

/** PKCS8 header for an ed25519 private key holding a 32-byte seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i] as const));

/** base58 -> bytes, for secrets. Returns null on any character outside the alphabet. */
function decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const v = INDEX.get(ch);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const tail: number[] = [];
  while (n > 0n) {
    tail.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...Array<number>(zeros).fill(0), ...tail]);
}

export type SolKeypair = {
  /** The address, base58. */
  publicKey: string;
  /** The 32-byte seed. This is the secret; it is never logged and never leaves the process. */
  seed: Uint8Array;
};

/** The public key belonging to a seed. */
export function publicKeyOf(seed: Uint8Array): string {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  // SPKI for ed25519 is a 12-byte header followed by the 32-byte key.
  return encodeBase58(Uint8Array.from(spki.subarray(spki.length - 32)));
}

/**
 * A keypair from what a wallet exports: base58 for 64 bytes, seed followed by public key.
 *
 * A bare 32-byte seed is REFUSED even though it would work. In base58 it is indistinguishable
 * from an address, so accepting it would mean a pasted contract address could be taken for a
 * key. The 64-byte form is what Phantom, Solflare and the CLI all export.
 *
 * Throws on anything else, and the message NEVER contains the input.
 */
export function keypairFromSecret(secret: string): SolKeypair {
  const bytes = decode(secret.trim());
  if (!bytes || bytes.length !== 64) {
    throw new Error('not a Solana secret key: expected base58 for 64 bytes, the way Phantom exports it');
  }
  const seed = bytes.subarray(0, 32);
  const publicKey = publicKeyOf(seed);
  {
    // The half that came with the paste must match the half derived from the seed. A
    // truncated paste otherwise yields a perfectly valid keypair for an address the owner
    // has never funded, and the failure only shows up as a signature nobody accepts.
    const carried = encodeBase58(Uint8Array.from(bytes.subarray(32)));
    if (carried !== publicKey) throw new Error('the secret key is damaged: its two halves do not agree');
  }
  if (!isSolAddress(publicKey)) throw new Error('the derived address is not a valid Solana address');
  return { publicKey, seed: Uint8Array.from(seed) };
}

/** Sign a message with a seed. 64 bytes out. */
export function signMessage(message: Uint8Array, seed: Uint8Array): Uint8Array {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  return Uint8Array.from(edSign(null, Buffer.from(message), priv));
}
