/**
 * The Solana wallet, stored as its own encrypted keystore.
 *
 * A PARALLEL module to src/walletStore.ts, which is not touched. The two keys never meet:
 * an EVM key is secp256k1 and a Solana key is ed25519, and the owner's Solana wallet is a
 * separate Phantom account rather than the same seed derived twice. Sharing one store
 * would mean one file holding two unrelated secrets and one disconnect removing both.
 *
 * Encryption is AES-256-GCM under a scrypt key, from the SAME server secret the EVM
 * keystore uses (WALLET_SECRET, or the bot token). The honest limit is identical: this
 * protects against a key sitting in plain text on disk or in git, not against someone who
 * already has the machine and its .env.
 *
 * SOLANA_WALLET in .env stays what it always was: a read-only address for /positions. It
 * never becomes a signer, and a connected keystore takes precedence over it.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { keypairFromSecret, publicKeyOf, type SolKeypair } from './keys.js';

const FILE = join(process.cwd(), 'data', 'keystore-sol.json');
/** Same purpose as the EVM tombstone: a disconnect has to outlive a restart. */
const TOMBSTONE = join(process.cwd(), 'data', 'wallet-sol.disconnected');

type Stored = { v: 1; salt: string; iv: string; tag: string; data: string; publicKey: string };

function secretBase(): string {
  const s = process.env.WALLET_SECRET || config.telegram.botToken;
  if (!s) throw new Error('WALLET_SECRET / bot token is empty: cannot encrypt the keystore');
  return `philips-sol:${s}`;
}

let cached: SolKeypair | null = null;
let loaded = false;

function load(): SolKeypair | null {
  if (loaded) return cached;
  loaded = true;
  if (!existsSync(FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8')) as Stored;
    const key = scryptSync(secretBase(), Buffer.from(j.salt, 'hex'), 32);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'hex'));
    d.setAuthTag(Buffer.from(j.tag, 'hex'));
    const seed = Uint8Array.from(Buffer.concat([d.update(Buffer.from(j.data, 'hex')), d.final()]));
    const publicKey = publicKeyOf(seed);
    // The stored address is checked against the decrypted seed. They can only disagree if
    // the file was edited, and signing for an address other than the one the cards show is
    // exactly the failure worth refusing outright.
    if (publicKey !== j.publicKey) throw new Error('the keystore address does not match its key');
    cached = { publicKey, seed };
  } catch (e) {
    // The error may not carry key material, so only its message is printed, never the file.
    console.error('[wallet-sol] the keystore could not be opened:', (e as Error).message);
    cached = null;
  }
  return cached;
}

function save(kp: SolKeypair): void {
  if (existsSync(TOMBSTONE)) unlinkSync(TOMBSTONE);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secretBase(), salt, 32);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(Buffer.from(kp.seed)), c.final()]);
  const out: Stored = {
    v: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: c.getAuthTag().toString('hex'),
    data: data.toString('hex'),
    publicKey: kp.publicKey,
  };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(out), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  cached = kp;
  loaded = true;
}

/** True when a Solana key is connected and can sign. */
export function isConnected(): boolean {
  return load() !== null;
}

/**
 * The address to READ positions and balances for: the connected key, or the .env address
 * when there is none. Signing uses keypair() and therefore never falls back to .env.
 */
export function address(): string | null {
  return load()?.publicKey ?? (config.solana.wallet || null);
}

/** The signer, or null. */
export function keypair(): SolKeypair | null {
  return load();
}

/** Connect from a base58 secret key. Returns the address. */
export function connect(secret: string): string {
  const kp = keypairFromSecret(secret);
  save(kp);
  return kp.publicKey;
}

/** Disconnect: the keystore is deleted from disk and from memory. */
export function disconnect(): void {
  if (existsSync(FILE)) unlinkSync(FILE);
  mkdirSync(dirname(TOMBSTONE), { recursive: true });
  writeFileSync(TOMBSTONE, new Date().toISOString(), { mode: 0o600 });
  cached = null;
  loaded = true;
}
