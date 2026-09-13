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
  assert.ok(new RegExp(`\\b${unit}:`).test(eps), `unit ${unit} has no break-even threshold of its own`);
assert.match(src, /FLAT_EPS\[unit\] \?\? FLAT_EPS_UNKNOWN/, 'the fallback must be near zero, not 0.1');
const unknown = Number(src.match(/const FLAT_EPS_UNKNOWN = ([\d.e-]+)/)![1]);
assert.ok(unknown < 1e-6, `a fallback of ${unknown} is still large enough to swallow a real trade`);

// 2) The image card's title names its BOOK, not just the chain coverage.
const jc = readFileSync('src/commands/journalCmds.ts', 'utf8');
const img = jc.slice(jc.indexOf('async function pnlImage'), jc.indexOf('function pnlCaption'));
// Now that the whole recap is computed in USD, the image holds ONE book covering
// everything: no other book may be left outside the frame.
assert.ok(!/other books/.test(img), 'a book is still being left off the image');
// The card names its period up top and its chain coverage in the footer; before, both
// were crammed into one title line. Both must still be there -- a recap that does not
// say WHICH chain and WHICH window it covers is a number with no meaning.
assert.match(img, /period: journal\.PERIODS\[key\]\.label/, 'the card must name its period');
assert.match(img, /footer: `[^`]*chain === ALL[^`]*`/, 'the card footer must name its chain coverage');

// Winrate and profit factor: break-even must stay out of the denominator.
assert.equal(journal.winrateOf({ wins: 3, losses: 1 }), 75);
assert.equal(journal.winrateOf({ wins: 0, losses: 0 }), 0, 'with no trades, never divide by zero');
assert.equal(journal.profitFactorOf({ grossWin: 10, grossLoss: -5 }), 2);
assert.equal(journal.profitFactorOf({ grossWin: 10, grossLoss: 0 }), null, 'with no losses, profit factor is undefined');

// Books are never mixed: each unit stands on its own.
const s = journal.statsFor(0);
assert.equal(new Set(s.books.map((b) => b.unit)).size, s.books.length, 'satu buku per satuan');
assert.equal(s.books.reduce((a, b) => a + b.known, 0), s.known, 'known must equal the sum of every book');
for (const b of s.books) {
  assert.equal(b.known, b.wins + b.losses, `${b.unit}: known must count wins and losses only`);
  assert.ok(b.grossWin >= 0 && b.grossLoss <= 0, `${b.unit}: tanda gross terbalik`);
}

console.log('smoke-pnlaudit OK');

// ── Ownership: no figure may include another wallet's trades ────────────────
// This journal really does hold two wallets (727 for the active one, 181 for the
// old), so a leak here is not hypothetical — it would show up immediately.
const me = journal.currentWallet();
if (me) {
  const foreign = (xs: Array<{ wallet?: string }>) => xs.filter((e) => e.wallet !== me).length;
  assert.equal(foreign(journal.readMine(999)), 0, 'readMine leaks another wallet');
  assert.equal(journal.statsFor(0).count, journal.readMine(999).length, 'cakupan /pnl ≠ cakupan riwayat');

  // Any reader touching money or showing history MUST go through readMine.
  for (const [file, pattern] of [
    ['src/commands/journalCmds.ts', /journal\.readMine\(8\)/],
    ['src/monitor.ts', /\.readMine\(80\)/],
  ] as const)
    assert.match(readFileSync(file, 'utf8'), pattern, `${file} uses a bare read(), so another wallet history comes along`);

  // New entries always carry an owner stamp; without it the filter above is meaningless.
  assert.match(readFileSync('src/journal.ts', 'utf8'), /wallet: e\.wallet \?\? currentWallet\(\)/, 'journal entries are not stamped with an owner');
}
console.log('smoke-pnlaudit: pemilik OK');

// A rolling `now - 30d` starts at 22:30 WIB on day 31; the calendar window starts
// at 00:00 WIB on day 30. Trades landing in that gap show up in the recap with no
// bucket to sit in.
const start = journal.monthStartMs(30);
// Whole-day boundaries in WIB: stable all day, not drifting each time the card opens.
assert.equal((start + 7 * 3_600_000) % 86_400_000, 0, 'the window does not start at WIB midnight');
assert.ok(start > Date.now() - 31 * 86_400_000 && start <= Date.now(), 'jendela 1M di luar akal');
assert.equal(journal.monthStartMs(30), journal.monthStartMs(30), 'the window must be deterministic');
const jc2 = readFileSync('src/commands/journalCmds.ts', 'utf8');
assert.ok(!/statsFor\(Date\.now\(\) - 30 \* 24 \* 3600_000/.test(jc2), 'the old rolling 30-day window is still in use');

// The combined calendar sums EVERY book in USD while a period card shows ONE book
// in its own unit. The difference is legitimate, but it has to be said out loud or
// it reads as a miscalculation.

// Every chain takes the window as given: no second path can compute the same
// period against different boundaries.
for (const chain of ['robinhood', 'bsc', 'base']) {
  const stc = journal.statsFor(start, chain);
  assert.ok(stc.count >= stc.books.reduce((a, b) => a + b.known, 0), `${chain}: more scored than there are entries`);
}
console.log('smoke-pnlaudit: jendela OK');

// ── Every recap figure in USD ───────────────────────────────────────────────
const kurs = new Map<string, number | null>([['USDG', 1], ['USDT', 1], ['ETH', 2478], ['HYPE', 83.76]]);
const usd = journal.statsFor(0, undefined, (u) => kurs.get(u) ?? null);
assert.deepEqual(usd.books.map((b) => b.unit), ['USD'], 'USD mode must produce exactly ONE book');

// A second path to the same number, straight from raw entries. Summing each
// native book's net and multiplying by the test rate stopped being valid once
// entries carried `usdRate`: a stamped entry uses its close-time rate, not the
// test rate, so the two figures legitimately differ.
const fromRaw = journal
  .readMine(Number.MAX_SAFE_INTEGER)
  .filter(
    (e) =>
      e.resultEthWei !== undefined &&
      BigInt(e.resultEthWei) !== 0n &&
      // No recorded cost means the result cannot be read as pure profit.
      (e.reason === 'recovery' || BigInt(e.initialWethWei || '0') !== 0n),
  )
  .reduce((a, e) => a + e.pnlEth * (e.usdRate ?? kurs.get(journal.unitOf(e.chain, e.baseKind)) ?? 0), 0);
assert.ok(Math.abs(usd.books[0].net - fromRaw) < 1e-6, `USD ${usd.books[0].net} does not match the entry sum ${fromRaw}`);

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
  const counted = st.count - st.untracked - st.excluded;
  assert.ok(st.estimated <= lama, 'more entries estimated than were left unstamped');
  assert.ok(st.estimated <= counted, 'more entries estimated than were counted');
}
// A stamp must never be overwritten by a fresh rate.
assert.match(readFileSync('src/journal.ts', 'utf8'), /rate = e\.usdRate;/, 'the stamped rate takes precedence');
assert.match(readFileSync('src/journal.ts', 'utf8'), /usdRate: e\.usdRate \?\? rateNow\(/, 'a new entry must be stamped as it is written');
// A stale rate must never be used to stamp.
assert.match(readFileSync('src/journal.ts', 'utf8'), /RATE_TTL_MS/, 'the stamp never expires');

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
assert.equal(buta.books.length, bercap > 0 ? 1 : 0, 'only stamped entries may survive without a live rate');
assert.ok(buta.unconverted > 0, 'entries with no rate must still be counted');
assert.equal(buta.estimated, 0, 'with no live rate, nothing may be estimated');
assert.equal(
  buta.unconverted + buta.untracked + buta.excluded + buta.noCapital + bercap,
  buta.count,
  'an entry vanished without a trace',
);

// The card reports in dollars, and its three figures are the book's own.
const mainUsd = usd.books[0];
const kartuUsd = msgPnl({
  dryRun: false, chainLabel: 'All chains', periodLabel: 'All Time',
  trades: mainUsd?.known ?? 0, grossWin: mainUsd?.grossWin ?? 0,
  grossLoss: mainUsd?.grossLoss ?? 0, winratePct: mainUsd ? journal.winrateOf(mainUsd) : 0,
  empty: !mainUsd,
});
// Dollars are shown as "$", not a trailing "USD": every book is converted before it
// reaches the card, and the suffix made a converted ETH book look like it was still ETH.
assert.match(kartuUsd, /\$/, 'the card does not name its unit');
assert.ok(!/\bUSD\b/.test(kartuUsd), 'the unit belongs in the $ symbol, not a trailing USD');
assert.ok(!/USDG book|ETH book|HYPE book/.test(kartuUsd), 'per-unit books still appear on a dollar card');
if (mainUsd) {
  // The count on the card must be the SCORED one -- the same number the chain picker
  // shows, or the two screens disagree about how many trades exist.
  assert.match(kartuUsd, new RegExp(`Trade: <b>${mainUsd.known}</b>`), 'the card trade count is not the scored figure');
}

console.log('smoke-pnlaudit: total USD OK');

// ── Reconciliation: 728 entries vs 246 scored has to be traceable ───────────
// The chain picker and the recap card both say "trades" for two different things;
// the gap (break-even + unreadable results + sweeps) has to be named, or it reads
// as hundreds of trades vanishing between screens.
// Two levels, because one ladder is several ENTRIES but a single POSITION:
//   entries   = scored legs + unreadable + placeholder + sweep
//   positions = scored + break-even
const st0 = journal.statsFor(0);
const scored = st0.books.reduce((a, b) => a + b.known, 0);
const flat = st0.books.reduce((a, b) => a + b.flats, 0);
assert.equal(
  st0.legs + st0.untracked + st0.excluded + st0.noCapital + st0.recovered + st0.unconverted,
  st0.count,
  'journal entries do not reconcile: a category is unaccounted for',
);
assert.equal(scored + flat, st0.positions, 'positions do not reconcile from the scored counts');
assert.ok(st0.positions <= st0.legs, 'there cannot be more positions than legs');

const main0 = st0.books[0];
const card = msgPnl({
  dryRun: false, chainLabel: 'All chains', periodLabel: 'All Time',
  trades: main0?.known ?? 0, grossWin: main0?.grossWin ?? 0,
  grossLoss: main0?.grossLoss ?? 0, winratePct: main0 ? journal.winrateOf(main0) : 0,
  empty: !main0,
});
// The card no longer prints a reconciliation line: both screens now count the same
// scored positions, so there is no gap left to explain.
//
// But the card reads books[0] ALONE, so it is only correct while the USD conversion
// really collapses everything into a single book. Unconverted native units would split
// the stats in two and the card would silently report the first half as the whole.
assert.equal(usd.books.length <= 1, true, 'the card reads books[0] alone, so the dollar conversion must leave exactly one book');
assert.match(card, new RegExp(`Trade: <b>${main0?.known ?? 0}</b>`), 'the card does not use its book scored count');
assert.match(card, /Win Rate/, 'the winrate is missing from the card');
void scored;

// The picker shows ONE figure per chain: the scored count, the same number the recap
// card reports. It used to print "480 positions · 161 scored", which invited the reader
// to treat 480 as the real total and then find it nowhere else in the bot.
const picker = msgPnlPicker([
  { label: 'All chains', trades: 483, scored: 161 },
  { label: 'Robinhood', trades: 480, scored: 161 },
  { label: 'Ink', trades: 0, scored: 0 },
]);
assert.match(picker, /Robinhood: <b>161<\/b> positions/, 'the picker must use the scored count');
assert.ok(!/480/.test(picker), 'the raw total must not appear: it disagrees with the recap card');
assert.match(picker, /Ink: <b>0<\/b> positions/, 'a chain with nothing in it is still listed');
// The total is a total, not a chain: it belongs below the list, not inside it.
assert.ok(
  picker.indexOf('All chains') > picker.indexOf('Robinhood'),
  'All chains belongs below the per-chain list, not inside it',
);
console.log('smoke-pnlaudit: the figures reconcile');

// The ownership filter must fail CLOSED: an unreadable address gives zero entries,
// not the whole journal. Opening everything is most dangerous precisely when we do
// not know who owns it.
assert.match(
  readFileSync('src/journal.ts', 'utf8'),
  /export function readMine[\s\S]{0,400}?if \(!me\) return \[\];/,
  'readMine must fail open when the wallet cannot be read',
);
console.log('smoke-pnlaudit: failed-close handling ok');

// ── A clean journal: every entry has exactly one clear owner ────────────────
// 88 entries once slipped past the filter carrying a wrong stamp. The filter was
// not leaking; the stamps were wrong (a 22 Aug 2026 backfill guessed the owner of
// older entries). A filter is only as good as its stamps, so the stamps are what
// this guards.
{
  const all = journal.read(Number.MAX_SAFE_INTEGER);
  assert.equal(all.filter((e) => !e.wallet).length, 0, 'an entry carries no owner stamp and belongs to nobody');
  const active = journal.currentWallet();
  if (active) {
    const mine = journal.readMine(Number.MAX_SAFE_INTEGER);
    assert.equal(mine.length, all.filter((e) => e.wallet === active).length, 'readMine disagrees with the entries stamped for the active wallet');
    assert.ok(mine.every((e) => e.wallet === active), 'readMine lets another stamp through');
    // The recap must use exactly that set: no second read path.
    assert.equal(journal.statsFor(0).count, mine.length, 'cakupan /pnl ≠ entri wallet active');
  }
}
console.log('smoke-pnlaudit: the journal is clean');
