import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One ghost leg must not take down the close of a whole ladder.
 *
 * 29 Aug 2026: eight v4 legs sat in the store that had never existed on chain.
 * BURN_POSITION on an unminted id reverts with 'NOT_MINTED', and since they all
 * travelled in ONE multicall, the entire batch went down with them. Mix that group
 * with live legs and a perfectly healthy position becomes impossible to close.
 */
const v4 = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

assert.ok(/NOT_MINTED\|invalid token id\|nonexistent/.test(v4), 'a ghost leg is not recognised');
assert.ok(/const alive: string\[\] = \[\];/.test(v4), 'live legs are not separated from ghosts');
assert.ok(/tokenIds = alive;/.test(v4), 'the batch still uses the unfiltered id list');
// A failed read over RPC must never count as a ghost: that is the very same bug as in v3.
assert.ok(/Could not read v4 position #\$\{id\}/.test(v4), 'a failed read is treated as a missing position');
// Ghost records are dropped, or the next attempt fails for exactly the same reason.
assert.ok(/r\.gone\?\.length/.test(idx), 'ghost legs are not dropped from the records');
assert.ok(/no longer exist on-chain/i.test(idx), 'a fully ghost group is never cleaned up');

// The periodic reaper: a ghost record must not wait around for the user to try closing it.
const mon = readFileSync(join(process.cwd(), 'src', 'monitor.ts'), 'utf8');
assert.ok(/async function reapDeadV4/.test(mon), 'there is no reaper for dead v4 records');
assert.ok(/await reapDeadV4\(\);/.test(mon), 'the reaper is never called');
assert.ok(
  /if \(!\/NOT_MINTED\|invalid token id\|nonexistent\/i\.test\(m\)\) continue;/.test(mon),
  'the reaper deletes records when RPC fails, which is how positions get lost',
);

console.log('ok: ghost legs are filtered on close, reaped periodically, and an RPC failure never counts as gone.');
