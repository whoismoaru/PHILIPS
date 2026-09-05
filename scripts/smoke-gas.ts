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

assert.ok(card.includes('GAS FEE'), 'judul hilang');
for (const cc of Object.values(CHAINS)) assert.ok(card.includes(cc.label), `chain ${cc.label} tak muncul`);
assert.ok(/Rp[\d.]{3,}/.test(card), 'tak ada nominal Rupiah — kurs gagal & tak ada kabarnya');
// The footer is date, time and zone, nothing else. Anything that sneaks in there
// breaks the design.
assert.match(
  card.trim().split('\n').pop()!,
  /^<i>\d\d \w{3,5} \d{4} · \d\d:\d\d:\d\d UTC[+\-\d:]*<\/i>$/,
  'kaki kartu bukan sekadar tanggal, jam & zona',
);
assert.ok(!/\$0\.00\b/.test(card), 'ada ongkos $0.00 — RPC/harga gagal tapi kartu mengaku tahu');
for (const op of ['SWAP', 'OPEN LP', 'CLOSE LP', 'SEND &amp; APPROVE'])
  assert.ok(card.includes(`<b>${op}</b>`), `seksi ${op} hilang`);
assert.ok(/1\. \w[^\n]*= <b>\$/.test(card), 'peringkat #1 tak berharga USD');
// "$0" for a cost that really is paid is a lie, and the cheapest section is where
// it happens first.
assert.ok(!/= <b>\$0<\/b>/.test(card), 'ada ongkos yang dicetak "$0" padahal gasnya dibayar');

// The core of this design: chains ranked CHEAPEST first. A wrong order still
// looks perfectly tidy, so only a test can catch it.
const plain = card.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
for (const op of ['SWAP', 'OPEN LP', 'CLOSE LP', 'SEND & APPROVE']) {
  const blok = plain.split(op + '\n')[1].split('\n\n')[0].split('\n');
  const angka = blok.map((l) => Number((l.match(/\$([\d.]+)/) ?? [])[1])).filter((n) => isFinite(n));
  assert.ok(angka.length >= 2, `seksi ${op} kosong`);
  for (let i = 1; i < angka.length; i++)
    assert.ok(angka[i] >= angka[i - 1], `${op} tak urut termurah: ${angka.join(' , ')}`);
}

// Refresh is only useful if the card CHANGES between reads; otherwise Telegram
// rejects the edit and the button looks dead.
const kb = gasKeyboard();
assert.ok(JSON.stringify(kb).includes('gas:refresh'), 'tombol Refresh hilang');
assert.ok(/\d\d:\d\d:\d\d UTC/.test(card), 'tak ada jam baca — Refresh akan kena "not modified"');
await new Promise((r) => setTimeout(r, 1100));
assert.notEqual(await gasCard(), card, 'kartu identik antar-baca — Refresh takkan pernah tampak jalan');

console.log('\nok — kartu /gas sehat: semua chain terbaca, USD & IDR terisi, Refresh hidup');
