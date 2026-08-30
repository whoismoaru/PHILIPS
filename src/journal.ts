import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { baseDecimalsOf, getChain, CHAINS, type BaseKind } from './chains.js';

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
  baseKind?: BaseKind; // denominasi modal & hasil; kosong = weth (entri lama)
  openedAt: number;
  closedAt: number;
  initialWethWei: string;
  resultEthWei?: string; // kosong = tidak diketahui (posisi gone/burned)
  pnlEth: number;
  pnlPct: number;
  reason: 'cashed' | 'gone' | 'burned' | 'recovery';
  wallet?: string; // alamat pemilik (huruf kecil). Kosong = entri sebelum field ini ada.
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

/** Alamat wallet yang sedang dipakai, huruf kecil. undefined bila belum tersambung. */
export function currentWallet(): string | undefined {
  try {
    return getChain().wallet.address.toLowerCase();
  } catch {
    return undefined;
  }
}

export function record(e: JournalEntry): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    // Cap alamat pemilik: ganti wallet TIDAK boleh membuat riwayat wallet lama
    // ikut terhitung di /pnl. Sekali tercatat, entri terikat ke pemiliknya.
    const stamped: JournalEntry = { ...e, wallet: e.wallet ?? currentWallet() };
    appendFileSync(FILE, JSON.stringify(stamped) + '\n');
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
    baseKind?: BaseKind;
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
/**
 * Satuan buku PnL. Diambil dari metadata chain, bukan daftar khusus — dulu hanya
 * BSC yang dikecualikan, sehingga trade native HyperEVM (HYPE) tercatat sebagai
 * 'ETH' dan menyatu ke buku ETH chain lain. 'usdc' juga terlewat dan jatuh ke
 * cabang native, jadi trade USDC terbaca sebagai ETH/BNB.
 */
export function unitOf(chain?: string, baseKind?: JournalEntry['baseKind']): string {
  const bk = baseKind ?? 'weth';
  if (bk === 'usdg') return 'USDG';
  if (bk === 'usdt') return 'USDT';
  if (bk === 'usdc') return 'USDC';
  return CHAINS[chain ?? 'robinhood']?.nativeSymbol ?? 'ETH';
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
  USDC: 0.1,
  ETH: 0.00005, // ~$0,11 @ $2.300
  BNB: 0.0002, // ~$0,13 @ $650
  HYPE: 0.0012, // ~$0,10 @ $83
};

/**
 * Satuan yang tak ada di tabel: ambangnya nyaris nol, BUKAN 0.1.
 *
 * Fallback lama 0.1 dipakai apa adanya untuk satuan native mana pun yang belum
 * terdaftar — pada HYPE (~$83) itu berarti setiap trade di bawah ±$8,36 diam-diam
 * dicap "impas" dan hilang dari W/L, winrate, dan jumlah trade. Salah menghitung
 * debu sebagai trade jauh lebih ringan daripada menghapus trade sungguhan, jadi
 * yang tak dikenal dibiarkan masuk skor.
 */
const FLAT_EPS_UNKNOWN = 1e-9;

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
  const me = currentWallet();
  const all = read(Number.MAX_SAFE_INTEGER).filter(
    (e) =>
      (e.closedAt ?? 0) >= sinceMs &&
      (!chain || (e.chain ?? 'robinhood') === chain) &&
      // Hanya trade wallet yang SEDANG dipakai. Entri tanpa cap pemilik dianggap
      // milik wallet lain — mencampurnya membuat PnL berbohong setelah ganti wallet.
      (!me || e.wallet === me),
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
    const eps = FLAT_EPS[unit] ?? FLAT_EPS_UNKNOWN;
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
/**
 * PnL harian 30 hari terakhir untuk SATU buku (chain + satuan).
 *
 * Satu buku saja, bukan gabungan: menjumlahkan USDG dengan ETH menghasilkan angka
 * yang tak punya satuan. Buku dipilih pemanggil (biasanya yang paling banyak trade).
 * Hari tanpa trade tetap ada di daftar dengan net 0 dan trades 0 — kalender butuh
 * kotak kosongnya, dan "tak ada trade" berbeda dari "impas".
 */
/**
 * Batas hari kalender = tengah malam **WIB**, bukan tengah malam server.
 *
 * Bucket dulu dibuat dengan `setHours(0,0,0,0)` — tengah malam zona MESIN, dan
 * mesin ini berjalan di CST (UTC+8) sementara seluruh kartu bot berstempel WIB
 * (UTC+7). Trade yang ditutup antara 23:00–24:00 WIB jatuh ke kotak HARI
 * BERIKUTNYA, jadi kalender tak pernah cocok dengan jam yang tercetak di kartu
 * close-nya sendiri. Indeks hari kini dihitung dari epoch + 7 jam, bebas dari
 * zona waktu mesin.
 *
 * `date` yang dikembalikan adalah tengah malam UTC dari hari WIB itu — kartu
 * membacanya dengan getUTC*, sehingga label tanggal & kolom harinya tak ikut
 * bergeser di mesin dengan zona lain.
 */
const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const wibDay = (ms: number): number => Math.floor((ms + WIB_MS) / DAY_MS);

/** 30 kotak hari WIB yang berakhir hari ini. */
function wibBuckets(days: number): Array<{ date: Date; net: number; trades: number; _i: number }> {
  const today = wibDay(Date.now());
  return Array.from({ length: days }, (_, k) => {
    const i = today - (days - 1) + k;
    return { date: new Date(i * DAY_MS), net: 0, trades: 0, _i: i };
  });
}

export function dailyFor(
  chain: string,
  unit: string,
  days = 30,
): Array<{ date: Date; net: number; trades: number }> {
  const me = currentWallet();
  const buckets = wibBuckets(days);
  const first = buckets[0]._i;

  for (const e of read(Number.MAX_SAFE_INTEGER)) {
    if (!e.closedAt) continue;
    if ((e.chain ?? 'robinhood') !== chain) continue;
    if (me && e.wallet !== me) continue;
    if (e.resultEthWei === undefined || BigInt(e.resultEthWei) === 0n) continue;
    if (unitOf(e.chain, e.baseKind) !== unit) continue;
    const i = wibDay(e.closedAt) - first;
    if (i < 0 || i >= days) continue;
    buckets[i].net += e.pnlEth;
    // 'recovery' = sisa token yang tersapu setelah posisi ditutup. Uangnya nyata
    // (masuk net), tapi ia bukan trade — menghitungnya membuat jumlah trade di
    // kalender lebih besar daripada di rekap yang berdiri tepat di sebelahnya.
    if (e.reason !== 'recovery') buckets[i].trades += 1;
  }
  return buckets.map(({ date, net, trades }) => ({ date, net, trades }));
}

/**
 * PnL harian 30 hari untuk SEMUA chain, disatukan dalam USD.
 *
 * Menjumlahkan USDG + ETH + BNB butuh kurs, jadi pemanggil menyerahkan `usdOf(unit)`.
 * Satuan yang kursnya tak terbaca DILEWATI dan dihitung di `skipped` — lebih baik
 * memberi tahu ada yang tak masuk daripada diam-diam menghasilkan total yang kurang.
 */
export function dailyAllUsd(
  usdOf: (unit: string) => number | null,
  days = 30,
): { days: Array<{ date: Date; net: number; trades: number }>; skipped: number } {
  const me = currentWallet();
  const buckets = wibBuckets(days);
  const first = buckets[0]._i;
  let skipped = 0;
  for (const e of read(Number.MAX_SAFE_INTEGER)) {
    if (!e.closedAt) continue;
    if (me && e.wallet !== me) continue;
    if (e.resultEthWei === undefined || BigInt(e.resultEthWei) === 0n) continue;
    const i = wibDay(e.closedAt) - first;
    // Di luar jendela dilewati DULU: entri lama tanpa kurs dulu ikut menaikkan
    // `skipped`, jadi kartu melaporkan "12 dilewati" untuk trade bulan lalu yang
    // memang tak pernah masuk hitungan 30 hari ini.
    if (i < 0 || i >= days) continue;
    const rate = usdOf(unitOf(e.chain, e.baseKind));
    if (rate === null) {
      skipped++;
      continue;
    }
    buckets[i].net += e.pnlEth * rate;
    if (e.reason !== 'recovery') buckets[i].trades += 1;
  }
  return { days: buckets.map(({ date, net, trades }) => ({ date, net, trades })), skipped };
}

export function chainsWithHistory(): Array<{ key: string; trades: number }> {
  const me = currentWallet();
  const n = new Map<string, number>();
  for (const e of read(Number.MAX_SAFE_INTEGER)) {
    if (me && e.wallet !== me) continue; // bubble chain ikut wallet yang dipakai
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
