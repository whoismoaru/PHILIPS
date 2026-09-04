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

assert.ok(card.includes('GAS NOW'), 'judul hilang');
for (const cc of Object.values(CHAINS)) assert.ok(card.includes(cc.label), `chain ${cc.label} tak muncul`);
assert.ok(/Rp[\d.]{3,}/.test(card), 'tak ada nominal Rupiah — kurs gagal & tak ada kabarnya');
assert.ok(!/\$0\.00\b/.test(card), 'ada ongkos $0.00 — RPC/harga gagal tapi kartu mengaku tahu');
assert.ok(/Swap · <b>\$/.test(card), 'baris Swap tak berharga USD');

// Refresh hanya berguna kalau kartunya BERUBAH tiap dibaca; kalau tidak, Telegram
// menolak edit-nya dan tombolnya terlihat mati.
const kb = gasKeyboard();
assert.ok(JSON.stringify(kb).includes('gas:refresh'), 'tombol Refresh hilang');
assert.ok(/Read \d\d:\d\d:\d\d/.test(card), 'tak ada jam baca — Refresh akan kena "not modified"');
await new Promise((r) => setTimeout(r, 1100));
assert.notEqual(await gasCard(), card, 'kartu identik antar-baca — Refresh takkan pernah tampak jalan');

console.log('\nok — kartu /gas sehat: semua chain terbaca, USD & IDR terisi, Refresh hidup');
