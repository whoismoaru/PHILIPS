/**
 * One runnable check on the Solana buy path: the key, the signature, and the two ways this
 * particular money path can lie to you.
 *
 * The signature is the part with no second chance. A Solana transaction is signed over the
 * MESSAGE, which starts after a compact-u16 signature count and that many 64-byte slots,
 * and the fee payer's signature goes in slot 0. Get the offset wrong and the transaction is
 * simply rejected; get the message wrong and you have signed something other than what you
 * were shown. The derivation is pinned to RFC 8032 test vector 1, so a change in how the
 * seed is wrapped cannot pass unnoticed.
 *
 * The other two: a secret key must not be confused with an address (base58 hides the
 * difference), and a transaction that lands and FAILS is not a completed buy -- the same
 * mistake that untracked a live BSC position on 20 Sep 2026.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { keypairFromSecret, publicKeyOf, signMessage } from '../src/solana/keys.js';
import { signTransaction, routeLabel, WSOL, LAMPORTS } from '../src/solana/jupiter.js';
import { encodeBase58 } from '../src/solana/addr.js';

// --- Key derivation, against RFC 8032 test vector 1 ---
const seed = Uint8Array.from(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
const pub = publicKeyOf(seed);
assert.equal(
  Buffer.from(rawOf(pub)).toString('hex'),
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'the ed25519 derivation does not match RFC 8032: the PKCS8 wrapping is wrong',
);

/** base58 -> 32 raw bytes, for the assertions here only. */
function rawOf(b58: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of b58) n = n * 58n + BigInt(A.indexOf(c));
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
}

// --- A secret key is 64 bytes, and never an address ---
const secret64 = encodeBase58(Uint8Array.from([...seed, ...rawOf(pub)]));
const kp = keypairFromSecret(secret64);
assert.equal(kp.publicKey, pub, 'the keypair does not derive its own address');
// An address is 32 base58-encoded bytes. Accepting that shape as a key would mean a pasted
// contract address gets deleted from the chat and answered with "import failed".
assert.throws(() => keypairFromSecret(pub), /64 bytes/, 'a bare address must never be taken for a secret key');
// A paste that lost characters: the carried public key no longer matches the seed.
const damaged = encodeBase58(Uint8Array.from([...seed, ...rawOf(pub).map((b, i) => (i === 0 ? b ^ 1 : b))]));
assert.throws(() => keypairFromSecret(damaged), /do not agree/, 'a damaged key must be refused, not used');
// The input must never appear in an error: these messages are shown in the chat.
for (const bad of ['not-base58!!', pub, damaged]) {
  try {
    keypairFromSecret(bad);
  } catch (e) {
    assert.ok(!(e as Error).message.includes(bad), 'the error message leaks the pasted secret');
  }
}

// --- The signature goes in slot 0, over the message and nothing else ---
// A synthetic transaction: one signature slot, then a message this test owns.
const message = Buffer.from('a solana message, whatever it happens to contain', 'utf8');
const unsigned = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
const signed = Buffer.from(signTransaction(unsigned.toString('base64'), kp), 'base64');
assert.equal(signed.length, unsigned.length, 'signing must not change the transaction length');
assert.ok(signed.subarray(65).equals(message), 'the message was modified while signing');
const key = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(rawOf(pub))]),
  format: 'der',
  type: 'spki',
});
assert.ok(verify(null, message, key, signed.subarray(1, 65)), 'slot 0 does not hold a valid signature over the message');
// Signing the WHOLE transaction instead of the message is the classic version of this bug.
assert.ok(!verify(null, unsigned, key, signed.subarray(1, 65)), 'the signature covers the wrong bytes');
assert.equal(signMessage(message, seed).length, 64, 'an ed25519 signature is 64 bytes');

// --- Jupiter, and only Jupiter, on this path ---
const jup = readFileSync('src/solana/jupiter.ts', 'utf8');
assert.ok(!/lifi|relay/i.test(jup), 'the Solana swap must not route through the EVM aggregators');
assert.equal(WSOL, 'So11111111111111111111111111111111111111112', 'wrapped SOL mint changed');
assert.equal(LAMPORTS, 1e9, 'SOL has 9 decimals');
assert.equal(routeLabel({ routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }] } as any), 'Meteora DLMM');
assert.equal(routeLabel({} as any), 'Jupiter', 'a route with no venues still needs a name');

// --- A transaction that lands and FAILS is not a completed buy ---
assert.ok(/if \(s\.err\) throw/.test(jup), 'an on-chain error must stop the flow, not be reported as success');
assert.ok(/confirmationStatus === 'confirmed'/.test(jup), 'the swap is only done once the network confirms it');
assert.ok(/not confirmed within/.test(jup), 'a timeout must be said out loud, never treated as success');

// --- The flow: one tap, one buy ---
const idx = readFileSync('src/index.ts', 'utf8');
const go = idx.slice(idx.indexOf("bot.action('solgo'"), idx.indexOf("bot.action('solgo'") + 1200);
assert.ok(go.indexOf('solBuyFlows.delete') < go.indexOf('executeSwap'), 'the flow must be cleared BEFORE the send, or a double tap buys twice');
assert.ok(/config\.safety\.dryRun/.test(go), 'DRY_RUN must be honoured on a money path');
// Lamports are integers. Percent arithmetic in floats rounds a 9-decimal amount and asks
// for SOL the wallet does not have.
assert.ok(/\(spendable \* BigInt\(pct\)\) \/ 100n/.test(idx), 'the spend must be computed in bigint lamports');
assert.ok(/SOL_RESERVE_LAMPORTS/.test(idx), 'a reserve must be kept back for fees and rent');

// --- The two keystores never meet ---
const solStore = readFileSync('src/solana/walletStore.ts', 'utf8');
assert.ok(/keystore-sol\.json/.test(solStore), 'the Solana key needs its own file');
assert.ok(!/from '\.\.\/walletStore\.js'/.test(solStore), 'the Solana store must not reach into the EVM one');
assert.ok(!/console\.log\([^)]*seed/.test(solStore), 'the seed must never be logged');

console.log('smoke-soljup OK');
