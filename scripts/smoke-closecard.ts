/**
 * One close card for EVERY path: v3 and v4, single and ladder, five chains.
 * Two lies this card has printed before:
 *  - "unwrapped back into native ETH" on a close that paid out USDT;
 *  - "Received … ETH" on a BSC close, where what arrived was BNB.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { msgCashOut } from '../src/messages.js';

const base = {
  tokenId: '7286107',
  notes: ['Close position #7286107 (tx 0xaa11)', 'Swap 1: token → USDT via uniswap-usdg(slip 15%)'],
  txHashes: ['0xbb22'],
};

// A stablecoin is never unwrapped, and is never ETH.
const stable = msgCashOut({ ...base, ethOut: '244.73 USDT', baseSymbol: 'USDT', native: false });
assert.ok(!/native ETH/.test(stable), 'a stablecoin close must not claim it unwrapped into native ETH');
assert.match(stable, /swapped into <b>USDT<\/b>/);
assert.match(stable, /POSITION CLOSED/);

// A non-ETH native: the unit follows the chain.
const bnb = msgCashOut({ ...base, ethOut: '0.91 BNB', baseSymbol: 'BNB', native: true });
assert.match(bnb, /native BNB/, 'a non-ETH chain must name its own native asset');
assert.ok(!/native ETH/.test(bnb));

// A ladder has to be recognisable, while the body of the card stays the same. The header is now uniform
// (POSITION CLOSED) and its marker moved to the identity line below it.
const ladder = msgCashOut({ ...base, ethOut: '0.91 BNB', baseSymbol: 'BNB', native: true, legs: 8 });
assert.match(ladder, /ladder, 8 legs/);
assert.match(ladder, /8 legs/);
assert.ok(!/ladder/i.test(stable), 'a single close must never be called a ladder');
assert.ok(!/legs/.test(msgCashOut({ ...base, ethOut: '1 ETH', legs: 1 })), 'one leg is not a ladder');

// Steps and hashes: a hash inside the notes is split onto its own line, and other hashes
// must not be scattered around.
assert.match(stable, /<code>0xaa11<\/code>/, 'a hash in the notes belongs on its own line');
assert.match(stable, /<code>0xbb22<\/code>/, 'the extra hash must be printed');
assert.ok(!stable.includes('(tx 0xaa11)'), 'no hash may be left stranded mid-sentence');
// Steps are numbered now, and the received amount is the last of them rather than a
// separate line above.
assert.match(stable, /^1\. /m, 'the steps must be numbered');
assert.match(stable, /\d+\. Received /, '"Received" must be the final step');
assert.match(stable, /Step by step :/);

// Leftover dust is stated, never quietly dropped.
assert.match(msgCashOut({ ...base, ethOut: '1 ETH', leftover: true }), /dust/i);
assert.ok(!/dust/i.test(stable));

// All four close paths share one card.
const idx = readFileSync('src/index.ts', 'utf8');
assert.equal((idx.match(/msg\.msgCashOut\(/g) ?? []).length, 4, 'all four close paths must go through msgCashOut');
assert.ok(!/LADDER CLOSED/.test(idx), 'the old ad-hoc ladder card must be gone');

console.log('smoke-closecard OK');
