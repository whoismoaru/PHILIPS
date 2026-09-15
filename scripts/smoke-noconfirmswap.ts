import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * /buy and /sell both execute as soon as the amount is set.
 *
 * The buy side kept a Confirm button while the sell side had none -- two behaviours for
 * the same action, which is worse than either choice on its own. Removed 16 Sep 2026.
 *
 * What must NOT be removed with it: the guards that button was standing next to.
 */
const src = readFileSync('src/index.ts', 'utf8');
const auto = src.slice(src.indexOf('// A swap executes as soon as the amount is set'), src.indexOf("bot.action('tswapok'"));

// The gate is the SHORTFALL and dry run, never which direction the swap goes.
assert.match(auto, /if \(!shortLabel && !config\.safety\.dryRun\)/, 'the auto-execute gate changed shape');
assert.ok(!/!tflow\.buy &&/.test(auto), 'the buy side is being singled out again');

// A shortfall still stops with a card and offers no way to send.
assert.match(auto, /shortLabel\s*\n?\s*\?\s*\[\[Markup\.button\.callback\('⬅️ Back'/, 'a shortfall must not offer a send button');

// The protections the Confirm button used to stand next to are still in the path.
const exec = src.slice(src.indexOf('async function execTSwap'), src.indexOf('async function execTSwap') + 3000);
assert.match(exec, /quotedOutWei/, 'the quoted floor is gone from the executor');
assert.match(src, /MAX_ETH_PER_TX|maxEthPerTx|overLimit|msgOverLimit/i, 'the per-transaction limit is gone');

// DRY RUN still shows a card instead of sending.
assert.match(auto, /!config\.safety\.dryRun/, 'dry run would now send a transaction');

console.log('ok: buy and sell both fire on the amount, with the shortfall, floor and limit still in place');
