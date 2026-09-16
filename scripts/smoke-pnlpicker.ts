/**
 * One runnable check on the /pnl chain picker.
 *
 * The picker lists a button for every CONFIGURED chain, whether or not it has trades,
 * but the All-chains total used to be gated on `all.trades > 0`. On a fresh install the
 * result was a picker offering five chains and no way to ask for all of them -- the one
 * button most people want first.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cmdPnl } from '../src/commands/journalCmds.js';

const src = readFileSync('src/commands/journalCmds.ts', 'utf8');
assert.ok(
  !/all\.trades > 0 \?/.test(src),
  'the All-chains entry is gated on having trades again: a fresh install loses the total button',
);
assert.ok(
  /per\.length > 0 \?/.test(src),
  'All chains must be offered whenever the per-chain buttons are',
);

// And it really renders: same path /pnl takes.
let rows: string[][] = [];
await cmdPnl({
  reply: async (_t: string, extra: any) => {
    rows = extra.reply_markup.inline_keyboard.map((r: any[]) => r.map((b) => String(b.text)));
  },
});
const flat = rows.flat();
assert.ok(flat.length > 0, 'the picker rendered no buttons at all');
assert.ok(flat.includes('All chains'), `no All-chains button in the picker: ${JSON.stringify(flat)}`);
assert.ok(flat.includes('⬅️ Back to Menu'), 'the picker lost its way back to the menu');

console.log(`ok: the picker offers All chains alongside ${flat.length - 2} chain button(s)`);
