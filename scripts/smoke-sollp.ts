/**
 * One runnable check on opening a Meteora DLMM position.
 *
 * Three things decide whether this path is a limit order or an accident.
 *
 * The DIRECTION: a base-side deposit belongs BELOW the active bin, so price falls into the
 * token. Point it the other way and the position opens already converted, which is a market
 * order nobody asked for. The base can be either token of the pair, so the side has to be
 * read from the pool, never assumed.
 *
 * The WIDTH: bins are geometric, (1 + binStep/10000) apart, and a position account holds
 * exactly 70 of them. A range that needs more has to be trimmed, not silently truncated by
 * the program.
 *
 * The SIDE: single-sided means the other amount is ZERO. This is the same invariant
 * scripts/smoke-basesideonly.ts protects on the EVM paths, and here it is one field.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binsForRange, MAX_BINS } from '../src/solana/lp.js';

// --- Width: geometric, rounded up, capped at what a position can hold ---
// One bin at step 100 is 1% wide, so a 10% range needs 11 of them: 1.01^11 = 1.115, and ten
// bins would only reach 1.105, stopping short of the range the owner asked for.
assert.equal(binsForRange(100, 10), 11, 'a 10% range at bin step 100 needs 11 bins');
assert.equal(binsForRange(125, 5), 5, 'a 5% range at bin step 125 needs 5 bins');
// Rounded UP, never down: a short range stops earning before the price that was asked for.
assert.ok(Math.pow(1 + 100 / 10_000, binsForRange(100, 10)) >= 1 / (1 - 0.1), 'the bins do not cover the range');
// A 90% range at bin step 100 wants 231 bins. A position holds 70, so it is trimmed here
// rather than rejected by the program with an error nobody can act on.
assert.equal(binsForRange(100, 90), MAX_BINS, 'a range wider than a position must be trimmed to fit');
assert.equal(MAX_BINS, 69, 'a 70-bin position spans 69 steps from its edge');
// Degenerate inputs must not produce a zero-bin or negative range.
for (const [step, pct] of [[0, 10], [100, 0], [100, 100], [100, -5]] as const) {
  assert.ok(binsForRange(step, pct) >= 1, `binsForRange(${step}, ${pct}) must still be at least one bin`);
}

const lp = readFileSync('src/solana/lp.ts', 'utf8');

// --- Single-sided: the other amount is zero, in the one place it can be broken ---
assert.ok(/totalXAmount: plan\.baseIsX \? amt : zero/.test(lp), 'the X amount must only be funded when the base IS token X');
assert.ok(/totalYAmount: plan\.baseIsX \? zero : amt/.test(lp), 'the Y side must be zero when the base is token X');

// --- Direction: base-side sits below the active bin ---
assert.ok(/minBinId: baseIsX \? activeBinId \+ 1 : activeBinId - bins/.test(lp), 'the range is on the wrong side of the active bin');
assert.ok(/maxBinId: baseIsX \? activeBinId \+ bins : activeBinId - 1/.test(lp), 'the range must not include the active bin on a one-sided deposit');
// The base is read from the POOL's mints, never assumed to be one side.
assert.ok(/baseOfMint\(xMint\)/.test(lp) && /baseOfMint\(yMint\)/.test(lp), 'both mints must be checked against the base list');
assert.ok(/not quoted in SOL or USDC/.test(lp), 'a pool with no base of ours must be refused');

// --- A fresh position keypair per open, so a retry cannot duplicate it ---
assert.ok(/Keypair\.generate\(\)/.test(lp), 'each position needs its own account');
assert.ok(/sendAndConfirmTransaction/.test(lp), 'the open must be confirmed, not just broadcast');

// --- The flow: range, then amount, and the amount is the confirmation ---
const idx = readFileSync('src/index.ts', 'utf8');
const open = idx.slice(idx.indexOf('async function solLpOpen'), idx.indexOf("bot.action(/^sollpa"));
assert.ok(open.indexOf('solLpFlows.delete') < open.indexOf('openPosition'), 'the flow must be cleared BEFORE the send, or a second tap opens twice');
assert.ok(/config\.safety\.dryRun/.test(open), 'DRY_RUN must be honoured on a money path');
assert.ok(/lamports > spendable/.test(open), 'the reserve must survive the deposit');
// Every entry point goes through the one opener: two amount buttons, a percentage, a typed
// amount.
assert.equal((idx.match(/solLpOpen\(/g) ?? []).length, 4, 'an LP entry point bypasses the shared opener');
assert.ok(/if \(await handleSolLpAmount\(ctx, raw\)\) return;/.test(idx), 'a typed amount never reaches the LP flow');
// The buttons the owner asked for on the result card.
assert.ok(/app\.meteora\.ag\/dlmm\/\$\{f\.pick\.pool\}/.test(open), 'the result card must link the pool on Meteora');
assert.ok(/'positions'\)/.test(open) && /positions_back/.test(open), 'the result card must offer Positions and a way back');

// --- The transaction bids for a slot, and an expiry is answered, not assumed ---
// On 22 Sep 2026 at 21:15 WIB signature 2kwdfKed… died with "block height exceeded". The
// SDK emits SetComputeUnitLimit (0x02) and NO price, so the transaction went out bidding
// zero and sat behind everything that paid. Verified after the fact: the signature was
// absent from the chain entirely, so nothing had been deposited.
assert.ok(/setComputeUnitPrice/.test(lp), 'the open must pay a priority fee, or it loses every contested slot');
// The price is multiplied by the LIMIT the SDK already set, so the limit is read back out
// of the instruction. Assuming it is how a fee cap stops capping anything.
assert.ok(/cbIx\.data\[0\] === 2/.test(lp), 'the compute unit limit must be read from the instruction, not guessed');
assert.ok(/MAX_PRIORITY_LAMPORTS = 2_000_000/.test(lp), 'the LP fee cap must match the Jupiter buy path');
assert.ok(/MIN_MICRO_LAMPORTS/.test(lp), 'a quiet market must still not bid zero');
// An expiry is the ABSENCE of an answer. Telling the owner to retry without asking the
// chain is how a second position gets opened on top of a first -- the 20 Sep BSC mistake.
assert.ok(/landedStatus/.test(lp), 'an expiry must be checked against the chain before it is reported');
assert.ok(/searchTransactionHistory: true/.test(lp), 'the status check must search history, not just the recent cache');
assert.ok(/if \(landed === 'ok'\) return/.test(lp), 'a transaction that DID land must be reported as opened');
assert.ok(/safe to try again/.test(lp), 'only an absent transaction may be described as safe to retry');
// The signature is needed to ask at all, so the transaction is signed before it is sent.
assert.ok(lp.indexOf('tx.sign(user, positionKp)') < lp.indexOf('sendRawTransaction'), 'the signature must exist before the send');

// --- The card says the details are in the log, so they have to actually be there ---
for (const [file, src, tag] of [
  ['src/solana/lp.ts', lp, '[sol-lp]'],
  ['src/index.ts', idx, '[sol-buy]'],
] as const) {
  assert.ok(src.includes(`console.error(\`${tag}`), `${file} fails silently: the error card promises a log entry that is never written`);
}

// --- Every step has a way back, and back never opens anything ---
// The range card goes back to the CA card the pool was picked from; the amount card goes
// back to the range card. A dead end here means pasting the address again.
assert.ok(/Markup\.button\.callback\('⬅️ Back', `solref:\$\{pick\.mint\}`\)/.test(idx), 'the range card must go back to the token card');
assert.ok(/Markup\.button\.callback\('⬅️ Back', 'sollpback'\)/.test(idx), 'the amount card must go back to the range card');
// Going back DROPS the chosen range. Leaving it set would let a typed amount open at a
// range the card no longer shows.
const back = idx.slice(idx.indexOf("bot.action('sollpback'"), idx.indexOf("bot.action('sollpback'") + 700);
assert.ok(/f\.rangePct = undefined/.test(back), 'Back must clear the range it is going back to choose');
assert.ok(!/openPosition|solLpOpen/.test(back), 'Back must never open a position');

// --- The result card states the range that was OPENED, not the one asked for ---
// Bins round up and a range wider than 69 bins is trimmed, so the two differ: 5% at bin
// step 100 opens as 6 bins, which is 5.8%, and 90% opens as 69 bins, which is 50%.
assert.ok(/rangeOpenedPct\(r\.plan\.bins, f\.pick\.binStep\)/.test(idx), 'the card must derive its range from the plan, not the request');
assert.ok(/r\.plan\.baseIsX \? '\+' : '-'/.test(idx), 'the sign must follow the side the deposit sits on');

// --- Rent is held back, because an LP pays it and part of it never comes back ---
// Opening pays 0.0574 SOL for the position (returned on close) and 0.0714 for a bin array
// (not returned). The buy path's 0.01 reserve does not cover that, so an LP that spent it
// would fail on-chain at exactly the moment the rent is charged.
assert.ok(/SOL_LP_RESERVE_LAMPORTS = 140_000_000n/.test(idx), 'an LP must reserve rent, not only fees');
assert.ok(/solSpendable\(kp\.publicKey, SOL_LP_RESERVE_LAMPORTS\)/.test(open), 'the opener must size against the LP reserve');
assert.ok(/position rent/.test(open), 'the message that stops the deposit must say what the reserve is for');
// The buy path keeps its own, smaller reserve: a swap pays no rent.
assert.ok(/SOL_RESERVE_LAMPORTS = 10_000_000n/.test(idx), 'the swap reserve must stay as it was');

// --- Both preset sets are the owner's, and SOL amounts may have decimals ---
const presets = readFileSync('src/pctPresets.ts', 'utf8');
assert.ok(/solrange:/.test(presets) && /solsize:/.test(presets), 'the LP flow needs its own editable presets');
assert.ok(/flow === 'solsize'/.test(presets), 'a SOL amount must be allowed decimals');
const wallet = readFileSync('src/commands/wallet.ts', 'utf8');
assert.ok(/pct:solrange/.test(wallet) && /pct:solsize/.test(wallet), 'both preset sets must be editable from /settings');
// Every one of the three actions must accept them, or the card is a dead end: the Edit
// button on a card whose action does not match simply does nothing.
for (const action of ['pct', 'pctedit', 'pctreset']) {
  assert.ok(
    wallet.includes(`bot.action(/^${action}:(buy|sell|add|stop|bridge|legs|send|solrange|solsize)$/`),
    `${action} does not accept the Solana presets, so their card is a dead end`,
  );
}

console.log('smoke-sollp OK');
