/**
 * One runnable check on reading Meteora DLMM positions into /positions rows.
 *
 * This path was rewritten on 23 Sep 2026. It used to decode PositionV2 by hand at offsets
 * found empirically (bin ids at 7912/7916 in an 8120-byte account), which could report a
 * RANGE and nothing else: turning a bin's liquidity share into token amounts needs every
 * BinArray behind the position, so the card printed "Invested: value not read". The SDK
 * was already a dependency for opening positions and does that conversion, so it reads
 * them now, and the hand decode is gone rather than kept as a second path.
 *
 * What still has to hold:
 *
 *   - decimals are READ, never assumed. A first cross-check against DexScreener failed on
 *     three pools out of four because 6 decimals were assumed; UBI has 9, and that single
 *     assumption misprices a pool by 1000x.
 *   - the base58 owner is never case-folded, or the wallet reads as empty.
 *   - an entry the bot did not record is absent, not invented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/solana/positions.ts', 'utf8');

// --- The owner goes in verbatim: base58 is case-sensitive ---
assert.ok(!/owner[^\n]*toLowerCase/.test(src), 'the owner must never be case-folded');
assert.ok(/getAllLbPairPositionsByUser/.test(src), 'positions come from the SDK, per owner');

// --- Decimals from the chain, and prices that vanish rather than lie ---
assert.ok(/mint\.decimals/.test(src), 'decimals must come from the mint account');
assert.ok(!/tokenDecimals = 6|decT = 6/.test(src), 'decimals must never be assumed');
assert.ok(/scale === null \? null :/.test(src), 'prices must drop out when decimals are unknown');
// The upper BOUND is the top of the last bin, not its floor.
assert.ok(/upperBinId \+ 1/.test(src), 'the upper bound takes +1');
// A token side with no price is left out of the value, never counted as zero: zero would
// read as a total loss on a position that is merely unpriced.
assert.ok(/currentPrice !== null \? tokenAmount \* currentPrice : 0/.test(src), 'the token side must be valued at the current bin');

const idx = readFileSync('src/index.ts', 'utf8');
const rows = idx.slice(idx.indexOf('async function solanaRows'), idx.indexOf('// /positions — ONE consolidated message'));

// --- The row says what it knows, and marks what it does not ---
assert.ok(/entryBase === null \? ' \(now\)' : ''/.test(rows), 'a row with no entry must say its figure is the current value');
assert.ok(/age: entry \? msg\.fmtAge/.test(rows), 'age needs an opening time, which only a recorded entry has');
assert.ok(/pnlUsd: null/.test(rows), 'a SOL figure must never be put in the dollars field');
assert.ok(/wethEq: 0/.test(rows), 'Solana rows must stay out of the native total');
// A symbol beats a truncated mint, but a truncated mint beats nothing: a pool too new for
// DexScreener is still a position the owner has to find.
assert.ok(/symbols\.get\(p\.tokenMint\) \?\? `\$\{p\.tokenMint\.slice\(0, 4\)\}/.test(rows), 'the row needs a symbol with a fallback');
assert.ok(/rangeLabel:/.test(rows) && /toPrecision\(4\)/.test(rows), 'a DLMM range must be printed at precision, not fixed decimals');
// The list printed the MARKET CAP range only, and a DLMM position has no entry market cap
// to pin one to -- so those rows showed no range at all. The price range is the fallback.
const messages = readFileSync('src/messages.ts', 'utf8');
assert.ok(/r\.mcRange \|\| r\.rangeLabel/.test(messages), 'a row with no market-cap range must still show its price range');
// A 44-character position key wraps onto its own two lines and pushes the row off screen.
assert.ok(/p\.position\.slice\(0, 8\)/.test(rows), 'the position id must be shortened for the list');

// --- The entry is recorded only after the chain confirmed the open ---
const open = idx.slice(idx.indexOf('async function solLpOpen'), idx.indexOf("bot.action(/^sollpa"));
assert.ok(open.indexOf('await openPosition') < open.indexOf('solStore.record'), 'an entry must never be recorded before the position exists');
assert.ok(/console\.error\('\[sol-lp\] opened but not recorded/.test(open), 'a failed record must be logged, not swallowed');
// Entries for positions that are gone are dropped, or the file grows forever.
assert.ok(/solStore\.keepOnly/.test(rows), 'dead entries must be cleaned up');

// --- The range reads as MARKET CAP, the same way every other row does ---
// Market cap scales linearly with price, so mc(edge) = mcNow x (edge price / current
// price), and the ratio comes from the BINS -- the one price on this row that cannot drift.
assert.ok(/mcRange: mcapRangeRow\(/.test(rows), 'the Solana range must read as market cap like the rest');
assert.ok(/p\.upperPrice \/ p\.currentPrice/.test(rows) && /p\.lowerPrice \/ p\.currentPrice/.test(rows), 'the edges must be ratios against the current price');
// Dollars are only reachable through a SOL-QUOTED pair: priceUsd / priceNative is dollars
// per SOL, and read off a USDC-quoted pair it is nonsense.
assert.ok(/f\.quoteMint === WSOL_MINT/.test(rows), 'the SOL price must come from a pair actually quoted in SOL');
assert.ok(/baseSym === 'USDC' \? 1 : baseSym === 'SOL' \? solUsd : null/.test(rows), 'an unknown base must not be given a dollar price');
assert.ok(/pnlUsd: pnlBase !== null && usdPer !== null/.test(rows), 'the dollars field must hold dollars or nothing');

// --- An entry the bot did not record is RECOVERED, not invented ---
// A position opened on Meteora's own site had no entry and no age, so its row read
// "PnL: — (entry unknown)" forever. Both are in its own transaction history: the deposit is
// base arriving at the POOL account, the opening time is the oldest signature. Checked
// against AJYVacgq… on 23 Sep 2026: 1.97183098 + 0.02816901 = the 2.0 SOL deposited.
const bf = readFileSync('src/solana/backfill.ts', 'utf8');
assert.ok(/p\.mint !== baseMint \|\| p\.owner !== pool/.test(bf), 'a deposit is base arriving at the POOL, not at any account holding that mint');
assert.ok(/if \(delta > 0n\) deposited \+= delta/.test(bf), 'only deposits count toward the basis');
assert.ok(/tx\.meta\.err/.test(bf), 'a failed transaction must not count as a deposit');
assert.ok(/sigs\[sigs\.length - 1\]/.test(bf), 'the OLDEST signature is the one that opened the position');
// Bounded: each recovery costs a signature listing plus a transaction read.
assert.ok(/\.slice\(0, 3\)/.test(rows), '/positions must not turn into a crawl over every foreign position');
assert.ok(/solStore\.record/.test(rows), 'a recovered entry must be stored, not re-derived on every refresh');

// --- /positions must still ask for them ---
assert.ok(/const solRows = await solanaRows\(\)/.test(idx), '/positions must ask for Solana rows');
assert.ok(/v4\.length === 0 && solRows\.length === 0/.test(idx), 'the empty check must count Solana rows');
assert.ok(/\.concat\(solRows\)/.test(idx), 'Solana rows must join the same array');
assert.ok(/isSolAddress\(wallet\)/.test(idx), 'the configured wallet must be validated as base58');

console.log('smoke-solpositions OK');
