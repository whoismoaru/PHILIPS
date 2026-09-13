import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { BG_CUSTOM, customBackground, invalidateBackground, renderPnlCard } from '../src/card.js';

/**
 * The backdrop the owner sends must actually reach the card. The failure this guards is
 * the quiet one: the image is saved, the bot says "saved", and every card still draws the
 * old backdrop because the decoded one was cached.
 */
const opts = {
  period: 'Today', opened: 0, closed: 0, net: 0, netLabel: '+$0.00', volumeLabel: '$0.00',
  winRateLabel: '-', positionsLabel: '0', bestLabel: '-', bestPositive: true, date: '14 September 2026',
};
// An existing custom backdrop belongs to the owner: move it aside, never delete it.
const saved = existsSync(BG_CUSTOM) ? readFileSync(BG_CUSTOM) : null;
if (saved) rmSync(BG_CUSTOM);
invalidateBackground();
assert.equal(customBackground(), false, 'the test started with a custom backdrop still in place');
const before = await renderPnlCard(opts, 1);

// A backdrop that is unmistakably not the shipped artwork.
const c = createCanvas(1200, 630);
const g = c.getContext('2d');
g.fillStyle = '#FFFFFF';
g.fillRect(0, 0, 1200, 630);
writeFileSync(BG_CUSTOM, c.toBuffer('image/jpeg'));
invalidateBackground();
assert.equal(customBackground(), true, 'the saved backdrop is not being seen');
const after = await renderPnlCard(opts, 1);
assert.ok(!before.equals(after), 'the card is identical after the backdrop changed: it is still drawing the cached one');

// Restoring the default has to take effect just as immediately.
rmSync(BG_CUSTOM);
invalidateBackground();
const back = await renderPnlCard(opts, 1);
assert.ok(back.equals(before), 'the default did not come back after the custom backdrop was removed');

if (saved) {
  writeFileSync(BG_CUSTOM, saved);
  invalidateBackground();
}
console.log('ok: the PnL backdrop can be swapped and restored, and the card redraws either way');
