import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A disconnect must outlive a restart.
 *
 * It used to not: disconnect() deleted the keystore, PRIVATE_KEY stayed in .env, and
 * the next start adopted it again -- so the wallet the owner had just removed came
 * back on its own. These three asserts fail if any leg of that fix is undone.
 */
const src = readFileSync('src/walletStore.ts', 'utf8');

assert.ok(/export function disconnect\(\)[\s\S]{0,400}writeFileSync\(TOMBSTONE/.test(src),
  'disconnect() must leave a marker, or a restart adopts the .env key all over again');

assert.ok(/function adoptEnvKey\(\)[\s\S]{0,400}existsSync\(TOMBSTONE\)[\s\S]{0,400}return;/.test(src),
  'adoptEnvKey() must refuse the .env key while the disconnect marker stands');

assert.ok(/function save\([\s\S]{0,300}unlinkSync\(TOMBSTONE\)/.test(src),
  'connecting again must clear the marker, or the new wallet is refused too');

// The owner must be told the .env copy still exists; deleting the keystore does not
// remove it, and silence here reads as "the key is gone from this machine".
const m = readFileSync('src/messages.ts', 'utf8');
assert.ok(/msgDisconnected\(envKeyStillThere/.test(m) && /still in your \.env/i.test(m),
  'the disconnect card must mention the copy of the key still sitting in .env');

console.log('ok: a disconnect survives a restart, and the .env copy is not hidden');
