/**
 * The PORTFOLIO card. What is guarded here is the number, not the layout: this is
 * the one place the owner reads "how much do I have", so a USD value that failed to
 * read MUST render as '—'. Quietly summing the rest shows a balance smaller than the
 * wallet really holds, and that reads as money gone missing.
 */
import assert from 'node:assert';
import { msgStatus } from '../src/messages.js';

const chains: any = [
  { label: 'Robinhood', amount: '0.0091', symbol: 'ETH', usd: 22.67, stables: [] },
  { label: 'BSC', amount: '0.0004', symbol: 'BNB', usd: 0.26, stables: [{ symbol: 'USDT', amount: '122.37', usd: 122.37 }] },
  { label: 'Base', amount: '0.0005', symbol: 'ETH', usd: 1.24, stables: [] },
  { label: 'HyperEVM', amount: '0.0591', symbol: 'HYPE', usd: 4.94, stables: [] },
  { label: 'Ink', amount: '0.0000', symbol: 'ETH', usd: 0, stables: [] },
];
const card = msgStatus({ dryRun: false, positions: 1, chains, totalUsd: 151.48, lpUsd: 211.46 });

assert.match(card, /EQUITY :/);
assert.match(card, /BY CHAIN :/);
assert.match(card, /Total: <b>\$362,94<\/b>/, 'the total is free balance plus LP');
assert.match(card, /1 position\b/, 'a single position must not read "positions"');
assert.match(msgStatus({ dryRun: false, positions: 3, chains, totalUsd: 1, lpUsd: 1 }), /3 positions/);

// Short names only for the chains that have one; the rest keep their own label.
assert.match(card, /<b>RH<\/b>: \$22,67/);
assert.match(card, /<b>BASE<\/b>/);
assert.match(card, /<b>HyperEVM<\/b>/, 'an unlisted chain keeps its own label');

// A chain's value is native plus EVERY stablecoin on that chain.
assert.match(card, /<b>BSC<\/b>: \$122,63/, 'stablecoins must count towards their chain total');
// Assets are separated by '/' now, and the amounts come in already formatted.
assert.match(card, /0\.0004 BNB \/ 122\.37 USDT/, 'each asset keeps its own amount on screen');

// A chain with nothing in it takes no row.
assert.ok(!card.includes('Ink'), 'a chain with no balance need not be shown');

// Each tree closes with exactly one └.
for (const block of card.split('\n\n').filter((b) => b.includes('├')))
  assert.equal(block.split('\n').filter((l) => l.startsWith('└')).length, 1, `pohon rusak:\n${block}`);

// An unreadable USD value renders '—': never $0.00, and never a partial sum.
const blind = msgStatus({
  dryRun: false, positions: 1, totalUsd: null, lpUsd: null, lpFailed: 2,
  chains: [{ label: 'BSC', amount: '0.0004', symbol: 'BNB', usd: null, stables: [{ symbol: 'USDT', amount: '122.37', usd: 122.37 }] }] as any,
});
assert.match(blind, /Total: <b>—<\/b>/);
assert.match(blind, /Free: <b>—<\/b>/);
assert.match(blind, /<b>BSC<\/b>: —/, 'one unreadable part means the whole row reads —');
assert.ok(!/\$0\.00/.test(blind), 'nol palsu terbaca sebagai fakta');
assert.match(blind, /failed to read/, 'a position that failed to read must be admitted to');

// DRY RUN has to stand out; LIVE needs no label.
assert.match(msgStatus({ dryRun: true, positions: 0, chains: [], totalUsd: 0 }), /DRY RUN/);
assert.ok(!/LIVE/.test(card));

console.log('smoke-portfolio OK');
