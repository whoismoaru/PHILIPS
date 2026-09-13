/**
 * One runnable check for how a hook-fee pool is labelled.
 *
 * $RSTR's deepest pool carries fee = 0 with a live hook: the hook charges, the
 * pool does not. Rendering that as "0.00% Fee" tells the reader trading there is
 * free, and "APR: ?" tells them the number failed to load. Both are wrong in the
 * same direction — they make the pool look better than the card can actually
 * vouch for.
 */
import assert from 'node:assert';

const src = await import('node:fs/promises').then((f) => f.readFile('src/index.ts', 'utf8'));

// The guard must require BOTH a zero fee and a real hook: a genuine 0% pool with
// no hook really is free, and must keep saying so.
assert.ok(/p\.fee === 0 && !!p\.poolKey\?\.hooks && p\.poolKey\.hooks !== ethers\.ZeroAddress/.test(src),
  'hookFee wajib menuntut fee 0 DAN hook non-zero');
assert.ok(/feeLabel: hookFee\(p\) \? 'dynamic'/.test(src), "a zero fee with a hook reads 'dynamic', never 0.00%");
assert.ok(/apr: hookFee\(p\) \? 'hook fee'/.test(src), "the APR has to name the reason rather than print '?'");
// The button carries the same fee text; leaving it at 0.00% would contradict the row.
assert.ok(/hookFee\(p\) \? 'dynamic' : msg\.feeLabel\(p\.fee\)\}\)`, `pick:/.test(src),
  'the button must carry the same label as its row');

console.log('smoke-hookfee OK');
