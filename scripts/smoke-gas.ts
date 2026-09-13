import assert from 'node:assert/strict';
import { gasCard, gasKeyboard } from '../src/commands/gas.js';
import { CHAINS } from '../src/chains.js';

/**
 * /gas promises the number you will ACTUALLY pay. What is most likely to go wrong
 * quietly is not the formatting but a zero posing as an answer: the RPC fails and
 * the cost reads "$0.00", or the IDR rate is missing and the Rupiah figure just
 * disappears without a word.
 *
 * This runs the real path — live RPC, price and rate — and rejects both.
 */
const card = await gasCard();
console.log(card.replace(/<[^>]+>/g, ''));

assert.ok(card.includes('GAS FEE'), 'the header is gone');
for (const cc of Object.values(CHAINS)) assert.ok(card.includes(cc.label), `chain ${cc.label} is missing`);
assert.ok(/Rp[\d.]{3,}/.test(card), 'no Rupiah figures: the rate failed and nothing said so');
// The footer is date, time and zone, nothing else. Anything that sneaks in there
// breaks the design.
assert.match(
  card.trim().split('\n').pop()!,
  // One stamp across every card now: "12 Sep 2026, 22:51 WIB". The server's own zone
  // (UTC+08:00) used to leak onto this card alone.
  /^<i>\d{1,2} \w{3} \d{4}, \d\d:\d\d WIB<\/i>$/,
  'the footer must carry the date and WIB time, like every other card',
);
assert.ok(!/\$0\.00\b/.test(card), 'a $0.00 cost: a price or RPC failed while the card claimed to know');
for (const op of ['SWAP', 'OPEN LP', 'CLOSE LP', 'WITHDRAW &amp; APPROVE'])
  assert.ok(card.includes(`<b>${op}</b>`), `section ${op} is missing`);
// The rank is the ORDER, drawn as a tree rather than numbered.
assert.ok(/├ \w[^\n]*: <b>\$/.test(card), 'the top row carries no USD figure');
// "$0" for a cost that really is paid is a lie, and the cheapest section is where
// it happens first.
assert.ok(!/= <b>\$0<\/b>/.test(card), 'a cost printed as "$0" when the gas is really paid');

// The core of this design: chains ranked CHEAPEST first. A wrong order still
// looks perfectly tidy, so only a test can catch it.
const plain = card.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
for (const op of ['SWAP', 'OPEN LP', 'CLOSE LP', 'WITHDRAW & APPROVE']) {
  const blok = plain.split(op + '\n')[1].split('\n\n')[0].split('\n');
  // Tree glyphs, and the last row of each section closes it.
  assert.ok(blok.every((l) => /^[├└] /.test(l)), `section ${op} is not a tree block`);
  assert.ok(/^└ /.test(blok[blok.length - 1]), `section ${op} does not close with └`);
  const figures = blok.map((l) => Number((l.match(/\$([\d.]+)/) ?? [])[1])).filter((n) => isFinite(n));
  assert.ok(figures.length >= 2, `section ${op} is empty`);
  for (let i = 1; i < figures.length; i++)
    assert.ok(figures[i] >= figures[i - 1], `${op} is not ordered cheapest first: ${figures.join(' , ')}`);
}

// Refresh is only useful if the card CHANGES between reads; otherwise Telegram
// rejects the edit and the button looks dead.
const kb = gasKeyboard();
assert.ok(JSON.stringify(kb).includes('gas:refresh'), 'the Refresh button is gone');
// The stamp is minute-precision now, so an unchanged card IS possible. What must hold
// is that the tap still says something: a silently rejected edit looks like a dead button.
const refreshSrc = await import('node:fs').then((fs) => fs.readFileSync('src/commands/gas.ts', 'utf8'));
const handler = refreshSrc.slice(refreshSrc.indexOf("bot.action('gas:refresh'"));
assert.ok(/not modified/i.test(handler) && /answerCbQuery\('Gas unchanged'\)/.test(handler),
  'an unchanged refresh must still say something rather than sit silent');
assert.ok(/\d{1,2} \w{3} \d{4}, \d\d:\d\d WIB/.test(card), 'the card carries no timestamp');
await new Promise((r) => setTimeout(r, 1100));
assert.notEqual(await gasCard(), card, 'the card is identical between reads: Refresh would never look alive');

console.log('\nok: the /gas card is healthy -- every chain read, USD and IDR filled in, Refresh alive');
