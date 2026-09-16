/**
 * One runnable check on the installer's prompts.
 *
 * Pressing Enter through setup_env must produce a .env the bot can actually boot.
 * WETH_ADDRESS was the one address prompt with no default, sitting right after four
 * that had one: Enter wrote it empty, and the bot then died at startup with "an ENS
 * name used for a contract target" -- a message naming nothing the user typed.
 * Anything config.ts marks required must therefore be refused when empty, and every
 * address prompt must carry a default or a rejection.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sh = readFileSync('philips.sh', 'utf8');
const env = sh.slice(sh.indexOf('function setup_env'), sh.indexOf('function service_dir'));

// Every address the installer asks for ends up in a `new ethers.Contract(...)`, so an
// empty one is fatal. Each must have a non-empty default.
for (const key of [
  'UNISWAP_V3_FACTORY',
  'UNISWAP_V3_POSITION_MANAGER',
  'UNISWAP_V3_QUOTER',
  'UNISWAP_V3_SWAP_ROUTER',
  'WETH_ADDRESS',
]) {
  const m = env.match(new RegExp(`ask "${key}"\\s*"(0x[0-9a-fA-F]{40})"`));
  assert.ok(m, `${key} has no default address: pressing Enter writes it empty and the bot dies at boot`);
}

// The four fields config.ts refuses to start without must be refused HERE, where it is
// still one question rather than a dead service and a journal to read.
for (const key of ['TOKEN', 'UID_TG', 'RPC', 'W']) {
  assert.ok(
    new RegExp(`\\[ -n "\\$${key}" \\]`).test(env),
    `an empty ${key} is accepted by the installer, so the install completes and the bot will not start`,
  );
}

// And the shape checks that turn a typo into a message instead of an ENS error.
assert.ok(/\^0x\[0-9a-fA-F\]\{40\}\$/.test(env), 'addresses are no longer shape-checked');
assert.ok(/\^https\?:\/\//.test(env), 'the RPC URL is no longer shape-checked');

console.log('ok: every prompt either carries a working default or refuses to continue');
