/**
 * One runnable check on the Solana LP bases.
 *
 * The EVM side has already paid for this lesson once. Decimals were treated as a property
 * of the protocol rather than of the asset, so code written against USDG on Robinhood (6
 * decimals) was silently wrong against USDT on BSC (18). Here SOL is 9 and USDC is 6.
 * Neither is 18, and a fallback to 18 on this side would misprice every amount by a
 * factor of a thousand or a billion.
 *
 * Both mints and both decimal counts were read from the chain, not from memory.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SOL, USDC, SOL_BASES, baseOfMint } from '../src/solana/bases.js';
import { isSolAddress } from '../src/solana/addr.js';

// --- The two assets, exactly as the chain reports them ---
assert.equal(SOL.mint, 'So11111111111111111111111111111111111111112', 'the WSOL mint changed');
assert.equal(USDC.mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'the USDC mint changed');
assert.equal(SOL.decimals, 9, 'SOL is 9 decimals');
assert.equal(USDC.decimals, 6, 'USDC is 6 decimals');
assert.equal(USDC.stable, true, 'USDC is the dollar base');
assert.equal(SOL.stable, false, 'SOL is not a stablecoin and must be converted for USD figures');

// A mint that is not 32 bytes is not a mint, and would make every lookup miss.
for (const b of SOL_BASES) {
  assert.ok(isSolAddress(b.mint), `${b.symbol} carries an invalid mint: ${b.mint}`);
  assert.notEqual(b.decimals, 18, `${b.symbol} was given 18 decimals, the EVM default`);
}

// --- Scope: these two and nothing else ---
assert.equal(SOL_BASES.length, 2, 'the bases in scope are SOL and USDC only');
assert.equal(baseOfMint(SOL.mint)?.kind, 'sol');
assert.equal(baseOfMint(USDC.mint)?.kind, 'usdc');
assert.equal(baseOfMint('91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump'), undefined, 'a memecoin is not a base');

// Case folding must NOT find a base: that is the base58 hazard in its most costly form,
// because a miss here silently drops every pool quoted in that asset.
assert.equal(baseOfMint(USDC.mint.toLowerCase()), undefined, 'a lowercased mint matched a base');
assert.equal(baseOfMint(SOL.mint.toLowerCase()), undefined, 'a lowercased mint matched a base');

// --- Structural: no second decimals table, and no 18 anywhere on the Solana side ---
const files = readdirSync('src/solana').filter((f) => f.endsWith('.ts'));
const decl = files.filter((f) => /decimals:\s*\d+/.test(readFileSync(`src/solana/${f}`, 'utf8')));
assert.deepEqual(decl, ['bases.ts'], `decimals are declared in ${decl.join(', ')}; they belong in bases.ts alone`);

console.log('smoke-solbases OK');
