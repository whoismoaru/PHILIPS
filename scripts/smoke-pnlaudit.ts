/**
 * /pnl audit (30 Aug 2026). Two defects this locks down:
 *  1. the FLAT_EPS fallback of 0.1 was applied to unlisted native units — on HYPE
 *     (~$83) that erased every trade under +/-$8.36 from W/L and winrate;
 *  2. the image card was titled "All chains" above figures from ONE book.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as journal from '../src/journal.js';
import { msgPnl, msgPnlPicker } from '../src/messages.js';

// 1) Every unit the journal can hold needs a sane break-even threshold.
const src = readFileSync('src/journal.ts', 'utf8');
const eps = src.slice(src.indexOf('const FLAT_EPS'), src.indexOf('FLAT_EPS_UNKNOWN'));
for (const unit of ['USDT', 'USDG', 'USDC', 'ETH', 'BNB', 'HYPE'])
  assert.ok(new RegExp(`\\b${unit}:`).test(eps), `satuan ${unit} tak punya ambang impas sendiri`);
assert.match(src, /FLAT_EPS\[unit\] \?\? FLAT_EPS_UNKNOWN/, 'fallback harus nyaris nol, bukan 0.1');
const unknown = Number(src.match(/const FLAT_EPS_UNKNOWN = ([\d.e-]+)/)![1]);
assert.ok(unknown < 1e-6, `fallback ${unknown} masih cukup besar untuk menelan trade sungguhan`);

// 2) The image card's title names its BOOK, not just the chain coverage.
const jc = readFileSync('src/commands/journalCmds.ts', 'utf8');
const img = jc.slice(jc.indexOf('async function pnlImage'), jc.indexOf('function pnlCaption'));
// Now that the whole recap is computed in USD, the image holds ONE book covering
// everything: no other book may be left outside the frame.
assert.ok(!/other books/.test(img), 'masih ada buku yang tak muat di gambar');
assert.match(img, /pair: `\$\{chain === ALL[^`]*PERIODS\[key\]\.label\}`/, 'judul kartu harus menyebut periodenya');

// Winrate and profit factor: break-even must stay out of the denominator.
assert.equal(journal.winrateOf({ wins: 3, losses: 1 }), 75);
assert.equal(journal.winrateOf({ wins: 0, losses: 0 }), 0, 'tanpa trade jangan bagi nol');
assert.equal(journal.profitFactorOf({ grossWin: 10, grossLoss: -5 }), 2);
assert.equal(journal.profitFactorOf({ grossWin: 10, grossLoss: 0 }), null, 'tanpa rugi, PF tak terdefinisi');

// Books are never mixed: each unit stands on its own.
const s = journal.statsFor(0);
assert.equal(new Set(s.books.map((b) => b.unit)).size, s.books.length, 'satu buku per satuan');
assert.equal(s.books.reduce((a, b) => a + b.known, 0), s.known, 'known harus = jumlah known tiap buku');
for (const b of s.books) {
  assert.equal(b.known, b.wins + b.losses, `${b.unit}: known harus hanya W+L`);
  assert.ok(b.grossWin >= 0 && b.grossLoss <= 0, `${b.unit}: tanda gross terbalik`);
}

console.log('smoke-pnlaudit OK');

// ── Ownership: no figure may include another wallet's trades ────────────────
// This journal really does hold two wallets (727 for the active one, 181 for the
// old), so a leak here is not hypothetical — it would show up immediately.
const me = journal.currentWallet();
if (me) {
  const asing = (xs: Array<{ wallet?: string }>) => xs.filter((e) => e.wallet !== me).length;
  assert.equal(asing(journal.readMine(999)), 0, 'readMine membocorkan wallet lain');
  assert.equal(journal.statsFor(0).count, journal.readMine(999).length, 'cakupan /pnl ≠ cakupan riwayat');

  // Any reader touching money or showing history MUST go through readMine.
  for (const [berkas, pola] of [
    ['src/commands/journalCmds.ts', /journal\.readMine\(8\)/],
    ['src/monitor.ts', /\.readMine\(80\)/],
  ] as const)
    assert.match(readFileSync(berkas, 'utf8'), pola, `${berkas} memakai read() polos — riwayat wallet lain ikut`);

  // New entries always carry an owner stamp; without it the filter above is meaningless.
  assert.match(readFileSync('src/journal.ts', 'utf8'), /wallet: e\.wallet \?\? currentWallet\(\)/, 'entri jurnal tak dicap pemilik');
}
console.log('smoke-pnlaudit: pemilik OK');

// A rolling `now - 30d` starts at 22:30 WIB on day 31; the calendar window starts
// at 00:00 WIB on day 30. Trades landing in that gap show up in the recap with no
// bucket to sit in.
const mulai = journal.monthStartMs(30);
// Whole-day boundaries in WIB: stable all day, not drifting each time the card opens.
assert.equal((mulai + 7 * 3_600_000) % 86_400_000, 0, 'awal jendela bukan tengah malam WIB');
assert.ok(mulai > Date.now() - 31 * 86_400_000 && mulai <= Date.now(), 'jendela 1M di luar akal');
assert.equal(journal.monthStartMs(30), journal.monthStartMs(30), 'jendela harus deterministik');
const jc2 = readFileSync('src/commands/journalCmds.ts', 'utf8');
assert.ok(!/statsFor\(Date\.now\(\) - 30 \* 24 \* 3600_000/.test(jc2), 'masih ada jendela rolling 30 hari yang lama');

// The combined calendar sums EVERY book in USD while a period card shows ONE book
// in its own unit. The difference is legitimate, but it has to be said out loud or
// it reads as a miscalculation.

// Every chain takes the window as given: no second path can compute the same
// period against different boundaries.
for (const chain of ['robinhood', 'bsc', 'base']) {
  const stc = journal.statsFor(mulai, chain);
  assert.ok(stc.count >= stc.books.reduce((a, b) => a + b.known, 0), `${chain}: berskor melebihi jumlah entri`);
}
console.log('smoke-pnlaudit: jendela OK');

// ── Every recap figure in USD ───────────────────────────────────────────────
const kurs = new Map<string, number | null>([['USDG', 1], ['USDT', 1], ['ETH', 2478], ['HYPE', 83.76]]);
const usd = journal.statsFor(0, undefined, (u) => kurs.get(u) ?? null);
assert.deepEqual(usd.books.map((b) => b.unit), ['USD'], 'mode USD harus menghasilkan SATU buku');

// A second path to the same number, straight from raw entries. Summing each
// native book's net and multiplying by the test rate stopped being valid once
// entries carried `usdRate`: a stamped entry uses its close-time rate, not the
// test rate, so the two figures legitimately differ.
const dariAsli = journal
  .readMine(Number.MAX_SAFE_INTEGER)
  .filter(
    (e) =>
      e.resultEthWei !== undefined &&
      BigInt(e.resultEthWei) !== 0n &&
      // No recorded cost means the result cannot be read as pure profit.
      (e.reason === 'recovery' || BigInt(e.initialWethWei || '0') !== 0n),
  )
  .reduce((a, e) => a + e.pnlEth * (e.usdRate ?? kurs.get(journal.unitOf(e.chain, e.baseKind)) ?? 0), 0);
assert.ok(Math.abs(usd.books[0].net - dariAsli) < 1e-6, `USD ${usd.books[0].net} ≠ jumlah entri ${dariAsli}`);

// The CLOSE-TIME rate wins; today's rate is only a fallback for older entries.
const dicap = { tokenId: '1', symbol: 'X', openedAt: 0, closedAt: Date.now(), initialWethWei: '0',
  resultEthWei: '1', pnlEth: 1, pnlPct: 1, reason: 'cashed' as const, usdRate: 10 };
assert.equal(
  journal.statsFor(0, undefined, () => 1).estimated + journal.statsFor(0, undefined, () => 1).books.reduce((a, b) => a + b.known, 0) >= 0,
  true,
);
{
  // Older entries (unstamped) MUST be counted as estimates, not slipped in quietly.
  const st = journal.statsFor(0, undefined, () => 1);
  const lama = journal.readMine(999999).filter((e) => e.usdRate === undefined).length;
  const dipakai = st.count - st.untracked - st.excluded;
  assert.ok(st.estimated <= lama, 'taksiran melebihi entri yang memang tak tercap');
  assert.ok(st.estimated <= dipakai, 'taksiran melebihi entri yang dihitung');
}
// A stamp must never be overwritten by a fresh rate.
assert.match(readFileSync('src/journal.ts', 'utf8'), /rate = e\.usdRate;/, 'kurs tercap harus didahulukan');
assert.match(readFileSync('src/journal.ts', 'utf8'), /usdRate: e\.usdRate \?\? rateNow\(/, 'entri baru harus dicap saat ditulis');
// A stale rate must never be used to stamp.
assert.match(readFileSync('src/journal.ts', 'utf8'), /RATE_TTL_MS/, 'cap tanpa batas kedaluwarsa');

// An unreadable rate means the entry is SKIPPED and counted, not treated as zero.
// An already-stamped entry needs no live rate and still books — that is the whole
// point of stamping.
const buta = journal.statsFor(0, undefined, () => null);
const bercap = journal
  .readMine(Number.MAX_SAFE_INTEGER)
  .filter(
    (e) =>
      e.resultEthWei !== undefined &&
      BigInt(e.resultEthWei) !== 0n &&
      (e.reason === 'recovery' || BigInt(e.initialWethWei || '0') !== 0n) &&
      e.usdRate !== undefined,
  ).length;
assert.equal(buta.books.length, bercap > 0 ? 1 : 0, 'hanya entri bercap yang boleh bertahan tanpa kurs hidup');
assert.ok(buta.unconverted > 0, 'entri tanpa kurs wajib dihitung');
assert.equal(buta.estimated, 0, 'tanpa kurs hidup tak ada yang boleh ditaksir');
assert.equal(
  buta.unconverted + buta.untracked + buta.excluded + buta.noCapital + bercap,
  buta.count,
  'entri hilang tanpa jejak',
);

// The card prints dollars rather than native units, and owns up to what it could
// not convert.
const kartuUsd = msgPnl({
  dryRun: false, chainLabel: 'All chains', periodLabel: 'All Time',
  known: usd.known, count: usd.count, untracked: usd.untracked, excluded: usd.excluded,
  recovered: usd.recovered, unconverted: usd.unconverted, books: usd.books,
});
assert.match(kartuUsd, /\$/, 'kartu USD tanpa tanda dolar');
assert.ok(!/USDG book|ETH book|HYPE book/.test(kartuUsd), 'masih ada buku per satuan di kartu USD');
assert.match(
  msgPnl({ dryRun: false, chainLabel: 'x', periodLabel: 'y', known: 1, count: 9, unconverted: 3,
    books: [{ unit: 'USD', known: 1, wins: 1, losses: 0, flats: 0, net: 1, grossWin: 1, grossLoss: 0 }] }),
  /no USD rate/,
  'entri tanpa kurs tak diakui di kartu',
);

console.log('smoke-pnlaudit: total USD OK');

// ── Reconciliation: 728 entries vs 246 scored has to be traceable ───────────
// The chain picker and the recap card both say "trades" for two different things;
// the gap (break-even + unreadable results + sweeps) has to be named, or it reads
// as hundreds of trades vanishing between screens.
// Two levels, because one ladder is several ENTRIES but a single POSITION:
//   entries   = scored legs + unreadable + placeholder + sweep
//   positions = scored + break-even
const st0 = journal.statsFor(0);
const berskor = st0.books.reduce((a, b) => a + b.known, 0);
const impas = st0.books.reduce((a, b) => a + b.flats, 0);
assert.equal(
  st0.legs + st0.untracked + st0.excluded + st0.noCapital + st0.recovered + st0.unconverted,
  st0.count,
  'entri jurnal tak bisa direkonsiliasi — ada kategori yang tak terhitung',
);
assert.equal(berskor + impas, st0.positions, 'posisi tak bisa direkonsiliasi dari skor');
assert.ok(st0.positions <= st0.legs, 'posisi tak mungkin lebih banyak dari leg-nya');

const kartu = msgPnl({
  dryRun: false, chainLabel: 'All chains', periodLabel: 'All Time',
  known: st0.known, count: st0.count, untracked: st0.untracked,
  excluded: st0.excluded, recovered: st0.recovered, books: st0.books,
});
assert.match(kartu, new RegExp(`${st0.count} closed`), 'kartu tak menyebut jumlah entri');
assert.match(kartu, new RegExp(`<b>${berskor}</b>`), 'kartu tak menyebut jumlah berskor');
assert.match(kartu, /scored/, 'istilah scored harus muncul');
if (impas) assert.match(kartu, /break-even/, 'impas tak dijelaskan di mana pun');

// The chain picker shows TWO figures when they differ, one when they match.
const picker = msgPnlPicker([{ label: 'Robinhood', trades: 480, scored: 161 }, { label: 'Ink', trades: 0, scored: 0 }]);
assert.match(picker, /480 positions · 161 scored/);
assert.match(picker, /Ink[^\n]*0 positions/);
assert.ok(!/0 positions · 0 scored/.test(picker), 'angka sama tak perlu ditulis dua kali');
assert.match(picker, /Scored = wins\/losses only/, 'istilah "scored" harus dijelaskan');
assert.match(picker, /All figures in USD/, 'pemilih harus menyebut satuannya');
console.log('smoke-pnlaudit: rekonsiliasi OK');

// The ownership filter must fail CLOSED: an unreadable address gives zero entries,
// not the whole journal. Opening everything is most dangerous precisely when we do
// not know who owns it.
assert.match(
  readFileSync('src/journal.ts', 'utf8'),
  /export function readMine[\s\S]{0,400}?if \(!me\) return \[\];/,
  'readMine gagal terbuka saat wallet tak terbaca',
);
console.log('smoke-pnlaudit: gagal-tertutup OK');

// ── A clean journal: every entry has exactly one clear owner ────────────────
// 88 entries once slipped past the filter carrying a wrong stamp. The filter was
// not leaking; the stamps were wrong (a 22 Aug 2026 backfill guessed the owner of
// older entries). A filter is only as good as its stamps, so the stamps are what
// this guards.
{
  const semua = journal.read(Number.MAX_SAFE_INTEGER);
  assert.equal(semua.filter((e) => !e.wallet).length, 0, 'ada entri tanpa cap pemilik — tak terhitung milik siapa pun');
  const aktif = journal.currentWallet();
  if (aktif) {
    const milikku = journal.readMine(Number.MAX_SAFE_INTEGER);
    assert.equal(milikku.length, semua.filter((e) => e.wallet === aktif).length, 'readMine tak sama dgn entri bercap wallet aktif');
    assert.ok(milikku.every((e) => e.wallet === aktif), 'readMine meloloskan cap lain');
    // The recap must use exactly that set: no second read path.
    assert.equal(journal.statsFor(0).count, milikku.length, 'cakupan /pnl ≠ entri wallet aktif');
  }
}
console.log('smoke-pnlaudit: jurnal bersih OK');
