/**
 * One runnable check on Solana address handling.
 *
 * The hazard this guards is silent, which is why it needs a guard at all. EVM addresses
 * are hex, so the codebase lowercases them freely; Solana addresses are base58, where case
 * carries value. A lowercased Solana address does not throw and does not look wrong. It
 * simply becomes a different key, the lookup misses, and the card says the token does not
 * exist.
 *
 * Two things keep it honest: a validator strict enough to separate the two address forms
 * without a network call, and a structural rule that no normalising call ever appears
 * inside src/solana/.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { isSolAddress } from '../src/solana/addr.js';

// --- Real addresses, all read off-chain during the Meteora survey ---
const WALLET = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const POOL = '5TTHzu39BskPAz2Vdju6txDuKRPjUoPG5LNSkExV5CBt';
const MINT = '91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump';
const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111'; // 32 bytes of zero, the shortest valid form

for (const a of [WALLET, DLMM_PROGRAM, POOL, MINT, WSOL, SYSTEM]) {
  assert.ok(isSolAddress(a), `a real Solana address was rejected: ${a}`);
}

// --- EVM must never be mistaken for Solana: both arrive through the same paste handler ---
for (const a of [
  '0xc31aE677E52D8C4D3dEF6B00afFc9C3c19577777',
  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  '0x0000000000000000000000000000000000000000',
]) {
  assert.ok(!isSolAddress(a), `an EVM address was accepted as Solana: ${a}`);
}

// --- Junk, and the near-misses that a character-class regex would wave through ---
assert.ok(!isSolAddress(''), 'the empty string is not an address');
assert.ok(!isSolAddress('   '), 'whitespace is not an address');
assert.ok(!isSolAddress(null), 'null is not an address');
assert.ok(!isSolAddress(WALLET.slice(0, 20)), 'a truncated address was accepted');
// 0, O, I and l are NOT in the base58 alphabet, which is the point of the alphabet.
assert.ok(!isSolAddress(WALLET.replace(/./, '0')), 'a "0" passed the base58 alphabet');
assert.ok(!isSolAddress(WALLET.replace(/./, 'O')), 'an "O" passed the base58 alphabet');
assert.ok(!isSolAddress(WALLET.replace(/./, 'I')), 'an "I" passed the base58 alphabet');
// 45 base58 characters decode past 32 bytes: a regex on length+charset accepts this.
assert.ok(!isSolAddress('z'.repeat(44)), 'a 44-char string decoding past 32 bytes was accepted');

// --- The actual bug being guarded: lowercasing corrupts, silently ---
// For each of these real addresses the lowercased form decodes to something that is not
// 32 bytes, so it is rejected outright. That is the lucky case. The rule stands whatever
// a given string happens to decode to: a lowercased Solana address is never the same key,
// and nothing downstream is allowed to assume otherwise.
for (const a of [WALLET, MINT, POOL]) {
  const lowered = a.toLowerCase();
  assert.notEqual(lowered, a, `the fixture ${a} carries no uppercase, so it proves nothing`);
  assert.ok(!isSolAddress(lowered), `lowercasing ${a} still passed validation; the corruption would be silent`);
}

// --- Structural: src/solana/ must never normalise an address ---
if (existsSync('src/solana')) {
  for (const f of readdirSync('src/solana').filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(`src/solana/${f}`, 'utf8');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['toLowerCase(', 'toUpperCase(', 'getAddress(']) {
      assert.ok(
        !body.includes(bad),
        `src/solana/${f} calls ${bad}: a Solana address must be passed through untouched`,
      );
    }
  }
}

// --- One definition only. A second copy is how two validators drift apart. ---
const defs = readdirSync('src/solana')
  .filter((x) => x.endsWith('.ts'))
  .filter((x) => readFileSync(`src/solana/${x}`, 'utf8').includes('export function isSolAddress'));
assert.deepEqual(defs, ['addr.ts'], `isSolAddress is defined in ${defs.join(', ')}; it belongs in addr.ts alone`);

console.log('smoke-soladdr OK');
