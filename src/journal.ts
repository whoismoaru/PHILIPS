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

export type LifetimeStats = {
  count: number; // total entri jurnal
  known: number; // cashout nyata (hasil terukur) yang dihitung PnL
  excluded: number; // entri lama tanpa hasil terukur (res=0 backfill) → diabaikan
  wins: number;
  losses: number;
  netEth: number;
  grossWin: number;
  grossLoss: number; // negatif
  best?: { symbol: string; pnlEth: number };
  worst?: { symbol: string; pnlEth: number };
};

/**
 * Rekap PnL seumur hidup dari cashout NYATA.
 * Kecualikan entri tanpa hasil terukur:
 *   - resultEthWei undefined  → posisi gone/burned (NFT hilang)
 *   - resultEthWei == 0        → placeholder backfill trade lama (posisi dimigrasi TANPA data
 *     hasil → default 0). Ini BUKAN rugi total: cashout nyata selalu kembalikan >0. Dulu 12
 *     entri semacam ini memalsukan net jadi -0.83 ETH padahal cashout riil ≈ +0.016 ETH.
 * ponytail: pnlEth dijumlah sebagai ETH. Semua close sejauh ini = WETH (USDG belum live). Bila
 * USDG dipakai: tambah baseKind ke JournalEntry & pisahkan agregat per-denominasi.
 */
export function lifetimeStats(): LifetimeStats {
  const all = read(Number.MAX_SAFE_INTEGER);
  let wins = 0, losses = 0, netEth = 0, grossWin = 0, grossLoss = 0, known = 0, excluded = 0;
  let best: { symbol: string; pnlEth: number } | undefined;
  let worst: { symbol: string; pnlEth: number } | undefined;
  for (const e of all) {
    if (e.resultEthWei === undefined) continue; // gone/burned → tak terukur
    if (BigInt(e.resultEthWei) === 0n) { excluded++; continue; } // placeholder backfill lama
    known++;
    netEth += e.pnlEth;
    if (e.pnlEth >= 0) { wins++; grossWin += e.pnlEth; } else { losses++; grossLoss += e.pnlEth; }
    if (!best || e.pnlEth > best.pnlEth) best = { symbol: e.symbol, pnlEth: e.pnlEth };
    if (!worst || e.pnlEth < worst.pnlEth) worst = { symbol: e.symbol, pnlEth: e.pnlEth };
  }
  return { count: all.length, known, excluded, wins, losses, netEth, grossWin, grossLoss, best, worst };
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
