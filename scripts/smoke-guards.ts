import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A withdrawal with no price floor (amount0Min/1Min = 0) can be sandwiched: the price is pushed
 * to the edge of the range, the position exits ~100% into the suppressed asset, and
 * the price is put back, with the transaction still reporting "success". That path
 * survives as a last resort (the user's money outweighs the MEV risk), but it may
 * never be silent again.
 */
const src = readFileSync(join(process.cwd(), 'src', 'uniswap.ts'), 'utf8');

assert.ok(
  /return \{ amount0Min: 0n, amount1Min: 0n, unprotected: true \}/.test(src),
  'a zero-floor path must flag itself unprotected',
);
assert.ok(
  !/return \{ amount0Min: 0n, amount1Min: 0n \}(?!,)/.test(src),
  'a zero-floor path does not flag itself, so it would go silent again',
);

// All three withdrawal paths pass the flag into the notes, and the notes reach the Telegram card.
const uses = src.split('WITHDRAW_UNPROTECTED_NOTE(').length - 1;
assert.ok(uses >= 3, `the warning note is used only ${uses}x, so one withdrawal path never passes it on`);

// --- v4 -------------------------------------------------------------------
// The same for v4: BURN_POSITION used to always go out with amount0Min/1Min = 0.
const v4 = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');

assert.ok(
  !/\[(?:id|tokenId), 0, 0, '0x'\]/.test(v4),
  'BURN_POSITION still goes out with a zero floor, leaving v4 open to sandwiching',
);
assert.ok(
  (v4.split('burnMinsV4(').length - 1) >= 3,
  'burnMinsV4 is not used on both v4 close paths, single and ladder',
);
assert.ok(
  /return \{ min0: 0n, min1: 0n, unprotected: true \}/.test(v4),
  'the v4 fallback path must flag itself unprotected',
);

// The flag has to actually reach the user, not stop at a return type.
const idx = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
assert.ok(
  (idx.split('V4_UNPROTECTED_NOTE(').length - 1) >= 2,
  'the v4 close card does not report a burn that had no price floor',
);

// --- atap ongkos gas ------------------------------------------------------
// This is checked at BROADCAST, the one point EVERY send has to pass through
// send path: contract calls, sendTxNonceSafe, and raw transactions from an aggregator.
const chains = readFileSync(join(process.cwd(), 'src', 'chains.ts'), 'utf8');
assert.ok(/broadcastTransaction[\s\S]{0,400}Gas fee ceiling hit/.test(chains),
  'the gas cost ceiling is not wired into broadcastTransaction, so some send paths slip past');

console.log('ok: the v3 and v4 price floors are reported, and the gas ceiling sits at broadcast.');
