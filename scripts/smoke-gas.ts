import assert from 'node:assert/strict';
import { gasCard, gasKeyboard } from '../src/commands/gas.js';
import { CHAINS } from '../src/chains.js';

/**
 * /gas menjanjikan angka yang BENAR-BENAR dibayar. Yang paling mungkin diam-diam
 * salah bukan formatnya, melainkan nol yang menyamar jadi jawaban: RPC gagal lalu
 * ongkosnya tertulis "$0.00", atau kurs IDR kosong dan Rupiahnya hilang tanpa kabar.
 *
 * Tes ini memanggil jalur aslinya (RPC + harga + kurs hidup) dan menolak dua hal itu.
 */
const card = await gasCard();
console.log(card.replace(/<[^>]+>/g, ''));

assert.ok(card.includes('GAS FEE'), 'judul hilang');
for (const cc of Object.values(CHAINS)) assert.ok(card.includes(cc.label), `chain ${cc.label} tak muncul`);
assert.ok(/Rp[\d.]{3,}/.test(card), 'tak ada nominal Rupiah — kurs gagal & tak ada kabarnya');
// Kaki kartu cuma jam & zona. Apa pun yang menyelinap ke sana melanggar desainnya.
assert.match(card.trim().split('\n').pop()!, /^<i>\d\d:\d\d:\d\d UTC[+\-\d:]*<\/i>$/, 'kaki kartu bukan sekadar jam & zona');
assert.ok(!/\$0\.00\b/.test(card), 'ada ongkos $0.00 — RPC/harga gagal tapi kartu mengaku tahu');
for (const op of ['SWAP', 'OPEN LP', 'CLOSE LP', 'SEND &amp; APPROVE'])
  assert.ok(card.includes(`<b>${op}</b>`), `seksi ${op} hilang`);
assert.ok(/1\. \w[^\n]*= <b>\$/.test(card), 'peringkat #1 tak berharga USD');
// "$0" untuk ongkos yang nyata dibayar itu bohong — seksi termurah paling rawan.
assert.ok(!/= <b>\$0<\/b>/.test(card), 'ada ongkos yang dicetak "$0" padahal gasnya dibayar');

// Inti desain ini: chain diurut dari TERMURAH. Urutan yang salah tetap terlihat
// rapi, jadi hanya tes yang bisa menangkapnya.
const plain = card.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
for (const op of ['SWAP', 'OPEN LP', 'CLOSE LP', 'SEND & APPROVE']) {
  const blok = plain.split(op + '\n')[1].split('\n\n')[0].split('\n');
  const angka = blok.map((l) => Number((l.match(/\$([\d.]+)/) ?? [])[1])).filter((n) => isFinite(n));
  assert.ok(angka.length >= 2, `seksi ${op} kosong`);
  for (let i = 1; i < angka.length; i++)
    assert.ok(angka[i] >= angka[i - 1], `${op} tak urut termurah: ${angka.join(' , ')}`);
}

// Refresh hanya berguna kalau kartunya BERUBAH tiap dibaca; kalau tidak, Telegram
// menolak edit-nya dan tombolnya terlihat mati.
const kb = gasKeyboard();
assert.ok(JSON.stringify(kb).includes('gas:refresh'), 'tombol Refresh hilang');
assert.ok(/\d\d:\d\d:\d\d UTC/.test(card), 'tak ada jam baca — Refresh akan kena "not modified"');
await new Promise((r) => setTimeout(r, 1100));
assert.notEqual(await gasCard(), card, 'kartu identik antar-baca — Refresh takkan pernah tampak jalan');

console.log('\nok — kartu /gas sehat: semua chain terbaca, USD & IDR terisi, Refresh hidup');
