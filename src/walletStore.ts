import { ethers } from 'ethers';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Dompet yang dihubungkan lewat /connect.
 *
 * Kunci TIDAK pernah ditulis polos: disimpan sebagai keystore JSON v3 (scrypt +
 * AES) di data/keystore.json, chmod 600. Passphrase-nya diturunkan dari rahasia
 * server (WALLET_SECRET, jika kosong: token bot) — bukan diminta ke user tiap
 * restart. Alasannya bukan kemalasan: monitor.sweepLeftovers menandatangani
 * transaksi di latar belakang, jadi dompet yang terkunci sampai user mengetik
 * sesuatu = penyapuan gagal diam-diam setiap kali service di-deploy ulang.
 *
 * Batas jujur: siapa pun yang bisa membaca disk + .env server ini bisa membuka
 * keystore-nya. Yang dilindungi adalah kunci-di-disk-polos dan kunci-di-git,
 * bukan penyerang yang sudah memegang mesinnya.
 */

const FILE = join(process.cwd(), 'data', 'keystore.json');

function passphrase(): string {
  const s = process.env.WALLET_SECRET || config.telegram.botToken;
  if (!s) throw new Error('WALLET_SECRET / bot token is empty — cannot encrypt the keystore');
  return `philips:${s}`;
}

let cached: ethers.HDNodeWallet | ethers.Wallet | null = null;
let loaded = false;

/** Adopsi PRIVATE_KEY dari .env sekali saja, supaya pemasangan lama tetap jalan. */
function adoptEnvKey(): void {
  const pk = config.wallet.privateKey;
  if (!pk) return;
  try {
    save(new ethers.Wallet(pk));
    console.log('[wallet] PRIVATE_KEY dari .env diadopsi jadi keystore terenkripsi');
  } catch (e) {
    console.error('[wallet] gagal mengadopsi PRIVATE_KEY:', (e as Error).message);
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
    console.error('[wallet] keystore gagal dibuka:', (e as Error).message);
    cached = null;
  }
  return cached;
}

function save(w: ethers.HDNodeWallet | ethers.Wallet): void {
  writeFileSync(FILE, w.encryptSync(passphrase()), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  cached = w;
  loaded = true;
}

/** true bila ada dompet terhubung. */
export function isConnected(): boolean {
  return load() !== null;
}

/** Alamat dompet terhubung, atau null. */
export function address(): string | null {
  return load()?.address ?? null;
}

/** Signer untuk sebuah provider; null bila belum terhubung. */
export function signerFor(provider: ethers.Provider): ethers.Wallet | null {
  const w = load();
  return w ? new ethers.Wallet(w.privateKey, provider) : null;
}

/**
 * Hubungkan dompet dari private key ATAU seed phrase. Mengembalikan alamatnya.
 * Melempar bila masukannya bukan keduanya — pemanggil yang memutuskan pesan.
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

/** Putuskan dompet: keystore dihapus dari disk & dari memori. */
export function disconnect(): void {
  if (existsSync(FILE)) unlinkSync(FILE);
  cached = null;
  loaded = true;
}
