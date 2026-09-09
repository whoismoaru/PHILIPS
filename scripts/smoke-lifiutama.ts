// One runnable check on the route-preference rule: LI.FI leads unless its rate is
// genuinely worse. Pure comparison logic -- no network, no wallet.
import assert from 'node:assert';
import { lifiPreferred, LIFI_TOL } from '../src/relay.js';

const M = 1_000_000n;

// Identical rate -> LI.FI leads.
assert.equal(lifiPreferred(M, M), true, 'seri harus ke LI.FI');
// Marginally worse but inside tolerance -> still LI.FI.
assert.equal(lifiPreferred(990_000n, M), true, '1% lebih jelek masih LI.FI');
// Beyond tolerance -> back off to the alternative.
assert.equal(lifiPreferred(980_000n, M), false, '2% lebih jelek harus mundur');
// Better rate -> obviously LI.FI.
assert.equal(lifiPreferred(1_100_000n, M), true, 'lebih bagus harus LI.FI');
// No quote at all -> never chosen, whatever the alternative did.
assert.equal(lifiPreferred(0n, M), false, 'tanpa quote jangan dipilih');
assert.equal(lifiPreferred(0n, 0n), false, 'semua kosong jangan dipilih');
// No alternative quoted -> LI.FI leads unopposed.
assert.equal(lifiPreferred(M, 0n), true, 'tanpa pembanding harus LI.FI');
assert.equal(LIFI_TOL, 0.015, 'toleransi berubah tanpa sengaja');

console.log('ok: pemilihan rute LI.FI-utama benar di semua kasus');
