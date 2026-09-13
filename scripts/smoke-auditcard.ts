/**
 * The TOKEN SECURITY AUDIT card: tree shape plus the rules it may never break.
 * The expensive mistake here is not the layout but an invented answer: a
 * "Disabled ✅" for data that was never actually read makes a dangerous token
 * look clean. Missing data MUST render as '?'.
 */
import assert from 'node:assert';
import { formatScreen } from '../src/screening.js';

const gmgn = {
  buyTaxPct: 0, sellTaxPct: 0, devPct: 4.1, insidersPct: 2, sniperCount: 4, bundlerPct: 8.5,
  lpLockedPct: 0, burntPct: 100, honeypot: false, renounced: true, openSource: true,
  top10Pct: 34.2, privileges: [], tagsFromTop100: false,
};
const full: any = {
  ok: true, name: 'Baola Token', symbol: '$ASD', verified: true, isProxy: false,
  holdersCount: 1240, top1Pct: 9.1, top10Pct: 34.2, top1IsContract: false,
  liquidityUsd: 62100, volume24h: 431000, buys24h: 812, sells24h: 640,
  priceUsd: '0.000452', marketCapUsd: 452500, pairAgeHours: 1.75, dexName: 'pancakeswap',
  renounced: true, sellPath: 'ok', flags: [], verdict: 'AMAN', gmgn,
};
const CA = '0xF7F2Fb6178290EB812e9bD280920f3dC63437777';
const card = formatScreen(full, { ca: CA, chainLabel: 'BSC' });

for (const section of ['BASIC STATS :', 'CONTRACT :', 'HOLDER RISK :', 'MARKET :'])
  assert.ok(card.includes(section), `section "${section}" is missing`);
for (const row of ['Mint Authority', 'Freeze Authority', 'LP Status', 'Honeypot', 'Tax (Buy/Sell)',
  'Ownership', 'Dev Wallet', 'Sniper Bundles', 'Top 10 Holders', 'Total Holders', 'Liquidity', 'Age'])
  assert.ok(card.includes(row), `row "${row}" is missing`);

// Every tree section closes with exactly one └, and nothing follows it.
for (const block of card.split('\n\n').filter((b) => b.includes('├')))
  assert.equal(block.split('\n').filter((l) => l.startsWith('└')).length, 1, `pohon rusak:\n${block}`);

assert.match(card, /Age: 1h 45m/, 'the pool age must be hours and minutes, not rounded to the hour');
assert.match(card, /\$452\.5K/, 'a mcap in the K range carries one decimal');
assert.match(card, /\(Pancakeswap\)/, 'the liquidity venue must be named');
assert.match(card, /LP Status: 100% Burned/, 'a burn outranks a lock');
assert.match(card, /Honeypot: PASS/, 'a working sellPath means PASS');
assert.ok(card.includes(`<code>${CA}</code>`), 'the CA must be printed');

// No privileges at all really does mean Disabled.
assert.match(card, /Mint Authority: Disabled/);

// Missing data must never turn into a reassuring answer.
const blank = formatScreen(
  { ...full, gmgn: null, renounced: null, verified: null, sellPath: 'unknown', holdersCount: null, top10Pct: null, dexName: null } as any,
  { ca: CA, chainLabel: 'HyperEVM' },
);
for (const row of ['Mint Authority', 'Freeze Authority', 'LP Status', 'Honeypot', 'Ownership', 'Dev Wallet', 'Total Holders']) {
  const l = blank.split('\n').find((x) => x.includes(row))!;
  assert.ok(/\?/.test(l), `"${row}" invents an answer where the data is missing: ${l}`);
  assert.ok(!/✅|PASS|Disabled|Renounced/.test(l), `"${row}" claims safety with no data behind it: ${l}`);
}
// Null privileges (the payload never parsed) are not [] (parsed, and empty).
const unreadable = formatScreen({ ...full, gmgn: { ...gmgn, privileges: null } } as any, { chainLabel: 'BSC' });
assert.ok(/Mint Authority: \?/.test(unreadable), 'null privileges must read "?", never Disabled');

// Proxy and Verified are deliberately kept out of the script: a proxy contract can
// have their implementation swapped after this audit is printed.
assert.ok(card.includes('Proxy') && card.includes('Verified'));
assert.ok(card.length < 4096, 'the card exceeds the Telegram message limit');

console.log('smoke-auditcard OK');
