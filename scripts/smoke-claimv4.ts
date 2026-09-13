import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * /claim_fees must see BOTH protocols.
 *
 * It read store.active() alone for months, which holds v3 records only, so a v4
 * position accrued fees the command swore were not there. Found with a live wallet
 * holding exactly that: v3 #1143853 listed, v4 #2525867 invisible.
 */
const src = readFileSync('src/commands/feesAndRemove.ts', 'utf8');

assert.ok(/listPositionsV4/.test(src), 'the fee list must scan v4 positions too');
assert.ok(/Object\.values\(CHAINS\)/.test(src), 'v4 must be scanned on every chain, not just the active one');

// The callback has to say which protocol it is: ids can collide between v3 and v4, and
// collecting through the wrong contract fails as if the position did not exist.
assert.ok(/claim:\$\{x\.v4 \? 'v4' : 'v3'\}:\$\{x\.chainKey\}:\$\{x\.id\}/.test(src),
  'the claim button must carry its protocol and chain');
assert.ok(/bot\.action\(\/\^claim:\(\\d\+\)\$\//.test(src),
  'older buttons carrying a bare id must still be handled, not fail in silence');

// A v4 collect is a decrease of ZERO: anything else would move real liquidity.
const v4 = readFileSync('src/uniswapV4.ts', 'utf8');
const i0 = v4.indexOf('export async function collectFeesV4');
const fn = v4.slice(i0, v4.indexOf('\n}\n', v4.indexOf('return {', i0)));
assert.ok(/DECREASE_LIQUIDITY/.test(fn) && !/BURN_POSITION/.test(fn), 'harvesting v4 fees must not burn the position');
assert.ok(/\[tokenId, 0n, 0n, 0n, '0x'\]/.test(fn), 'the decrease must really be zero liquidity');
assert.ok(/staticCall/.test(fn), 'a simulation is required before any transaction is sent');
assert.ok(/after > before \? after - before : 0n/.test(fn), 'the harvested amount must be measured from the balance delta');

console.log('ok: /claim_fees sees v3 and v4 on every chain, and a v4 harvest leaves liquidity untouched');
