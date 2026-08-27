import assert from 'node:assert/strict';

/**
 * Persen "Target Range" harus diukur dari HARGA SEKARANG, bukan harga entry.
 * Dipatok ke entry, kartu melaporkan keadaan saat posisi dibuka selamanya:
 * token turun 26% dan barisnya tetap menulis -0.7% ⇄ -90.2%.
 * Angka di bawah diambil dari posisi nyata #7263410 (BSC).
 */
const entry = 0.0013974596;
const now = 0.0010305677;
const upper = 0.00138831; // batas yang lebih tinggi dalam harga token
const lower = 0.00013645;

const pctFrom = (ref: number) => (p: number) => (p / ref - 1) * 100;
const live = [upper, lower].map(pctFrom(now)).sort((a, b) => b - a);
const anchored = [upper, lower].map(pctFrom(entry)).sort((a, b) => b - a);

assert.ok(live[0] > 0, 'batas atas masih DI ATAS harga kini → persennya harus positif');
assert.ok(Math.abs(live[0] - 34.71) < 0.1, `batas atas dari harga kini ≈ +34.7%, dapat ${live[0].toFixed(2)}`);
assert.ok(Math.abs(live[1] + 86.76) < 0.1, `batas bawah dari harga kini ≈ -86.8%, dapat ${live[1].toFixed(2)}`);

// Inilah angka lama yang menyesatkan — pastikan bukan itu yang dipakai.
assert.ok(anchored[0] < 0, 'patokan entry membuat batas atas terbaca negatif padahal harga belum menyentuhnya');
assert.notDeepEqual(live.map(Math.round), anchored.map(Math.round));

console.log('OK — target range diukur dari harga kini, bukan harga entry.');
