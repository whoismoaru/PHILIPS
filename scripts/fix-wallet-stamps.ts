/**
 * Re-stamp journal entries that carry the wrong owner.
 *
 * The `wallet` field was only added on 22 Aug 2026 through a backfill (see
 * `journal.jsonl.bak-prewallet-*`), and that backfill GUESSED: old entries were
 * stamped with whichever wallet happened to be active during the migration, not
 * the wallet that actually made the trade. The result is /pnl counting an old
 * wallet's trades as the current one's.
 *
 * The cut-off comes from the CHAIN rather than a guess: the active wallet's FIRST
 * transaction on that chain. An entry closed before the wallet ever touched the
 * chain cannot possibly be its own. A chain without an explorer borrows the
 * earliest verified cut-off from the others, and the report says so out loud
 * rather than hiding it.
 *
 *   npx tsx scripts/fix-wallet-stamps.ts          # report only, writes nothing
 *   npx tsx scripts/fix-wallet-stamps.ts --write  # back up, then write
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, getChain } from '../src/chains.js';
import { EXPLORER_HEADERS } from '../src/chain.js';
import * as journal from '../src/journal.js';

const WRITE = process.argv.includes('--write');
const FILE = join(process.cwd(), 'data', 'journal.jsonl');
const ME = journal.currentWallet();
if (!ME) throw new Error('no wallet connected: nothing to re-stamp against.');

const wib = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

/** This address's first transaction on a chain, or null when it cannot be checked. */
async function firstTx(chainKey: string, addr: string): Promise<number | null> {
  const cc = getChain(chainKey);
  if (!cc?.blockscout) return null;
  let url = `${cc.blockscout}/addresses/${addr}/transactions`;
  let last: { timestamp: string } | null = null;
  for (let i = 0; i < 300; i++) {
    const r: any = await fetch(url, { headers: EXPLORER_HEADERS }).then((x) => x.json()).catch(() => null);
    if (!r) return null;
    if (r.items?.length) last = r.items[r.items.length - 1];
    if (!r.next_page_params) break; // the end of the list: this really is the oldest
    const q = new URLSearchParams(Object.entries(r.next_page_params).map(([k, v]) => [k, String(v)]));
    url = `${cc.blockscout}/addresses/${addr}/transactions?${q}`;
  }
  return last ? new Date(last.timestamp).getTime() : null;
}

const cutoff = new Map<string, number>();
for (const key of Object.keys(CHAINS)) {
  const t = await firstTx(key, ME);
  if (t !== null) {
    cutoff.set(key, t);
    console.log(`${key.padEnd(10)} first tx for this wallet: ${wib(t)} WIB  (verified on-chain)`);
  } else {
    console.log(`${key.padEnd(10)} no explorer: using the earliest verified cut-off`);
  }
}
const fallback = cutoff.size ? Math.min(...cutoff.values()) : null;
if (fallback === null) throw new Error('not one chain could be verified: stopping rather than guessing.');

// The replacement owner is whichever other wallet appears most in the journal.
const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
const entries = lines.map((l) => JSON.parse(l) as journal.JournalEntry & Record<string, unknown>);
const counts = new Map<string, number>();
for (const e of entries) if (e.wallet && e.wallet !== ME) counts.set(e.wallet, (counts.get(e.wallet) ?? 0) + 1);
const previous = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
if (!previous) throw new Error('no other wallet in the journal: there is nothing to re-stamp.');

let changed = 0;
const perChain = new Map<string, number>();
for (const e of entries) {
  if (e.wallet !== ME) continue;
  const chain = e.chain ?? 'robinhood';
  const b = cutoff.get(chain) ?? fallback;
  if (e.closedAt >= b) continue;
  e.wallet = previous;
  changed++;
  perChain.set(chain, (perChain.get(chain) ?? 0) + 1);
}

console.log(`\nactive wallet   : ${ME}`);
console.log(`re-stamped to   : ${previous}`);
for (const [k, n] of perChain)
  console.log(`  ${k.padEnd(10)} ${n} entries${cutoff.has(k) ? '' : '  (borrowed cut-off, unverified)'}`);
console.log(`total           : ${changed} of ${entries.length} entries`);

if (!WRITE) {
  console.log('\n(report only: run with --write to apply)');
} else if (changed > 0) {
  const bak = `${FILE}.bak-wallet-${Date.now()}`;
  copyFileSync(FILE, bak);
  writeFileSync(FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`\nbackup : ${bak}\nwritten: ${FILE}`);
} else {
  console.log('\nnothing to change.');
}
