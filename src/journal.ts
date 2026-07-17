import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';

/**
 * Jurnal riwayat trade (append-only, file khusus `data/journal.jsonl`).
 * Terpisah dari store posisi live — supaya history TIDAK ikut muncul saat cek
 * /positions. Lihat lewat /history.
 */

export type JournalEntry = {
  tokenId: string;
  symbol: string;
  ca?: string; // alamat token (untuk sweep sisa token yang belum ter-swap)
  chain?: string;
  openedAt: number;
  closedAt: number;
  initialWethWei: string;
  resultEthWei?: string; // kosong = tidak diketahui (posisi gone/burned)
  pnlEth: number;
  pnlPct: number;
  reason: 'cashed' | 'gone' | 'burned';
};

const FILE = join(process.cwd(), 'data', 'journal.jsonl');

export function record(e: JournalEntry): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    appendFileSync(FILE, JSON.stringify(e) + '\n');
  } catch (err) {
    console.error('[journal] gagal menulis:', (err as Error).message);
  }
}

/** Catat penutupan dari sebuah PosRecord (hitung PnL bila hasil diketahui). */
export function recordClose(
  rec: { tokenId: string; symbol: string; ca?: string; chain?: string; openedAt: number; initialWethWei: string },
  opts: { resultEthWei?: bigint; reason: JournalEntry['reason'] },
): void {
  const initF = Number(ethers.formatEther(BigInt(rec.initialWethWei || '0')));
  const has = opts.resultEthWei !== undefined;
  const resF = has ? Number(ethers.formatEther(opts.resultEthWei as bigint)) : 0;
  const pnlEth = has ? resF - initF : 0;
  const pnlPct = has && initF > 0 ? (pnlEth / initF) * 100 : 0;
  record({
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    ca: rec.ca,
    chain: rec.chain,
    openedAt: rec.openedAt,
    closedAt: Date.now(),
    initialWethWei: rec.initialWethWei,
    resultEthWei: has ? (opts.resultEthWei as bigint).toString() : undefined,
    pnlEth,
    pnlPct,
    reason: opts.reason,
  });
}

/** Alamat token unik (ca) dari N entri jurnal terbaru — untuk sweep sisa token. */
export function recentTokens(limit = 80): Array<{ ca: string; chain?: string; symbol: string }> {
  const seen = new Set<string>();
  const out: Array<{ ca: string; chain?: string; symbol: string }> = [];
  for (const e of read(limit)) {
    if (!e.ca) continue;
    const key = `${e.chain ?? 'robinhood'}:${e.ca.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ca: e.ca, chain: e.chain, symbol: e.symbol });
  }
  return out;
}

/** Baca N entri terbaru (terbaru dulu). */
export function read(limit = 20): JournalEntry[] {
  try {
    if (!existsSync(FILE)) return [];
    const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
    const out: JournalEntry[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as JournalEntry);
      } catch {
        /* lewati baris rusak */
      }
    }
    return out.slice(-limit).reverse();
  } catch {
    return [];
  }
}
