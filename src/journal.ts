import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { baseDecimalsOf, getChain, CHAINS, type BaseKind } from './chains.js';

/**
 * Closed-trade journal (append-only, its own file at `data/journal.jsonl`).
 * Kept apart from the live position store so history does NOT surface when you
 * check /positions. Read it through /history.
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
  /** This entry's USD rate per unit AT CLOSE. Absent means an older entry, or an
   *  unreadable rate. */
  usdRate?: number;
  /**
   * LADDER marker: every leg of one logical position shares an id.
   *
   * Without it the journal has no way to know those 8 rows were a single close.
   * Scoring then counts one ladder as 8 trades and — far more damaging — splits
   * its PnL into eighths, so each leg drops under the dust threshold and vanishes
   * from W/L. The money stays right; what lies is the count and the winrate.
   * Absent means a single entry, or an older one (grouped after the fact, see
   * `groupOf`).
   */
  groupId?: string;
};

const FILE = join(process.cwd(), 'data', 'journal.jsonl');

/**
 * Record the RECOVERY of leftover tokens swept only after a position closed.
 *
 * Without it the journal permanently understates PnL: the close entry is written
 * with the proceeds known at the time, then the monitor sells the remainder hours
 * later and that money lands nowhere. A 'recovery' adds to its book's NET but is
 * NOT counted as a trade, so it never shifts the trade count or the winrate.
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

/** The wallet address in use, lowercased. undefined when not connected yet. */
export function currentWallet(): string | undefined {
  try {
    return getChain().wallet.address.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * USD rate per unit, refreshed on the monitor's pulse (see `noteUsdRate`).
 *
 * Used to STAMP an entry as it closes, not as it is read: a PnL of 0.245 ETH
 * booked today has to still be worth $607 tomorrow, whatever ETH does. Without
 * the stamp, historical recaps drift with today's price — the trade's result did
 * not change, only the rate did.
 *
 * A stale rate (over 30 minutes) is NOT used. Better an unstamped entry, valued
 * later at today's rate and reported as an estimate, than one stamped with a
 * half-hour-old price and wrong forever.
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
    // Stamp the owner: switching wallets must NOT pull the old wallet's history
    // into /pnl. Once written, an entry belongs to its owner.
    const stamped: JournalEntry = {
      ...e,
      wallet: e.wallet ?? currentWallet(),
      // The rate AT CLOSE. Once recorded, this value stops moving.
      usdRate: e.usdRate ?? rateNow(unitOf(e.chain, e.baseKind)),
    };
    appendFileSync(FILE, JSON.stringify(stamped) + '\n');
  } catch (err) {
    console.error('[journal] gagal menulis:', (err as Error).message);
  }
}

/** Journal a close from a PosRecord, computing PnL when the result is known. */
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
  // Decimals MUST come from chain config: USDG on Robinhood is 6, USDT on BSC is
  // 18. Hardcoding "stable = 6" here once recorded 48 USDT as 48,000,000,000,000.
  const dec = baseDecimalsOf(rec.chain, rec.baseKind);
  const initF = Number(ethers.formatUnits(BigInt(rec.initialWethWei || '0'), dec));
  const has = opts.resultEthWei !== undefined;
  const resF = has ? Number(ethers.formatUnits(opts.resultEthWei as bigint, dec)) : 0;
  // A result WITH a zero cost means the cost was never recorded (an untracked
  // position), not that it genuinely cost nothing. `resF - 0` would book the whole
  // cash-out as pure profit — three entries like that once added $662 of
  // non-existent gains to /pnl. Record the proceeds (the money is real, and sweeps
  // still need the ca), but leave PnL at zero so statsFor can recognise and skip it.
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

/** Unique token addresses (ca) from the last N journal entries, for leftover sweeps. */
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

/**
 * Book unit for an entry. 'weth' on BSC means BNB, not ETH.
 *
 * Taken from chain metadata rather than a special-case list. Only BSC used to be
 * excluded, so native HyperEVM trades (HYPE) were recorded as 'ETH' and merged
 * into another chain's ETH book. 'usdc' was missed too and fell through to the
 * native branch, making USDC trades read as ETH or BNB.
 */
export function unitOf(chain?: string, baseKind?: JournalEntry['baseKind']): string {
  const bk = baseKind ?? 'weth';
  if (bk === 'usdg') return 'USDG';
  if (bk === 'usdt') return 'USDT';
  if (bk === 'usdc') return 'USDC';
  return CHAINS[chain ?? 'robinhood']?.nativeSymbol ?? 'ETH';
}

/** One PnL book = one denomination (ETH / BNB / USDG / USDT). */
/**
 * The "break-even" threshold: below this a result is neither a win nor a loss,
 * just dust — and feeding it into W/L falsifies the winrate. Values are PER UNIT,
 * tuned to roughly $0.1: stablecoins as they are, ETH/BNB converted roughly from
 * their price. Rough on purpose; this is a dust filter, not accounting.
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
 * Units missing from the table get a near-zero threshold, NOT 0.1.
 *
 * The old fallback of 0.1 was applied as-is to any unlisted native unit — on HYPE
 * (~$83) that quietly stamped every trade under +/-$8.36 as "break-even" and
 * dropped it from W/L, winrate and the trade count. Miscounting dust as a trade is
 * far cheaper than erasing a real trade, so unknown units are let through to
 * scoring.
 */
const FLAT_EPS_UNKNOWN = 1e-9;

/** Winrate = wins / (wins + losses). Break-even stays out of the denominator. */
export const winrateOf = (b: { wins: number; losses: number }): number =>
  b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses)) * 100 : 0;

/**
 * Profit factor = gross win / gross loss. Below 1 means a LOSS however high the
 * winrate is — the one number that cannot flatter you the way winrate can.
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
   * POSITIONS that could be scored — one 8-leg ladder counts ONCE. This is the
   * right denominator for scoring: `positions === known + flats`.
   */
  positions: number;
  legs: number; // entri yang masuk penilaian (sebelum digabung jadi posisi)
  known: number; // POSISI berkeputusan (menang/kalah); impas tak dihitung
  untracked: number; // gone/burned — hasil tak diketahui
  excluded: number; // placeholder backfill lama (result 0)
  /**
   * COST never recorded (initialWethWei 0) despite a measurable result. Skipped:
   * `pnlEth = result - 0` books the ENTIRE cash-out as pure profit. In the real
   * journal that is only 3 entries, but between them they contributed $662 — 36%
   * of the reported net. A result without a cost is not a large profit, it is a
   * profit that CANNOT BE COMPUTED.
   */
  noCapital: number;
  recovered: number; // entri pemulihan sisa token (masuk net, bukan trade)
  unconverted: number; // mode USD: entri yang kursnya tak terbaca — DILEWATI, bukan dianggap nol
  estimated: number; // mode USD: entri lama tanpa cap kurs, dinilai dgn kurs SEKARANG
  books: Book[]; // urut: paling banyak trade dulu
};

/**
 * PnL recap for a period, SPLIT BY DENOMINATION.
 *
 * Everything used to be forced into a single "net ETH" figure, with every
 * non-weth / non-robinhood entry DISCARDED. That hid 82 of 271 entries, including
 * ALL 44 BSC trades (net -138.61 USDT) — the book losing the most money was the
 * one you could not see. Adding ETH + BNB + USDT together is plainly wrong, so
 * the answer was not to discard but to separate: one row per denomination.
 *
 * Still excluded: resultEthWei undefined (gone/burned, result unknown) and == 0
 * (a backfill placeholder from older trades; a real cash-out is always > 0).
 */
export function statsFor(sinceMs = 0, chain?: string, usdOf?: (unit: string) => number | null): PeriodStats {
  const me = currentWallet();
  // Fails CLOSED, same as readMine. With no owner address the filter below used to
  // be skipped silently and the whole journal counted — 269 entries from the old
  // wallet showing up as your PnL, at the exact moment we least know who owns them.
  // /history came back empty while /pnl ballooned.
  if (!me)
    return { count: 0, positions: 0, legs: 0, known: 0, untracked: 0, excluded: 0, noCapital: 0, recovered: 0, unconverted: 0, estimated: 0, books: [] };
  const all = read(Number.MAX_SAFE_INTEGER).filter(
    (e) =>
      (e.closedAt ?? 0) >= sinceMs &&
      (!chain || (e.chain ?? 'robinhood') === chain) &&
      // Only trades from the wallet IN USE. An entry without an owner stamp is
      // treated as someone else's; mixing them makes PnL lie after a wallet swap.
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
  // Step 1 — value each entry. NET is summed here, per entry: the money does not
  // care how things are grouped, and summing it again through groups would only
  // add another way to get it wrong.
  type Skor = { e: JournalEntry; unit: string; nilai: number };
  const skor: Skor[] = [];
  for (const e of all) {
    if (e.resultEthWei === undefined) { untracked++; continue; }
    if (BigInt(e.resultEthWei) === 0n) { excluded++; continue; }
    // A result exists but no cost was ever recorded, so PnL cannot be computed —
    // it is not "a profit the size of the proceeds". A 'recovery' legitimately has
    // zero cost: that was already booked on its original close entry, and this is
    // just the remainder catching up.
    if (e.reason !== 'recovery' && BigInt(e.initialWethWei || '0') === 0n) { noCapital++; continue; }
    const native = unitOf(e.chain, e.baseKind);
    // The rate AT CLOSE when stamped; today's rate only as a fallback for older
    // entries written before stamping existed. Anything using the fallback is
    // counted, because its value drifts with the market and must not be quietly
    // equated with an entry whose figure is already locked.
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
    // 'recovery' is leftover tokens swept after the position closed. The money is
    // REAL (it belongs in net and profit), but it is not a trade of its own —
    // counting it as one would inflate the trade count and falsify the winrate.
    if (e.reason === 'recovery') {
      bookOf(unit).grossWin += nilai;
      recovered++;
      continue;
    }
    skor.push({ e, unit, nilai });
  }
  // Step 2 — score by POSITION, not by leg. An 8-leg ladder is one trade; scoring
  // it per leg splits the PnL into eighths so each piece falls under the dust
  // threshold and disappears from W/L. In a 705-entry journal, 522 of those were
  // ladder legs: per-leg scoring read 705 trades / 84.5% WR / 454 break-even, when
  // what actually happened was 230 trades / 90.5% WR / 72 break-even.
  const grup2 = groupOf(skor);
  for (const grup of grup2) {
    const unit = grup[0].unit;
    const b = bookOf(unit);
    const nilai = grup.reduce((a, g) => a + g.nilai, 0);
    // A trade that is neither a win nor a loss (under ~$0.1) counts as NEITHER; it
    // is simply break-even. `pnlEth >= 0` used to throw it into the win column and
    // inflate the winrate. Its money already went into `net` above — the only thing
    // withheld here is the SCORE.
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
  // `count` stays the ENTRY count, not the position count: that is what the caption
  // reconciles ("N closed -> M scored") against the journal's length.
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
 * Largest gap between legs of one ladder closed together. Legs are journalled in a
 * single loop, so they land milliseconds apart; 30 seconds leaves plenty of room
 * for a slow batch tx without ever merging two separate closes.
 */
const LADDER_GAP_MS = 30_000;

/**
 * Group legs into positions.
 *
 * `groupId` is used when present. OLDER entries have none — they were written
 * before the field existed — so they are grouped after the fact by (chain, ca,
 * close times close together). This is not a loose guess: on the real journal it
 * produces 230 groups, and the number does not move at all as the threshold goes
 * from 5s to 60s.
 *
 * Grouping works by CLUSTERING consecutive entries rather than rounding times into
 * buckets: rounding splits two legs 1 ms apart whenever they happen to land on
 * opposite sides of a bucket boundary.
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
 * A day boundary is midnight **WIB**, not midnight on the server.
 *
 * This machine runs on CST (UTC+8) while every card the bot sends is stamped WIB
 * (UTC+7), so `setHours(0,0,0,0)` shifts period boundaries by an hour. The day
 * index is computed from epoch + 7 hours, free of the machine's timezone.
 */
const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const wibDay = (ms: number): number => Math.floor((ms + WIB_MS) / DAY_MS);

/**
 * The "1 Month" window starts 30 WHOLE WIB days back, not a rolling `now - 30d`.
 *
 * Rolling makes the boundary drift every time the card opens, so the same trade can
 * enter and leave the recap purely because the clock moved. Whole-day boundaries
 * keep the figure stable through the day.
 */
export const monthStartMs = (days = 30): number => (wibDay(Date.now()) - (days - 1)) * DAY_MS - WIB_MS;

/**
 * Chains with history in the journal, most trades first. Used for the /pnl chain
 * picker — built from DATA rather than a hardcoded list, so a new chain (Base,
 * say) appears on its own the moment it has a first trade, and a retired one
 * ('stable') keeps its history visible.
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
 * Read the last N entries BELONGING TO THE WALLET IN USE (newest first).
 *
 * Raw `read()` does not filter by owner, and any reader that forgets to filter for
 * itself will show another wallet's history as yours. This journal already holds
 * 181 entries from the old wallet; /history and the sweep candidates both used
 * plain `read()`, so both leaked the moment the wallet changed. /pnl had filtered
 * from the start — this is what brings the rest into line.
 *
 * Entries with NO owner stamp are dropped too: better to lose one row than to show
 * someone else's row as yours.
 */
export function readMine(limit = 20): JournalEntry[] {
  const me = currentWallet();
  // Fails closed. If the wallet address cannot be read, returning EVERY entry would
  // show another wallet's history as yours at the exact moment we least know who
  // owns it. Empty is obviously wrong and visible immediately; a contaminated list
  // looks correct.
  if (!me) return [];
  const semua = read(Number.MAX_SAFE_INTEGER).filter((e) => e.wallet === me);
  return semua.slice(0, limit);
}

/** Read the last N entries (newest first). Does NOT filter by owner — see readMine. */
export function read(limit = 20): JournalEntry[] {
  try {
    if (!existsSync(FILE)) return [];
    const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
    const out: JournalEntry[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as JournalEntry);
      } catch {
        /* skip a corrupt line */
      }
    }
    return out.slice(-limit).reverse();
  } catch {
    return [];
  }
}
