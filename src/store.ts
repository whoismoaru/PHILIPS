import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseKind } from './chains.js';

/**
 * Tulis JSON atomik: file sementara → rename (atomik di POSIX).
 * Mati/OOM saat write tak bisa lagi memotong file tujuan.
 */
export function writeJson(file: string, data: unknown): void {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  renameSync(file + '.tmp', file);
}

/**
 * Penyimpanan posisi LP sederhana (file JSON).
 * Dipakai untuk PnL, status ACTIVE/STOPPED, dan auto-monitor.
 */

export type PosRecord = {
  tokenId: string;
  chain?: string; // kunci chain ('robinhood' dst); kosong = robinhood (posisi lama)
  venue?: string; // DEX non-bawaan chain (mis. 'uniswapv3' di BSC); kosong = DEX bawaan
  ca: string; // alamat token (non-base)
  fee: number;
  symbol: string;
  baseKind?: BaseKind; // aset pasangan; kosong = weth (posisi lama)
  initialWethWei: string; // modal awal (base disetor) dalam unit base (WETH 18-dec / USDG 6-dec)
  nominalEth?: string; // nominal yang dipilih user (tampilan bersih)
  rangeLowPct?: number; // % ujung terjauh dari harga saat buka
  rangeHighPct?: number; // % ujung terdekat
  openedAt: number; // epoch ms
  status: 'ACTIVE' | 'STOPPED';
  lastInRange?: boolean; // untuk notifikasi auto-monitor
  entryPrice?: string; // harga token dalam base saat buka (untuk alert anjlok); kosong = posisi lama
  entryMcap?: number; // market cap USD saat buka — batas mcap kartu dipatok ke sini (biar diam)
  entryEthUsd?: number; // harga base(USD) saat buka — PnL USD ala LP Agent dipatok ke sini (weth: harga ETH; stable: 1)
  convertedAlerted?: boolean; // sudah kirim alert terkonversi penuh? (reset saat in range lagi)
  ilAlerted?: boolean; // sudah kirim alert rugi bersih? (reset saat pulih)
  dropAlerted?: boolean; // LAMA: sudah kirim alert anjlok? (dimigrasi ke dropTier)
  dropTier?: number; // berapa anak tangga anjlok yang sudah dialerti (0 = belum)
  stoppedAt?: number;
  resultEthWei?: string; // ETH diterima saat stop (untuk PnL final)
  imported?: boolean; // ditemukan on-chain (bukan dibuka via bot) → entry tak diketahui
  leftoverWei?: string; // sisa token dari posisi ini yang belum ke-cash-out (batas jual auto-sweep — lindungi bag spot)
  side?: 'base' | 'token'; // sisi setoran saat buka; kosong = base (posisi lama)
  nominalToken?: string; // nominal token yang disetor (sisi token)
  groupId?: string; // ladder Bid-Ask/Spot: N leg berbagi groupId = 1 posisi logis; kosong = posisi tunggal
  legIndex?: number; // urutan leg dalam grup (0 = terdekat harga)
  legCount?: number; // total leg dalam grup
  shape?: 'spot' | 'bidask'; // bentuk distribusi modal ladder
};

/** Semua leg dalam satu grup ladder (urut legIndex). groupId kosong = array kosong. */
export function group(groupId: string): PosRecord[] {
  return records.filter((r) => r.groupId === groupId).sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0));
}

const FILE = join(process.cwd(), 'data', 'positions.json');

let records: PosRecord[] = load();

function load(): PosRecord[] {
  try {
    if (!existsSync(FILE)) return [];
    return JSON.parse(readFileSync(FILE, 'utf8')) as PosRecord[];
  } catch (e) {
    // Mulai KOSONG = bunuh diri: monitor memanggil update() dalam 60 detik pertama,
    // dan persist() menimpa satu-satunya salinan modal awal (initialWethWei), entry
    // price, dan status semua posisi. Sisihkan file rusaknya lalu BERHENTI — biar
    // systemd me-restart dengan berisik daripada mengamputasi posisi diam-diam.
    const aside = `${FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(FILE, aside);
    } catch {
      /* tak bisa dipindah pun, tetap jangan lanjut */
    }
    console.error(`[store] positions.json rusak (${(e as Error).message}) — disisihkan ke ${aside}`);
    throw e;
  }
}

function persist() {
  writeJson(FILE, records);
}

/**
 * tokenId yang sedang ditutup (nilai = epoch mulai) — dibaca monitor & guard double-tap.
 * Di sini (bukan index.ts) agar monitor.ts bisa ikut melihatnya.
 */
export const closing = new Map<string, number>();

/**
 * Operasi uang yang sedang berjalan (add/close/swap/bridge). Monitor tak boleh
 * menyapu/unwrap saat >0: dua tx dari satu wallet = tabrakan nonce, dan
 * sweepStuckWeth bisa menelan WETH yang baru di-wrap untuk mint.
 */
let moneyOps = 0;
export const beginMoneyOp = (): void => {
  moneyOps++;
};
export const endMoneyOp = (): void => {
  moneyOps = Math.max(0, moneyOps - 1);
};
export const isBusy = (): boolean => moneyOps > 0 || closing.size > 0;

export const all = (): PosRecord[] => records;
export const active = (): PosRecord[] => records.filter((r) => r.status === 'ACTIVE');
export const get = (tokenId: string): PosRecord | undefined => records.find((r) => r.tokenId === tokenId);

/** Impor posisi yang ditemukan on-chain (bukan dibuka via bot). No-op bila sudah ada. */
export function addImported(rec: {
  tokenId: string;
  chain: string;
  ca: string;
  fee: number;
  symbol: string;
  baseKind: BaseKind;
}): void {
  if (records.some((r) => r.tokenId === rec.tokenId)) return;
  records.push({
    tokenId: rec.tokenId,
    chain: rec.chain,
    ca: rec.ca,
    fee: rec.fee,
    symbol: rec.symbol,
    baseKind: rec.baseKind,
    initialWethWei: '0', // entry tak diketahui
    openedAt: Date.now(),
    status: 'ACTIVE',
    imported: true,
  });
  persist();
}

export function add(rec: PosRecord) {
  records = records.filter((r) => r.tokenId !== rec.tokenId).concat(rec);
  persist();
}

export function update(tokenId: string, patch: Partial<PosRecord>) {
  const r = records.find((x) => x.tokenId === tokenId);
  if (!r) return;
  Object.assign(r, patch);
  persist();
}

/** Keluarkan posisi dari store live (history sudah pindah ke jurnal). */
export function remove(tokenId: string) {
  const before = records.length;
  records = records.filter((r) => r.tokenId !== tokenId);
  if (records.length !== before) persist();
}
