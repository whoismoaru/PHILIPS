import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * v3 and v4, on every chain, must behave the same.
 *
 * The bot grew v4 support later, so every card and every button has two implementations
 * that drift apart one edit at a time. These asserts pin the places where they must not.
 */
const idx = readFileSync('src/index.ts', 'utf8');
const m = readFileSync('src/messages.ts', 'utf8');
const fees = readFileSync('src/commands/feesAndRemove.ts', 'utf8');

// --- both position cards use the same header, tree fields and footer shape ---
for (const [name, fn] of [
  ['v3', m.slice(m.indexOf('export function msgPositionCard'), m.indexOf('export function msgPositionDetail'))],
  ['v4', m.slice(m.indexOf('export function msgV4Position'), m.indexOf('export function msgV4Position') + 6000)],
] as Array<[string, string]>) {
  assert.ok(/posPair\(/.test(fn), `${name}: judul kartu harus memakai posPair`);
  for (const field of ['Fee:', 'TVL:', 'Fills:', 'Volume:', 'Liquidity:', 'Range:'])
    assert.ok(fn.includes(field), `${name}: baris "${field}" hilang dari kartu posisi`);
  assert.ok(/fields\.map\(\(f, i\) =>/.test(fn), `${name}: kartu harus dirender sbg blok pohon`);
}

// --- unclaimed fees see both protocols, across every chain ---
assert.ok(/listPositionsV4/.test(fees) && /store\.active\(\)/.test(fees), '/claim_fees harus membaca v3 dan v4');
assert.ok(/Object\.values\(CHAINS\)/.test(fees), '/claim_fees v4 harus dipindai di semua chain');

// --- the positions list carries the chain of the position, not the active one ---
assert.ok(/chain: rcc\.label/.test(idx), 'baris v3 harus memakai chain posisinya sendiri');
assert.ok(/chain: pcc\.label/.test(idx), 'baris v4 harus memakai chain posisinya sendiri');

// --- the deposit flow is protocol-agnostic: one executor, both paths inside it ---
assert.equal((idx.match(/async function execAdd\(/g) ?? []).length, 1, 'execAdd harus tunggal');
const exec = idx.slice(idx.indexOf('async function execAdd('), idx.indexOf('async function execAdd(') + 4000);
assert.ok(/protocol === 'v4'/.test(exec), 'execAdd harus menangani v4');
assert.ok(/renderPlanStepV4/.test(idx), 'rencana v4 harus punya jalurnya sendiri');

// --- Close All runs the SAME executor as a single close, for both protocols ---
// Closing twenty positions must record them exactly as closing one does: journal entry,
// PnL card, sweeps. A separate loop that "just closes" would silently skip all of that.
assert.equal((idx.match(/async function execCloseV3\(/g) ?? []).length, 1, 'execCloseV3 harus tunggal');
assert.equal((idx.match(/async function execCloseV4\(/g) ?? []).length, 1, 'execCloseV4 harus tunggal');
const all = idx.slice(idx.indexOf("bot.action('closeall_confirm'"), idx.indexOf("bot.action('help'"));
assert.ok(/execCloseV3\(shim\(/.test(all) && /execCloseV4\(shim\(/.test(all), 'Close All harus lewat kedua eksekutor');
assert.ok(/Object\.values\(CHAINS\)\.filter\(\(x\) => v4Supported\(x\)\)/.test(all), 'Close All harus menyapu semua chain v4');
// Sequential, not Promise.all: they share one wallet and would collide on the nonce.
assert.ok(!/Promise\.all|mapLimit/.test(all), 'Close All harus berurutan, bukan paralel');
// One failure must not stop the rest.
assert.ok(/failed\.push/.test(all), 'kegagalan satu posisi harus dicatat, bukan menghentikan sisanya');

console.log('ok: kartu, tombol, dan alur setara antara v3 & v4 di semua chain');
