/**
 * Satu kartu close untuk SEMUA jalur (v3/v4, tunggal/ladder, lima chain).
 * Dua kebohongan yang pernah tercetak di kartu ini:
 *  - "unwrapped back into native ETH" pada close yang hasilnya USDT;
 *  - "Received … ETH" pada close di BSC (yang diterima BNB).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { msgCashOut } from '../src/messages.js';

const dasar = {
  tokenId: '7286107',
  notes: ['Close position #7286107 (tx 0xaa11)', 'Swap 1: token → USDT via uniswap-usdg(slip 15%)'],
  txHashes: ['0xbb22'],
};

// Stablecoin: tak pernah di-unwrap, dan bukan ETH.
const stable = msgCashOut({ ...dasar, ethOut: '244.73 USDT', baseSymbol: 'USDT', native: false });
assert.ok(!/native ETH/.test(stable), 'close stablecoin tak boleh mengaku unwrap ke native ETH');
assert.match(stable, /swapped into <b>USDT<\/b>/);
assert.match(stable, /POSITION CLOSED/);

// Native non-ETH: satuannya ikut chain.
const bnb = msgCashOut({ ...dasar, ethOut: '0.91 BNB', baseSymbol: 'BNB', native: true });
assert.match(bnb, /native BNB/, 'chain non-ETH harus menyebut native-nya sendiri');
assert.ok(!/native ETH/.test(bnb));

// Ladder: identitasnya harus terbaca, isi kartunya sama. Judulnya kini seragam
// (POSITION CLOSED) dan penandanya pindah ke baris identitas di bawahnya.
const ladder = msgCashOut({ ...dasar, ethOut: '0.91 BNB', baseSymbol: 'BNB', native: true, legs: 8 });
assert.match(ladder, /ladder, 8 legs/);
assert.match(ladder, /8 legs/);
assert.ok(!/ladder/i.test(stable), 'close tunggal tak boleh disebut ladder');
assert.ok(!/legs/.test(msgCashOut({ ...dasar, ethOut: '1 ETH', legs: 1 })), 'legs=1 bukan ladder');

// Langkah & hash: hash di dalam notes dipisah ke barisnya sendiri, hash lain
// tak boleh tercecer.
assert.match(stable, /<code>0xaa11<\/code>/, 'hash dalam notes harus dipisah ke baris sendiri');
assert.match(stable, /<code>0xbb22<\/code>/, 'hash tambahan harus tercetak');
assert.ok(!stable.includes('(tx 0xaa11)'), 'hash tak boleh tertinggal di tengah kalimat');
// Steps are numbered now, and the received amount is the last of them rather than a
// separate line above.
assert.match(stable, /^1\. /m, 'langkah harus bernomor');
assert.match(stable, /\d+\. Received /, '"Received" harus jadi langkah terakhir');
assert.match(stable, /Step by step :/);

// Debu tersisa harus dikatakan, bukan didiamkan.
assert.match(msgCashOut({ ...dasar, ethOut: '1 ETH', leftover: true }), /dust/i);
assert.ok(!/dust/i.test(stable));

// Keempat jalur close memakai kartu yang sama.
const idx = readFileSync('src/index.ts', 'utf8');
assert.equal((idx.match(/msg\.msgCashOut\(/g) ?? []).length, 4, 'keempat jalur close harus memakai msgCashOut');
assert.ok(!/LADDER CLOSED/.test(idx), 'kartu ladder ad-hoc lama harus sudah hilang');

console.log('smoke-closecard OK');
