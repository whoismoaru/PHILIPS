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
  /** Harga USD satuan entri ini SAAT ditutup. Absen = entri lama / kurs tak terbaca. */
  usdRate?: number;
  /**
   * Penanda LADDER: semua leg dari satu posisi logis memakai id yang sama.
   *
   * Tanpa ini jurnal tak punya cara tahu bahwa 8 baris itu satu close. Skornya
   * lalu menghitung satu ladder sebagai 8 trade, dan — jauh lebih merusak —
   * membagi PnL-nya jadi ~1/8 sehingga tiap leg jatuh di bawah ambang debu dan
   * lenyap dari W/L. Uangnya tetap benar; yang bohong cuma jumlah & winrate.
   * Absen = entri tunggal, atau entri lama (dikelompokkan mundur, lihat `groupKey`).
   */
  groupId?: string;
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

/**
 * Kurs USD tiap satuan, disegarkan denyut monitor (lihat `noteUsdRate`).
 *
 * Dipakai untuk MENCAP entri saat ditutup, bukan saat dibaca: PnL 0,245 ETH yang
 * dicatat hari ini harus tetap bernilai $607 walau ETH bergerak besok. Tanpa cap,
 * rekap historis ikut naik-turun mengikuti harga hari ini — bukan hasil trade-nya
 * yang berubah, cuma kursnya.
 *
 * Kurs basi (> 30 menit) TIDAK dipakai: lebih baik entri tanpa cap — yang nanti
 * dihitung dengan kurs sekarang dan dilaporkan sebagai taksiran — daripada dicap
 * dengan harga setengah jam lalu yang terlanjur salah selamanya.
 */
const RATE_TTL_MS = 30 * 60_000;
const usdRates = new Map<string, { usd: number; t: number }>();

export function noteUsdRate(unit: string, usd: number | null): void {
  if (usd !== null && Number.isFinite(usd) && usd > 0) usdRates.set(unit, { usd, t: Date.now() });
}

const rateNow = (unit: string): number | undefined => {
  const r = usdRates.get(unit);
  return r && Date.now() - r.t < RATE_TTL_MS ? r.usd : undefined;
};

export function record(e: JournalEntry): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    // Cap alamat pemilik: ganti wallet TIDAK boleh membuat riwayat wallet lama
    // ikut terhitung di /pnl. Sekali tercatat, entri terikat ke pemiliknya.
    const stamped: JournalEntry = {
      ...e,
      wallet: e.wallet ?? currentWallet(),
      // Kurs SAAT ditutup — sekali tercatat, nilainya tak ikut bergerak lagi.
      usdRate: e.usdRate ?? rateNow(unitOf(e.chain, e.baseKind)),
    };
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
  opts: { resultEthWei?: bigint; reason: JournalEntry['reason']; groupId?: string },
): void {
  // Desimal WAJIB dari konfigurasi chain: USDG Robinhood 6, USDT BSC 18. Menulis
  // "stable = 6" di sini pernah membuat 48 USDT tercatat sebagai 48.000.000.000.000.
  const dec = baseDecimalsOf(rec.chain, rec.baseKind);
  const initF = Number(ethers.formatUnits(BigInt(rec.initialWethWei || '0'), dec));
  const has = opts.resultEthWei !== undefined;
  const resF = has ? Number(ethers.formatUnits(opts.resultEthWei as bigint, dec)) : 0;
  // Hasil ADA tapi modal nol = modalnya tak pernah terekam (posisi tak ter-track),
  // BUKAN modal nol sungguhan. `resF - 0` akan membukukan seluruh cash-out sebagai
  // laba murni — tiga entri seperti ini pernah menambah $662 laba yang tak ada ke
  // /pnl. Catat hasilnya (uangnya nyata, sweep tetap butuh ca-nya), tapi biarkan
  // PnL-nya nol supaya statsFor bisa mengenalinya dan melewatinya.
  const modalHilang = has && initF <= 0 && opts.reason !== 'recovery';
  const pnlEth = has && !modalHilang ? resF - initF : 0;
  const pnlPct = has && initF > 0 ? (pnlEth / initF) * 100 : 0;
  if (modalHilang)
    console.warn(`[journal] ${rec.symbol} ${rec.tokenId}: hasil terukur tapi modal tak terekam — PnL dilewati`);
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
    groupId: opts.groupId,
  });
}

/** Alamat token unik (ca) dari N entri jurnal terbaru — untuk sweep sisa token. */
export function recentTokens(limit = 80): Array<{ ca: string; chain?: string; symbol: string }> {
  const seen = new Set<string>();
  const out: Array<{ ca: string; chain?: string; symbol: string }> = [];
  for (const e of readMine(limit)) {
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
  USD: 0.1,
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
  count: number; // entri jurnal dalam periode (satu ladder = beberapa entri)
  /**
   * POSISI yang berhasil dinilai — satu ladder 8-leg dihitung SEKALI. Inilah
   * penyebut yang benar untuk skor: `positions === known + flats`.
   */
  positions: number;
  legs: number; // entri yang masuk penilaian (sebelum digabung jadi posisi)
  known: number; // POSISI berkeputusan (menang/kalah); impas tak dihitung
  untracked: number; // gone/burned — hasil tak diketahui
  excluded: number; // placeholder backfill lama (result 0)
  /**
   * MODAL tak terekam (initialWethWei 0) padahal hasilnya terukur. Dilewati:
   * `pnlEth = hasil - 0` membukukan SELURUH cash-out sebagai laba murni. Pada
   * jurnal sungguhan cuma 3 entri, tapi ketiganya menyumbang $662 — 36% dari net
   * yang dilaporkan. Hasil tanpa modal bukan laba besar, ia laba yang TAK TERHITUNG.
   */
  noCapital: number;
  recovered: number; // entri pemulihan sisa token (masuk net, bukan trade)
  unconverted: number; // mode USD: entri yang kursnya tak terbaca — DILEWATI, bukan dianggap nol
  estimated: number; // mode USD: entri lama tanpa cap kurs, dinilai dgn kurs SEKARANG
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
export function statsFor(sinceMs = 0, chain?: string, usdOf?: (unit: string) => number | null): PeriodStats {
  const me = currentWallet();
  // Gagal TERTUTUP, sama seperti readMine. Tanpa alamat pemilik, filter di bawah
  // dulu dilewati diam-diam dan seluruh jurnal ikut terhitung — 269 entri wallet
  // lama tampil sebagai PnL-mu, justru di saat kita paling tak tahu siapa
  // pemiliknya. /history kosong sementara /pnl menggelembung.
  if (!me)
    return { count: 0, positions: 0, legs: 0, known: 0, untracked: 0, excluded: 0, noCapital: 0, recovered: 0, unconverted: 0, estimated: 0, books: [] };
  const all = read(Number.MAX_SAFE_INTEGER).filter(
    (e) =>
      (e.closedAt ?? 0) >= sinceMs &&
      (!chain || (e.chain ?? 'robinhood') === chain) &&
      // Hanya trade wallet yang SEDANG dipakai. Entri tanpa cap pemilik dianggap
      // milik wallet lain — mencampurnya membuat PnL berbohong setelah ganti wallet.
      e.wallet === me,
  );
  const byUnit = new Map<string, Book>();
  let known = 0, untracked = 0, excluded = 0, noCapital = 0, recovered = 0, unconverted = 0, estimated = 0;
  const bookOf = (unit: string): Book => {
    let b = byUnit.get(unit);
    if (!b) {
      b = { unit, known: 0, wins: 0, losses: 0, flats: 0, net: 0, grossWin: 0, grossLoss: 0 };
      byUnit.set(unit, b);
    }
    return b;
  };
  // Langkah 1 — nilai tiap entri. NET dijumlah di sini, per-entri: uangnya tak
  // peduli pengelompokan, dan menjumlahkannya dua kali lewat grup hanya menambah
  // jalan untuk salah.
  type Skor = { e: JournalEntry; unit: string; nilai: number };
  const skor: Skor[] = [];
  for (const e of all) {
    if (e.resultEthWei === undefined) { untracked++; continue; }
    if (BigInt(e.resultEthWei) === 0n) { excluded++; continue; }
    // Hasil ADA tapi modal tak pernah tercatat → PnL tak bisa dihitung, bukan
    // "untung sebesar seluruh hasil". 'recovery' memang bermodal nol dan itu sah:
    // modalnya sudah dibukukan di entri close aslinya, ini cuma sisa yang menyusul.
    if (e.reason !== 'recovery' && BigInt(e.initialWethWei || '0') === 0n) { noCapital++; continue; }
    const native = unitOf(e.chain, e.baseKind);
    // Kurs SAAT ENTRI DITUTUP kalau tercap; kurs sekarang hanya sebagai cadangan
    // untuk entri lama (sebelum pencapan ada). Yang memakai cadangan dihitung —
    // nilainya ikut bergerak mengikuti pasar, jadi tak boleh disamakan diam-diam
    // dengan entri yang angkanya sudah terkunci.
    let rate: number | null | undefined = 1;
    if (usdOf) {
      rate = e.usdRate;
      if (rate === undefined) {
        rate = usdOf(native);
        if (rate !== null) estimated++;
      }
      if (rate === null) { unconverted++; continue; }
    }
    const unit = usdOf ? 'USD' : native;
    const nilai = e.pnlEth * (rate ?? 1);
    bookOf(unit).net += nilai;
    // 'recovery' = sisa token yang baru tersapu setelah posisinya ditutup. Uangnya
    // NYATA (masuk net & profit), tapi itu bukan trade tersendiri — menghitungnya
    // sebagai trade akan menggelembungkan jumlah trade sekaligus memalsukan winrate.
    if (e.reason === 'recovery') {
      bookOf(unit).grossWin += nilai;
      recovered++;
      continue;
    }
    skor.push({ e, unit, nilai });
  }
  // Langkah 2 — SKOR per POSISI, bukan per leg. Satu ladder 8-leg adalah satu
  // trade; menilainya per leg memecah PnL-nya jadi ~1/8 sehingga tiap potongan
  // jatuh di bawah ambang debu dan hilang dari W/L. Pada jurnal 705 entri, 522 di
  // antaranya leg ladder: skor per-leg membaca 705 trade / 84,5% WR / 454 impas,
  // padahal yang sebenarnya terjadi 230 trade / 90,5% WR / 72 impas.
  const grup2 = groupOf(skor);
  for (const grup of grup2) {
    const unit = grup[0].unit;
    const b = bookOf(unit);
    const nilai = grup.reduce((a, g) => a + g.nilai, 0);
    // Trade yang hasilnya bukan untung maupun rugi (di bawah ~$0,1) TIDAK dihitung
    // sebagai menang MAUPUN kalah: ia cuma impas. Dulu `pnlEth >= 0` melemparnya ke
    // kolom menang dan menggelembungkan winrate. Uangnya sudah masuk `net` di atas —
    // yang tak dihitung di sini hanya SKOR-nya.
    const eps = FLAT_EPS[unit] ?? FLAT_EPS_UNKNOWN;
    if (nilai > eps) { b.wins++; b.grossWin += nilai; }
    else if (nilai < -eps) { b.losses++; b.grossLoss += nilai; }
    else { b.flats++; continue; }
    known++;
    b.known++;
    const symbol = grup[0].e.symbol;
    if (!b.best || nilai > b.best.pnl) b.best = { symbol, pnl: nilai };
    if (!b.worst || nilai < b.worst.pnl) b.worst = { symbol, pnl: nilai };
  }
  const books = [...byUnit.values()].sort((a, b) => b.known - a.known);
  // `count` tetap JUMLAH ENTRI, bukan jumlah posisi: itulah yang direkonsiliasi
  // caption ("N closed → M scored") terhadap panjang jurnal.
  return {
    count: all.length,
    positions: grup2.length,
    legs: skor.length,
    known,
    untracked,
    excluded,
    noCapital,
    recovered,
    unconverted,
    estimated,
    books,
  };
}

/**
 * Jarak maksimum antar leg satu ladder yang ditutup bersama. Legnya dijurnalkan
 * dalam satu loop, jadi selisihnya milidetik; 30 detik memberi ruang lebar untuk
 * batch tx yang lambat tanpa pernah menyatukan dua close yang berbeda.
 */
const LADDER_GAP_MS = 30_000;

/**
 * Kelompokkan leg jadi posisi.
 *
 * `groupId` dipakai kalau ada. Entri LAMA tak punya — ditulis sebelum field ini
 * ada — jadi dikelompokkan mundur lewat (chain, ca, waktu tutup berdekatan).
 * Ini bukan tebakan longgar: pada jurnal sungguhan hasilnya 230 kelompok, dan
 * angkanya tak bergeser sama sekali saat ambangnya diubah 5s→60s.
 *
 * Dikelompokkan dengan MERAPATKAN entri berurutan, bukan membulatkan waktu ke
 * ember: pembulatan memisahkan dua leg yang cuma terpaut 1 ms bila keduanya
 * kebetulan jatuh di sisi berlawanan batas ember.
 */
function groupOf<T extends { e: JournalEntry }>(items: T[]): T[][] {
  const kunci = (x: T) => `${x.e.chain ?? 'robinhood'}|${(x.e.ca ?? x.e.symbol).toLowerCase()}`;
  const urut = [...items].sort(
    (a, b) => kunci(a).localeCompare(kunci(b)) || a.e.closedAt - b.e.closedAt,
  );
  const out: T[][] = [];
  let cur: T[] = [];
  for (const x of urut) {
    const prev = cur[cur.length - 1];
    const sama =
      prev !== undefined &&
      (prev.e.groupId !== undefined || x.e.groupId !== undefined
        ? prev.e.groupId === x.e.groupId
        : kunci(prev) === kunci(x) && x.e.closedAt - prev.e.closedAt <= LADDER_GAP_MS);
    if (sama) cur.push(x);
    else {
      if (cur.length) out.push(cur);
      cur = [x];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Batas hari = tengah malam **WIB**, bukan tengah malam server.
 *
 * Mesin ini berjalan di CST (UTC+8) sementara seluruh kartu bot berstempel WIB
 * (UTC+7), jadi `setHours(0,0,0,0)` menggeser batas periode satu jam. Indeks
 * hari dihitung dari epoch + 7 jam, bebas dari zona waktu mesin.
 */
const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const wibDay = (ms: number): number => Math.floor((ms + WIB_MS) / DAY_MS);

/**
 * Awal jendela "1 Month" = 30 hari WIB PENUH, bukan rolling `now - 30 hari`.
 *
 * Rolling membuat batasnya bergeser tiap kali kartu dibuka (hari ini mulai 31 Jul
 * 22:30 WIB), jadi trade yang sama bisa masuk lalu keluar dari rekap hanya karena
 * jam berjalan. Batas hari penuh membuat angkanya stabil sepanjang hari.
 */
export const monthStartMs = (days = 30): number => (wibDay(Date.now()) - (days - 1)) * DAY_MS - WIB_MS;

/**
 * Chain yang punya riwayat di jurnal, urut terbanyak. Dipakai untuk bubble pemilih
 * chain di /pnl — dibangun dari DATA, bukan daftar keras, jadi chain baru (mis.
 * Base) muncul sendiri begitu ada trade pertamanya, dan chain lama yang sudah tak
 * dipakai (mis. 'stable') tetap bisa dilihat riwayatnya.
 */
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


/**
 * Baca N entri terbaru MILIK WALLET YANG SEDANG DIPAKAI (terbaru dulu).
 *
 * `read()` mentah tak menyaring pemilik — dan setiap pembaca yang lupa
 * menyaringnya sendiri akan menampilkan riwayat wallet lain sebagai riwayatmu.
 * Jurnal ini sudah memuat 181 entri milik wallet lama; /history dan kandidat
 * sweep sama-sama memakai `read()` polos, jadi keduanya bocor begitu wallet
 * berganti. /pnl sendiri sudah menyaring sejak awal — inilah yang menyamakannya.
 *
 * Entri TANPA cap pemilik ikut dibuang: lebih baik satu baris hilang daripada
 * satu baris milik orang lain tampil sebagai milikmu.
 */
export function readMine(limit = 20): JournalEntry[] {
  const me = currentWallet();
  // Gagal tertutup. Kalau alamat wallet tak terbaca, mengembalikan SEMUA entri
  // berarti riwayat wallet lain tampil sebagai milikmu justru di saat kita paling
  // tak tahu siapa pemiliknya. Kosong itu jelas salah dan langsung terlihat;
  // daftar yang tercemar terlihat benar.
  if (!me) return [];
  const semua = read(Number.MAX_SAFE_INTEGER).filter((e) => e.wallet === me);
  return semua.slice(0, limit);
}

/** Baca N entri terbaru (terbaru dulu). TIDAK menyaring pemilik — lihat readMine. */
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
