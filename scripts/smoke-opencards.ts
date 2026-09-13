/**
 * Every SUCCESSFUL open sends TWO messages, on every chain and protocol:
 * (1) the "position opened" confirmation, then (2) the position's detail card.
 * The v4 paths, single and ladder, used to stop at the first one, so a fresh v4 position was not
 * immediately showing its range, strategy and in-range status.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/index.ts', 'utf8');

// Slice the body after each success confirmation: the detail card has to appear there,
// before the catch or the end of the block.
const paths: Array<[string, string, string]> = [
  ['v3 tunggal', 'msg.msgLpOpened(', 'renderPositionCard('],
  ['v3 ladder', 'msg.msgLadderOpened(opened.length', 'renderPositionCard('],
  ['v4 tunggal', 'msg.msgV4Added({', 'replyV4Card('],
  ['v4 ladder', 'msg.msgLadderOpened(r.tokenIds.length', 'replyV4Card('],
];
for (const [name, confirm, card] of paths) {
  const i = src.indexOf(confirm);
  assert.ok(i > 0, `path ${name}: the confirmation marker is gone, so this guard is stale`);
  const after = src.slice(i, i + 1200);
  const j = after.indexOf(card);
  assert.ok(j > 0, `path ${name}: success with no detail card, one message out of two`);
  assert.ok(
    j < after.indexOf('} catch') || after.indexOf('} catch') < 0,
    `path ${name}: the detail card sits outside the success path`,
  );
}

// The v4 detail card must not take down an open that ALREADY succeeded: the position is real,
// the card is presentation only.
const h = src.slice(src.indexOf('async function replyV4Card'), src.indexOf('/** Tampilan detail'));
assert.match(h, /try \{/, 'replyV4Card must swallow its own read errors');
assert.match(h, /if \(!tokenId\) return/, 'with no tokenId, a dry run for instance, do not attempt the read');

console.log('smoke-opencards OK');
