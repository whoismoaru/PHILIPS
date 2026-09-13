import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderPnlCard } from '../src/card.js';

/**
 * The PnL recap card. What matters here is not the layout but the COLOUR: a flat period
 * painted green tells the owner they made money when they did not, and that is exactly
 * the bug this card was rewritten to avoid. So the headline pixel is read back.
 */
const base = {
  period: 'Today', date: '14th September 2026',
  realized: { label: '+$0.00', positive: true }, unrealized: { label: '-', positive: null },
  best: { label: '-', positive: null }, winRate: '- · 0 closes',
};
/** The average colour of the headline figure's row, read off the rendered PNG. */
async function headline(net: number, netLabel: string) {
  const png = await renderPnlCard({ ...base, net, netLabel }, 1);
  assert.ok(png.length > 10_000, 'the card came back empty');
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  // A band through the middle of the big figure, left column only.
  const d = c.getContext('2d').getImageData(90, 380, 380, 30).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] < 150) continue; // the dark ground, not the glyphs
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  assert.ok(n > 0, 'no figure was drawn where the headline should be');
  return { r: r / n, g: g / n, b: b / n };
}

const zero = await headline(0, '+$0.00');
assert.ok(Math.abs(zero.r - zero.g) < 22 && Math.abs(zero.g - zero.b) < 22, `a flat period is not neutral: ${JSON.stringify(zero)}`);

const win = await headline(436.32, '+$436.32');
assert.ok(win.g > win.r * 1.4 && win.g > win.b * 1.4, `a profit is not green: ${JSON.stringify(win)}`);

const loss = await headline(-88.1, '-$88.10');
assert.ok(loss.r > loss.g * 1.4 && loss.r > loss.b * 1.4, `a loss is not red: ${JSON.stringify(loss)}`);

console.log('ok: the PnL card colours the headline by outcome, and a flat period stays neutral');
