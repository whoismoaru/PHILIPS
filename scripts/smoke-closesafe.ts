import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Failing to READ a position is not proof the position is gone.
 *
 * 28 Aug 2026: the BSC RPC dropped while closing an 8-leg ladder. `positions()`
 * failed for every leg, `catch {}` swallowed all of it, the multicall list came out empty,
 * dan alurnya tetap melapor "LADDER CLOSED · Total cashed out 0 USDT". Tak satu
 * and the transaction went out anyway: 214 USDT stayed alive on chain while the bot
 * erased it from its own records. The two guards below keep that from happening again.
 */
const uni = readFileSync(join(process.cwd(), 'src', 'uniswap.ts'), 'utf8');
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

// 1. Only an 'Invalid token ID' revert may be skipped; everything else has to throw.
const loop = uni.slice(uni.indexOf('export async function executeRemoveBatch'), uni.indexOf('export type PositionInfo'));
assert.ok(/if \(isGoneErr\(e\)\) return null;/.test(loop), 'a leg that failed to read is still skipped in silence');
assert.ok(/throw new Error\(\s*`Could not read position/.test(loop), 'a failed read does not throw');
assert.ok(!/\} catch \{\s*(continue|return null);/.test(loop), 'an empty catch still swallows every error');

// A price floor missed because the price moved: REBUILD at the new price. Never give
// up, and never loosen the floor.
assert.ok(/price slippage check/i.test(loop), 'a price-floor revert is not recognised');
assert.ok(/built = await build\(\);/.test(loop), 'nothing is rebuilt when the price moves');
assert.ok(/Price moved faster than the withdrawal floor/.test(loop), 'the failure message does not explain the cause');

// 2. With no withdrawal transaction, nothing may be finalised as closed.
assert.ok(
  /No withdrawal transaction was sent/.test(idx),
  'the ladder path can still report success without sending a transaction',
);

console.log('ok: a failed read aborts the close instead of posing as a success.');
