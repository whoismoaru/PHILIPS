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

/**
 * Antrean kirim-tx global. Dua tx yang berangkat bersamaan membaca nonce
 * "pending" yang sama dan yang kedua mati `nonce has already been used`.
 * Guard beginMoneyOp/isBusy hanya menjaga monitor; jalur fallback swap, relay,
 * approve, dan unwrap tidak lewat sana. Antreannya di modul (bukan instance)
 * karena tiap chain membuat Wallet-nya sendiri dari kunci yang sama.
 * ponytail: satu antrean lintas chain — pisahkan per chainId kalau throughput
 * multi-chain jadi masalah.
 */
let txQueue: Promise<unknown> = Promise.resolve();
// Lantai nonce lokal per-chainId. Mengurutkan pengiriman saja tak cukup: nonce
// bisa dibaca lebih awal (sebelum tx op sebelumnya mendarat) lalu baru mengantre,
// jadi RPC memberi "pending" basi dan tx mati `nonce has already been used`.
// Karena itu nonce dihitung DI DALAM bagian terserialisasi = max(pending, lantai).
// Lantai hanya maju setelah broadcast sukses → gagal tak meninggalkan lubang.
// ponytail: kalau sebuah broadcast sukses tapi tx-nya lenyap dari mempool (langka
// di Alchemy), lantai bisa nyangkut di atas chain; pakai `pkill`+restart untuk reset.
const nonceFloor = new Map<number, number>();

/** Signer untuk sebuah provider; null bila belum terhubung. */
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
    txQueue = run.catch(() => {}); // rute yang gagal tak boleh memutus antrean
    return run;
  };
  return s;
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
