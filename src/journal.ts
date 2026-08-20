import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { baseDecimalsOf } from './chains.js';

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
  baseKind?: 'weth' | 'usdg' | 'usdt'; // denominasi modal & hasil; kosong = weth (entri lama)
  openedAt: number;
  closedAt: number;
  initialWethWei: string;
  resultEthWei?: string; // kosong = tidak diketahui (posisi gone/burned)
  pnlEth: number;
  pnlPct: number;
  reason: 'cashed' | 'gone' | 'burned' | 'recovery';
};

const FILE = join(process.cwd(), 'data', 'journal.jsonl');

/**
 * Catat PEMULIHAN sisa token yang baru berhasil disapu setelah posisinya ditutup.
 *
 * Tanpa ini jurnal permanen mengecilkan PnL: entri close sudah tertulis dengan hasil
 * saat itu, lalu monitor menjual sisanya berjam-jam kemudian dan hasilnya tak pernah
 * masuk ke mana pun. 'recovery' menambah NET ke buku denominasinya tapi TIDAK
 * dihitung sebagai trade (tak menggeser jumlah trade / winrate).
 */
export function recordRecovery(r: {
  tokenId: string;
  symbol: string;
  ca?: string;
  chain?: string;
  baseKind?: JournalEntry['baseKind'];
  amountWei: bigint;
}): void {
  const amt = Number(ethers.formatUnits(r.amountWei, baseDecimalsOf(r.chain, r.baseKind)));
  if (!(amt > 0)) return;
  record({
    tokenId: r.tokenId,
    symbol: r.symbol,
    ca: r.ca,
    chain: r.chain,
    baseKind: r.baseKind,
    openedAt: Date.now(),
    closedAt: Date.now(),
    initialWethWei: '0',
    resultEthWei: r.amountWei.toString(),
    pnlEth: amt,
    pnlPct: 0,
    reason: 'recovery',
  });
}

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
  rec: {
    tokenId: string;
    symbol: string;
    ca?: string;
    chain?: string;
    baseKind?: 'weth' | 'usdg' | 'usdt';
    openedAt: number;
    initialWethWei: string;
  },
  opts: { resultEthWei?: bigint; reason: JournalEntry['reason'] },
): void {
  // Desimal WAJIB dari konfigurasi chain: USDG Robinhood 6, USDT BSC 18. Menulis
  // "stable = 6" di sini pernah membuat 48 USDT tercatat sebagai 48.000.000.000.000.
  const dec = baseDecimalsOf(rec.chain, rec.baseKind);
  const initF = Number(ethers.formatUnits(BigInt(rec.initialWethWei || '0'), dec));
  const has = opts.resultEthWei !== undefined;
  const resF = has ? Number(ethers.formatUnits(opts.resultEthWei as bigint, dec)) : 0;
  const pnlEth = has ? resF - initF : 0;
  const pnlPct = has && initF > 0 ? (pnlEth / initF) * 100 : 0;
  record({
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    ca: rec.ca,
    chain: rec.chain,
    baseKind: rec.baseKind,
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

/** Label denominasi sebuah entri. 'weth' di BSC berarti BNB, bukan ETH. */
export function unitOf(chain?: string, baseKind?: JournalEntry['baseKind']): string {
  const bk = baseKind ?? 'weth';
  if (bk === 'usdg') return 'USDG';
  if (bk === 'usdt') return 'USDT';
  return (chain ?? 'robinhood') === 'bsc' ? 'BNB' : 'ETH';
}

/** Satu buku PnL = satu denominasi (ETH / BNB / USDG / USDT). */
/**
 * Ambang "impas": di bawah ini hasilnya bukan untung maupun rugi, cuma debu — dan
 * memasukkannya ke W/L memalsukan winrate. Nilainya per SATUAN, disetel supaya
 * kira-kira setara $0,1: stablecoin apa adanya, ETH/BNB dikonversi kasar dari
 * harganya. Kasar disengaja — ini penyaring debu, bukan akuntansi.
 */
const FLAT_EPS: Record<string, number> = {
  USDT: 0.1,
  USDG: 0.1,
  ETH: 0.00005, // ~$0,11 @ $2.300
  BNB: 0.0002, // ~$0,13 @ $650
};

/** Winrate = menang / (menang + kalah). Impas tak masuk penyebut. */
export const winrateOf = (b: { wins: number; losses: number }): number =>
  b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses)) * 100 : 0;

/**
 * Profit factor = total untung / total rugi. <1 berarti RUGI meski winrate tinggi —
 * satu-satunya angka yang tak bisa berbohong seperti winrate. BSC: 86,31/224,92 = 0,38.
 */
export const profitFactorOf = (b: { grossWin: number; grossLoss: number }): number | null =>
  b.grossLoss < 0 ? b.grossWin / Math.abs(b.grossLoss) : null;

export type Book = {
  unit: string;
  known: number;
  wins: number;
  losses: number;
  flats: number; // hasil di bawah ambang debu — bukan menang, bukan kalah
  net: number;
  grossWin: number;
  grossLoss: number; // negatif
  best?: { symbol: string; pnl: number };
  worst?: { symbol: string; pnl: number };
};

export type PeriodStats = {
  count: number; // entri jurnal dalam periode
  known: number; // trade BERKEPUTUSAN (menang/kalah); impas tak dihitung
  untracked: number; // gone/burned — hasil tak diketahui
  excluded: number; // placeholder backfill lama (result 0)
  recovered: number; // entri pemulihan sisa token (masuk net, bukan trade)
  books: Book[]; // urut: paling banyak trade dulu
};

/**
 * Rekap PnL untuk sebuah periode, DIPISAH PER DENOMINASI.
 *
 * Dulu semuanya dipaksa jadi satu angka "net ETH", lalu tiap entri non-weth /
 * non-robinhood DIBUANG. Akibatnya 82 dari 271 entri tak pernah tampil — termasuk
 * SELURUH 44 trade BSC (net -138,61 USDT). Buku yang paling rugi justru tak
 * kelihatan. Menjumlahkan ETH + BNB + USDT jelas salah, jadi jawabannya bukan
 * membuang, tapi memisah: satu baris per denominasi.
 *
 * Tetap dikecualikan: resultEthWei undefined (gone/burned, hasil tak diketahui) dan
 * == 0 (placeholder backfill trade lama; cashout nyata selalu > 0).
 */
export function statsFor(sinceMs = 0, chain?: string): PeriodStats {
  const all = read(Number.MAX_SAFE_INTEGER).filter(
    (e) => (e.closedAt ?? 0) >= sinceMs && (!chain || (e.chain ?? 'robinhood') === chain),
  );
  const byUnit = new Map<string, Book>();
  let known = 0, untracked = 0, excluded = 0, recovered = 0;
  for (const e of all) {
    if (e.resultEthWei === undefined) { untracked++; continue; }
    if (BigInt(e.resultEthWei) === 0n) { excluded++; continue; }
    const unit = unitOf(e.chain, e.baseKind);
    let b = byUnit.get(unit);
    if (!b) {
      b = { unit, known: 0, wins: 0, losses: 0, flats: 0, net: 0, grossWin: 0, grossLoss: 0 };
      byUnit.set(unit, b);
    }
    // 'recovery' = sisa token yang baru tersapu setelah posisinya ditutup. Uangnya
    // NYATA (masuk net & profit), tapi itu bukan trade tersendiri — menghitungnya
    // sebagai trade akan menggelembungkan jumlah trade sekaligus memalsukan winrate.
    if (e.reason === 'recovery') {
      b.net += e.pnlEth;
      b.grossWin += e.pnlEth;
      recovered++;
      continue;
    }
    b.net += e.pnlEth;
    // Trade yang hasilnya bukan untung maupun rugi (di bawah ~$0,1) TIDAK dihitung
    // sebagai menang MAUPUN kalah: ia cuma impas. Dulu `pnlEth >= 0` melemparnya ke
    // kolom menang dan menggelembungkan winrate (BSC: 10 entri impas menaikkan
    // 91,2% → 93,2%). Uangnya tetap masuk `net` — yang tak dihitung hanya SKOR-nya.
    const eps = FLAT_EPS[unit] ?? 0.1;
    if (e.pnlEth > eps) { b.wins++; b.grossWin += e.pnlEth; }
    else if (e.pnlEth < -eps) { b.losses++; b.grossLoss += e.pnlEth; }
    else { b.flats++; continue; }
    known++;
    b.known++;
    if (!b.best || e.pnlEth > b.best.pnl) b.best = { symbol: e.symbol, pnl: e.pnlEth };
    if (!b.worst || e.pnlEth < b.worst.pnl) b.worst = { symbol: e.symbol, pnl: e.pnlEth };
  }
  const books = [...byUnit.values()].sort((a, b) => b.known - a.known);
  return { count: all.length, known, untracked, excluded, recovered, books };
}

/**
 * Chain yang punya riwayat di jurnal, urut terbanyak. Dipakai untuk bubble pemilih
 * chain di /pnl — dibangun dari DATA, bukan daftar keras, jadi chain baru (mis.
 * Base) muncul sendiri begitu ada trade pertamanya, dan chain lama yang sudah tak
 * dipakai (mis. 'stable') tetap bisa dilihat riwayatnya.
 */
export function chainsWithHistory(): Array<{ key: string; trades: number }> {
  const n = new Map<string, number>();
  for (const e of read(Number.MAX_SAFE_INTEGER)) {
    const k = e.chain ?? 'robinhood';
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()]
    .map(([key, trades]) => ({ key, trades }))
    .sort((a, b) => b.trades - a.trades);
}

export const PERIODS = {
  '1d': { label: '1 Day', ms: 24 * 3600_000 },
  '1w': { label: '1 Week', ms: 7 * 24 * 3600_000 },
  '1m': { label: '1 Month', ms: 30 * 24 * 3600_000 },
  all: { label: 'All Time', ms: 0 },
} as const;
export type PeriodKey = keyof typeof PERIODS;

/** Net ETH Robinhood seumur hidup — dipakai baris "realized" di /status. */
export function lifetimeNetEth(): number {
  return statsFor(0, 'robinhood').books.find((b) => b.unit === 'ETH')?.net ?? 0;
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
