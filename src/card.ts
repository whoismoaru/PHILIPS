import { createCanvas, loadImage, GlobalFonts, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Renders the "key moment" PNG card, the profit card at close. It is pure presentation,
 * called AFTER the on-chain work is done; a failed render must never disturb
 * alur (pemanggil membungkus try/catch). Font: DejaVu (offline, di sistem).
 */

const DEJAVU = '/usr/share/fonts/truetype/dejavu';
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const reg = (path: string, alias: string) => {
    try {
      GlobalFonts.registerFromPath(path, alias);
    } catch {
      /* fall back to the canvas default when the font is missing */
    }
  };
  // Liberation Sans for the text: DejaVu sets about 22% wider at the same height, which
  // pushed the big figures off their intended width. The mono face stays DejaVu -- the
  // Liberation mono is Courier-metric and reads much lighter next to these.
  reg('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', 'PhSans');
  reg('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', 'PhSansB');
  reg(`${DEJAVU}/DejaVuSansMono.ttf`, 'PhMono');
  fontsReady = true;
}

/**
 * The card's backdrop, an image in data/. Decoded ONCE and cached: closes can come
 * back-to-back and decoding the JPEG each time is wasted work. A missing or corrupt file
 * returns null and the card falls back to a gradient -- a close must never fail over
 * decoration.
 */
const BG_FILE = join(process.cwd(), 'data', 'PHILIPS ANIME.jpg');
/** The owner's own backdrop, sent to the bot as a photo. It WINS over the shipped one. */
export const BG_CUSTOM = join(process.cwd(), 'data', 'pnl-bg.jpg');

export function customBackground(): boolean {
  return existsSync(BG_CUSTOM);
}

/** Drop the decoded image so the next card picks up a backdrop that has just changed. */
export function invalidateBackground(): void {
  bgImg = undefined;
  bgFrom = '';
}

let bgImg: Image | null | undefined;
let bgFrom = ''; // which file the cached image came from
async function background(): Promise<Image | null> {
  const file = customBackground() ? BG_CUSTOM : BG_FILE;
  // The cache is keyed on the FILE, not just on "already loaded": swapping the backdrop
  // and still drawing the old one is the one bug this feature can have.
  if (bgImg !== undefined && bgFrom === file) return bgImg;
  try {
    bgImg = await loadImage(file);
    bgFrom = file;
  } catch (e) {
    bgImg = null;
    bgFrom = file;
    console.error(`[card] the background could not be read (${file}), falling back to a gradient:`, (e as Error).message);
  }
  return bgImg;
}

const W = 1200;
const H = 630;
const PAD = 72;
const COL = {
  bg0: '#0B0E14',
  bg1: '#111725',
  card: '#0E1320',
  line: '#232A38',
  text: '#E6EDF3',
  muted: '#8B949E',
  green: '#3FB950',
  red: '#F85149',
  chipBg: '#1B2333',
  white: '#FFFFFF', // the wordmark only
  amber: '#F0883E', // activity counts only: a state, never a result
  // The bot's OWN colour. Deliberately neither the green nor the red: the name is an
  // identity, and a brand painted in a result colour reads as a result.
  brand: '#4DA3FF',
};

/**
 * The bot's name, underlined. Grey, not a brand colour: the only colours on these cards
 * carry meaning (green profit, red loss), and a third one on the name competes with them.
 * Drawn from one helper so the masthead cannot drift apart between cards.
 */
function masthead(ctx: SKRSContext2D, x: number, y: number) {
  ctx.font = '21px PhMono';
  ctx.fillStyle = COL.muted;
  ctx.fillText('PHILIPS', x, y);
  // The rule is exactly as wide as the word; a fixed width would hang off the end.
  ctx.fillRect(x, y + 9, ctx.measureText('PHILIPS').width, 2);
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export type ProfitCardOpts = {
  pair?: string; // 'WETH / PONS'; absent on a period recap, which has no single pair
  /** true profit, false loss, null FLAT. Zero is neither: painting it green is the card
   *  telling the owner they made money when they did not. */
  positive: boolean | null;
  pnlBig: string; // '+$1.42' or '+0.0182 ETH'
  pnlPct: string; // '+7.8%'
  stats: Array<{ label: string; value: string }>; // ≤4
  footerLeft: string; // 'Robinhood · 14 Sep 2026'
  shape?: 'spot' | 'bidask'; // a badge to the right of the pair; empty means it is not drawn
  /**
   * Overrides the PROFIT/LOSS word. A period recap says what it IS ('PnL Weekly'), which
   * is not an outcome, so it is drawn in white -- the colour is left to the figure below,
   * where it means something.
   */
  label?: string;
};

/**
 * `scale` multiplies the output resolution. The whole layout stays written in logical
 * units (W x H) and ctx.scale does the enlarging, so no coordinate has to change. Text
 * stays sharp when zoomed; the source artwork is 1280x720, so past about 1.9x it softens.
 */
export async function renderProfitCard(o: ProfitCardOpts, scale = 2): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const accent = o.positive === null ? COL.text : o.positive ? COL.green : COL.red;

  const img = await background();
  if (img) {
    // Cover anchored RIGHT rather than centre-cropped: the artwork puts its character on
    // the right and leaves empty space on the left, exactly where this card's text goes.
    const s = Math.max(W / img.width, H / img.height);
    ctx.drawImage(img, W - img.width * s, (H - img.height * s) / 2, img.width * s, img.height * s);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.bg0);
    g.addColorStop(1, COL.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ── An ANGLED dark veil that fades out completely, not a panel with an edge. The
  // artwork carries through into the text area and the transition has no visible border.
  // The gradient MUST reach zero (760) before the leftmost clip edge (800), or the
  // leftover darkness at the cut reads as a vertical line.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(900, 0);
  ctx.lineTo(800, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.clip();
  const veil = ctx.createLinearGradient(0, 0, 760, 0);
  veil.addColorStop(0, 'rgba(8,11,18,0.88)');
  veil.addColorStop(0.55, 'rgba(12,16,26,0.62)');
  veil.addColorStop(1, 'rgba(18,24,38,0)');
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, 900, H);
  const glow = ctx.createRadialGradient(120, 130, 10, 120, 130, 600);
  glow.addColorStop(0, accent + '24');
  glow.addColorStop(1, accent + '00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 900, H);
  ctx.restore();

  const X = 76;
  masthead(ctx, X, 80);
  ctx.fillStyle = COL.text;
  ctx.font = '40px PhSansB';
  if (o.pair) ctx.fillText(o.pair, X, 146);

  // The position-shape badge, immediately right of the pair. Its colour is NEUTRAL rather
  // than green or red: this is a description, not a result, and using result colours would
  // compete with the large figure below. Its height follows the pair's cap height rather
  // than a fixed number.
  if (o.shape && o.pair) {
    const label = o.shape === 'bidask' ? 'BID-ASK' : 'SPOT';
    const pairW = ctx.measureText(o.pair).width;
    ctx.font = '17px PhSansB';
    const tw = ctx.measureText(label).width;
    const padX = 12;
    const bw = tw + padX * 2;
    const bh = 29;
    const bx = X + pairW + 16;
    const by = 146 - bh + 6; // sits on the pair's own baseline
    ctx.fillStyle = COL.chipBg;
    roundRect(ctx, bx, by, bw, bh, 7);
    ctx.fill();
    ctx.strokeStyle = COL.line;
    ctx.lineWidth = 1;
    roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 7);
    ctx.stroke();
    ctx.fillStyle = COL.muted;
    ctx.fillText(label, bx + padX, by + bh - 9);
  }

  // The result label and a rule as wide as the word itself -- LOSS is shorter than PROFIT,
  // and a fixed width would leave the rule hanging.
  const word = o.label ?? (o.positive === null ? 'FLAT' : o.positive ? 'PROFIT' : 'LOSS');
  // PROFIT/LOSS is an outcome: small, in the outcome's colour, with a rule as wide as the
  // word itself. A supplied label NAMES the card instead -- it is the title of a recap, so
  // it is set larger, in white, and carries no rule.
  ctx.fillStyle = o.label ? COL.text : accent;
  ctx.font = `${o.label ? 50 : 19}px PhSansB`;
  ctx.fillText(word, X, 208);
  if (!o.label) ctx.fillRect(X, 216, ctx.measureText(word).width, 2);

  // The amount and percentage take the result colour. The unit ('USDT') is split off and
  // drawn smaller: what makes '-138.61 USDT' so much longer than '+$18.42' is the unit,
  // not the number, and splitting them keeps the two cards the same size. The figure still
  // shrinks itself if it runs extremely long, as a safety net.
  const sp = o.pnlBig.indexOf(' ');
  const num = sp < 0 ? o.pnlBig : o.pnlBig.slice(0, sp);
  const unit = sp < 0 ? '' : o.pnlBig.slice(sp + 1);
  let npx = 92;
  ctx.font = `${npx}px PhSansB`;
  while (npx > 44 && ctx.measureText(num).width > (unit ? 400 : 460)) {
    npx -= 3;
    ctx.font = `${npx}px PhSansB`;
  }
  ctx.fillStyle = accent;
  ctx.fillText(num, X - 2, 302);
  if (unit) {
    const nw = ctx.measureText(num).width;
    ctx.font = `${Math.round(npx * 0.42)}px PhSansB`;
    ctx.fillText(unit, X - 2 + nw + 14, 302);
  }
  ctx.font = '40px PhSansB';
  ctx.fillText(o.pnlPct, X, 366);

  // A 2x2 stats block: no boxes, just spacing.
  o.stats.slice(0, 4).forEach((s, i) => {
    const y = 424 + Math.floor(i / 2) * 82;
    const x = X + (i % 2) * 250;
    ctx.fillStyle = COL.muted;
    ctx.font = '16px PhSansB';
    ctx.fillText(s.label.toUpperCase(), x, y);
    ctx.fillStyle = COL.text;
    ctx.font = '25px PhSans';
    ctx.fillText(s.value, x, y + 32);
  });

  ctx.fillStyle = COL.muted;
  ctx.font = '17px PhMono';
  ctx.fillText(o.footerLeft, X, H - 42);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
export type PositionsCardOpts = {
  rows: Array<{
    id: string;
    pair: string;
    investLabel: string;
    pnlLabel: string; // '+$1.24' | '—'
    age: string;
    inRange: boolean;
  }>;
  netLabel: string; // 'Net +$4.73'
  netPositive: boolean | null; // null means unknown, so a neutral colour
  footer: string; // 'LIVE · 17:42 WIB'
  moreCount: number; // the rows that did not fit
};

export function renderPositionsCard(o: PositionsCardOpts): Buffer {
  ensureFonts();
  const PW = 1040;
  const PADX = 56;
  const ROW_H = 62;
  const headTop = 56;
  const tableTop = headTop + 96;
  const bodyH = o.rows.length * ROW_H;
  const footTop = tableTop + bodyH + 34;
  const PH = footTop + (o.moreCount ? 44 : 0) + 150;

  const canvas = createCanvas(PW, PH);
  const ctx = canvas.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, 0, PH);
  g.addColorStop(0, COL.bg0);
  g.addColorStop(1, COL.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PW, PH);
  ctx.fillStyle = COL.card;
  roundRect(ctx, 20, 20, PW - 40, PH - 40, 28);
  ctx.fill();

  // Judul
  ctx.fillStyle = COL.text;
  ctx.font = '44px PhSansB';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('POSITION', PADX, headTop + 44);

  const hr = (y: number) => {
    ctx.strokeStyle = COL.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PADX, y);
    ctx.lineTo(PW - PADX, y);
    ctx.stroke();
  };
  hr(tableTop - 30);

  // Column widths are measured from the actual content, which is what keeps the columns
  // aligned without needing a monospace font.
  const wOf = (font: string, list: string[]): number => {
    ctx.font = font;
    return Math.max(...list.map((s) => ctx.measureText(s).width));
  };
  const F_ID = '30px PhSans';
  const F_PAIR = '31px PhSansB';
  const F_NUM = '30px PhSans';

  const ids = o.rows.map((r) => `#${r.id}`);
  const wId = wOf(F_ID, ids);
  const wInv = wOf(F_NUM, o.rows.map((r) => r.investLabel));
  const wPnl = wOf(F_NUM, o.rows.map((r) => r.pnlLabel));
  const wAge = wOf(F_NUM, o.rows.map((r) => r.age));

  // The right column is stored as its RIGHT EDGE: with textAlign='right', fillText(s, X)
  // menaruh ujung kanan teks tepat di X.
  const xId = PADX;
  const xPair = xId + wId + 28;
  const xDot = PW - PADX - 9;
  const rAge = xDot - 32;
  const rPnl = rAge - wAge - 30;
  const rInv = rPnl - wPnl - 30;
  const pairMax = rInv - wInv - xPair - 28;

  o.rows.forEach((r, i) => {
    const y = tableTop + i * ROW_H + 40;
    if (i % 2 === 1) {
      ctx.fillStyle = COL.chipBg + '66';
      roundRect(ctx, PADX - 18, y - 40, PW - 2 * PADX + 36, ROW_H - 6, 12);
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = COL.muted;
    ctx.font = F_ID;
    ctx.fillText(ids[i], xId, y);

    ctx.fillStyle = COL.text;
    ctx.font = F_PAIR;
    let pair = r.pair;
    while (ctx.measureText(pair).width > pairMax && pair.length > 3) pair = pair.slice(0, -2) + '…';
    ctx.fillText(pair, xPair, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = COL.muted;
    ctx.font = F_NUM;
    ctx.fillText(r.investLabel, rInv, y);

    const neg = r.pnlLabel.trim().startsWith('-');
    ctx.fillStyle = r.pnlLabel === '—' ? COL.muted : neg ? COL.red : COL.green;
    ctx.fillText(r.pnlLabel, rPnl, y);

    ctx.fillStyle = COL.muted;
    ctx.fillText(r.age, rAge, y);

    // The status dot is a circle rather than an emoji: its size is certain everywhere.
    ctx.beginPath();
    ctx.arc(xDot, y - 10, 9, 0, Math.PI * 2);
    ctx.fillStyle = r.inRange ? COL.green : COL.red;
    ctx.fill();
    ctx.textAlign = 'left';
  });

  hr(tableTop + bodyH + 4);

  ctx.fillStyle = o.netPositive === null ? COL.text : o.netPositive ? COL.green : COL.red;
  ctx.font = '40px PhSansB';
  ctx.fillText(o.netLabel, PADX, footTop + 42);

  let y = footTop + 42;
  if (o.moreCount) {
    y += 44;
    ctx.fillStyle = COL.muted;
    ctx.font = '26px PhSans';
    ctx.fillText(`+${o.moreCount} more positions — close some to see them`, PADX, y);
  }

  ctx.fillStyle = COL.muted;
  ctx.font = '26px PhSans';
  ctx.fillText(o.footer, PADX, y + 60);

  return canvas.toBuffer('image/png');
}
