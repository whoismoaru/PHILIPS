import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';

/**
 * Robinhood dulu satu-satunya chain tanpa RPC cadangan, dan itu chain utama bot.
 * 3-4 Sep 2026 Alchemy melempar 59x 403 lalu 503, dan head-nya sempat tertinggal
 * ~2000 blok — sweep, sync, dan probe retry ikut jatuh tanpa ada yang menadah.
 *
 * Tes: providernya benar FallbackProvider (bukan JsonRpcProvider tunggal) dan
 * masih bisa membaca chain. CATATAN: FallbackProvider berpindah saat cadangan
 * diperlukan karena ERROR/STALL — bukan karena utama basi tapi tetap menjawab.
 */
const rh = CHAINS.robinhood;
assert.ok(rh, 'chain robinhood hilang');
assert.ok(rh.provider instanceof ethers.FallbackProvider, 'robinhood tak punya RPC cadangan');

const blok = await rh.provider.getBlockNumber();
assert.ok(blok > 0, `blok tak masuk akal: ${blok}`);
console.log(`ok — robinhood FallbackProvider hidup, blok ${blok}`);
