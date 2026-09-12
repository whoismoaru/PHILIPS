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
  'disconnect() harus meninggalkan penanda, kalau tidak restart memasang ulang kunci .env');

assert.ok(/function adoptEnvKey\(\)[\s\S]{0,400}existsSync\(TOMBSTONE\)[\s\S]{0,400}return;/.test(src),
  'adoptEnvKey() harus menolak kunci .env selama penanda cabut masih ada');

assert.ok(/function save\([\s\S]{0,300}unlinkSync\(TOMBSTONE\)/.test(src),
  'connect ulang harus menghapus penanda, kalau tidak dompet baru ikut tertolak');

// The owner must be told the .env copy still exists; deleting the keystore does not
// remove it, and silence here reads as "the key is gone from this machine".
const m = readFileSync('src/messages.ts', 'utf8');
assert.ok(/msgDisconnected\(envKeyStillThere/.test(m) && /still in your \.env/i.test(m),
  'kartu disconnect harus menyebut salinan kunci yang masih ada di .env');

console.log('ok: cabut dompet bertahan setelah restart, dan salinan .env tak disembunyikan');
