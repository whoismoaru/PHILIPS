import { ethers } from 'ethers';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.js';

/**
 * The wallet connected through /connect.
 *
 * The key is NEVER written in the clear: it is stored as a v3 JSON keystore (scrypt + AES)
 * at data/keystore.json, chmod 600. Its passphrase is derived from a server secret
 * (WALLET_SECRET, or the bot token when that is empty) rather than asked for on every
 * restart. That is not laziness: monitor.sweepLeftovers signs transactions in the
 * background, so a wallet locked until somebody types something means sweeps failing
 * silently after every redeploy.
 *
 * The honest limit: anyone who can read this server's disk and .env can open the keystore.
 * What this protects against is a key sitting in plain text on disk or in git, not an
 * attacker who already has the machine.
 */

const FILE = join(process.cwd(), 'data', 'keystore.json');
/**
 * Written by disconnect(), checked by adoptEnvKey().
 *
 * Disconnecting only deletes the keystore, and PRIVATE_KEY stays in .env -- so the
 * next start adopted it again and the wallet the owner had just removed was silently
 * back. A disconnect has to outlive a restart, so it leaves a mark saying the .env key
 * was refused on purpose. Connecting again clears the mark.
 */
const TOMBSTONE = join(process.cwd(), 'data', 'wallet.disconnected');

function passphrase(): string {
  const s = process.env.WALLET_SECRET || config.telegram.botToken;
  if (!s) throw new Error('WALLET_SECRET / bot token is empty: cannot encrypt the keystore');
  return `philips:${s}`;
}

let cached: ethers.HDNodeWallet | ethers.Wallet | null = null;
let loaded = false;

/** Adopt PRIVATE_KEY from .env once, so an older installation keeps working. */
function adoptEnvKey(): void {
  const pk = config.wallet.privateKey?.trim();
  if (!pk) return;
  if (existsSync(TOMBSTONE)) {
    console.log('[wallet] PRIVATE_KEY in .env skipped: the wallet was disconnected from /settings. Remove that line if it is no longer used.');
    return;
  }
  // The shape is validated HERE, before ethers ever sees it, for a concrete reason: ethers
  // redacts the value only on an "invalid private key" error. Get the length or the
  // characters wrong -- exactly what a bad paste looks like -- and it throws "invalid
  // BytesLike value" with the RAW VALUE in the message, which used to land in journald
  // permanently.
  if (!/^(0x)?[a-fA-F0-9]{64}$/.test(pk)) {
    console.error(
      '[wallet] PRIVATE_KEY in .env ignored: it is not 64 hexadecimal characters. ' +
        'Fix the value, or delete the line and connect through /settings.',
    );
    return;
  }
  try {
    save(new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`));
    console.log('[wallet] the PRIVATE_KEY from .env was adopted into an encrypted keystore');
  } catch {
    // The ethers error message must NEVER be printed here: it can contain the key itself.
    console.error('[wallet] failed to adopt the PRIVATE_KEY from .env (the key is not printed).');
  }
}

function load(): ethers.HDNodeWallet | ethers.Wallet | null {
  if (loaded) return cached;
  loaded = true;
  if (!existsSync(FILE)) {
    adoptEnvKey();
    if (!existsSync(FILE)) return null;
  }
  try {
    cached = ethers.Wallet.fromEncryptedJsonSync(readFileSync(FILE, 'utf8'), passphrase());
  } catch (e) {
    console.error('[wallet] the keystore could not be opened:', (e as Error).message);
    cached = null;
  }
  return cached;
}

function save(w: ethers.HDNodeWallet | ethers.Wallet): void {
  // A fresh connect is consent: clear the refusal left by an earlier disconnect.
  if (existsSync(TOMBSTONE)) unlinkSync(TOMBSTONE);
  // Do not ride on store.ts's import side effect: if the import order ever changes,
  // data/ would not exist yet and saving the key would fail in silence.
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, w.encryptSync(passphrase()), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  cached = w;
  loaded = true;
}

/** True when a wallet is connected. */
export function isConnected(): boolean {
  return load() !== null;
}

/** The connected wallet's address, or null. */
export function address(): string | null {
  return load()?.address ?? null;
}

/**
 * A global send queue. Two transactions leaving at the same moment read the same "pending"
 * nonce, and the second dies with `nonce has already been used`. The beginMoneyOp/isBusy
 * guard only covers the monitor: the swap fallback, relay, approve and unwrap paths never
 * pass through it. The queue lives on the module rather than an instance because each chain
 * builds its own Wallet from the same key.
 *
 * One queue across every chain. Split it per chainId if multi-chain throughput ever matters.
 */
let txQueue: Promise<unknown> = Promise.resolve();
// A local nonce floor per chainId. Ordering the sends is not enough on its own: a nonce
// can be read early, before the previous operation's transaction lands, and only then join
// the queue -- so the RPC hands back a stale "pending" and the transaction dies with
// `nonce has already been used`. The nonce is therefore computed INSIDE the serialised
// section, as max(pending, floor). The floor only advances after a successful broadcast,
// so a failure leaves no hole.
//
// If a broadcast succeeds but its transaction vanishes from the mempool (rare on Alchemy),
// the floor can sit above the chain; restart the service to reset it.
const nonceFloor = new Map<number, number>();

/** A signer for this provider, or null when no wallet is connected. */
export function signerFor(provider: ethers.Provider): ethers.Wallet | null {
  const w = load();
  if (!w) return null;
  const s = new ethers.Wallet(w.privateKey, provider);
  const send = s.sendTransaction.bind(s);
  s.sendTransaction = (tx) => {
    const run = txQueue.then(async () => {
      const cid = Number((await provider.getNetwork()).chainId);
      const pending = await provider.getTransactionCount(s.address, 'pending');
      const nonce = Math.max(pending, nonceFloor.get(cid) ?? 0);
      const resp = await send({ ...tx, nonce });
      nonceFloor.set(cid, nonce + 1);
      return resp;
    });
    txQueue = run.catch(() => {}); // a failed route must not break the queue
    return run;
  };
  return s;
}

/**
 * Connect a wallet from a private key OR a seed phrase, returning its address. Throws when
 * the input is neither; the caller decides what to say about it.
 */
export function connect(secret: string): string {
  const t = secret.replace(/\s+/g, ' ').trim();
  let w: ethers.HDNodeWallet | ethers.Wallet;
  if (/^(0x)?[a-fA-F0-9]{64}$/.test(t.replace(/\s/g, ''))) {
    const hex = t.replace(/\s/g, '');
    w = new ethers.Wallet(hex.startsWith('0x') ? hex : `0x${hex}`);
  } else if (ethers.Mnemonic.isValidMnemonic(t.toLowerCase())) {
    w = ethers.HDNodeWallet.fromPhrase(t.toLowerCase());
  } else {
    throw new Error('not a valid private key (64 hex chars) or seed phrase');
  }
  save(w);
  return w.address;
}

/** Disconnect: the keystore is deleted from disk and from memory. */
export function disconnect(): void {
  if (existsSync(FILE)) unlinkSync(FILE);
  // The mark is what makes the disconnect survive a restart; see TOMBSTONE.
  mkdirSync(dirname(TOMBSTONE), { recursive: true });
  writeFileSync(TOMBSTONE, new Date().toISOString(), { mode: 0o600 });
  cached = null;
  loaded = true;
}

/** true when an .env PRIVATE_KEY exists but is being refused because of a disconnect. */
export function envKeyRefused(): boolean {
  return !!config.wallet.privateKey?.trim() && existsSync(TOMBSTONE);
}

