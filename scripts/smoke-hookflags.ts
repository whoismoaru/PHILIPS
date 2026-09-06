/**
 * One runnable check for the offline hook-permission decoder.
 *
 * The anchor case is REAL: $SHROOM's hook on Robinhood. Serialized (paid) found
 * a fee skim in its afterSwap while the trial was live; the decoder must reach
 * the same conclusion from the address alone, for free and forever.
 */
import assert from 'node:assert';
import { ethers } from 'ethers';
import { decodeHookFlags } from '../src/hookflags.js';

const SHROOM_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const h = decodeHookFlags(SHROOM_HOOK);
assert(h, 'hook nyata harus terbaca');
assert.equal(h.bits, 0x2044);
assert.deepEqual([...h.granted], ['afterSwapReturnDelta', 'afterSwap', 'beforeInitialize']);
// This is the corroboration: the paid audit reported HiddenFees ("skims up to
// 20% per trade"). The address says the same thing on its own.
assert(h.powers.some((p) => /cut of every swap/.test(p.label)), 'skim swap harus terdeteksi');
assert.equal(h.severe, true);

// The exit-blocking bit is the one that ends an LP position, so it must rank first.
const exit = decodeHookFlags('0x0000000000000000000000000000000000000200');
assert.equal(exit?.granted[0], 'beforeRemoveLiquidity');
assert.equal(exit?.powers[0].label, 'can block/condition your EXIT');

// Severity ordering: a hookless-but-nonzero low bit must not outrank the exit block.
const mixed = decodeHookFlags('0x0000000000000000000000000000000000000280');
assert.equal(mixed?.powers[0].severe, true, 'yang berat wajib di atas');

// No hook, and garbage input, are both "nothing to say" — never a false all-clear.
assert.equal(decodeHookFlags(ethers.ZeroAddress), null);
assert.equal(decodeHookFlags('bukan alamat'), null);
assert.equal(decodeHookFlags(null), null);

console.log('smoke-hookflags OK');
