import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';

/**
 * Render kartu PNG "momen kunci" (profit card saat close). Murni presentasi —
 * dipanggil SETELAH aksi on-chain selesai; gagal render TAK boleh mengganggu
 * alur (pemanggil membungkus try/catch). Font: DejaVu (offline, di sistem).
 */

const DEJAVU = '/usr/share/fonts/truetype/dejavu';
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const reg = (file: string, alias: string) => {
    try {
      GlobalFonts.registerFromPath(`${DEJAVU}/${file}`, alias);
    } catch {
      /* fallback ke default canvas bila font tak ada */
    }
  };
  reg('DejaVuSans.ttf', 'PhSans');
  reg('DejaVuSans-Bold.ttf', 'PhSansB');
  reg('DejaVuSansMono.ttf', 'PhMono');
  fontsReady = true;
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
};

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
  pair: string; // 'WETH / PONS'
  positive: boolean;
  pnlBig: string; // '+$1.42' atau '+0.0182 ETH'
  pnlPct: string; // '+7.8%'
  stats: Array<{ label: string; value: string }>; // ≤4
  footerLeft: string; // '#199367 · 19 Jul 2026 17:08 UTC'
};

export function renderProfitCard(o: ProfitCardOpts): Buffer {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const accent = o.positive ? COL.green : COL.red;

  // Latar: gradient gelap + kartu ber-radius + glow aksen halus.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, COL.bg0);
  g.addColorStop(1, COL.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = COL.card;
  roundRect(ctx, 24, 24, W - 48, H - 48, 28);
  ctx.fill();

  const glow = ctx.createRadialGradient(W - 200, 140, 20, W - 200, 140, 420);
  glow.addColorStop(0, accent + '33');
  glow.addColorStop(1, accent + '00');
  ctx.fillStyle = glow;
  roundRect(ctx, 24, 24, W - 48, H - 48, 28);
  ctx.fill();

  // Aksen batang kiri.
  ctx.fillStyle = accent;
  roundRect(ctx, 48, 210, 10, 200, 5);
  ctx.fill();

  // Header brand.
  ctx.fillStyle = COL.text;
  ctx.font = '38px PhSansB';
  ctx.fillText('PHILIPS', PAD, 108);
  ctx.fillStyle = COL.muted;
  ctx.font = '22px PhSans';
  ctx.fillText('LP cockpit · Robinhood', PAD, 142);

  // Chip pasangan (kanan atas).
  ctx.font = '26px PhSansB';
  const pairW = ctx.measureText(o.pair).width;
  const chipW = pairW + 56;
  ctx.fillStyle = COL.chipBg;
  roundRect(ctx, W - PAD - chipW, 84, chipW, 52, 26);
  ctx.fill();
  ctx.fillStyle = COL.text;
  ctx.fillText(o.pair, W - PAD - chipW + 28, 118);

  // Hero: label + PnL besar + persen.
  ctx.fillStyle = COL.muted;
  ctx.font = '24px PhSansB';
  ctx.fillText(o.positive ? 'PROFIT' : 'LOSS', PAD, 250);

  ctx.fillStyle = accent;
  ctx.font = '118px PhSansB';
  ctx.fillText(o.pnlBig, PAD - 2, 356);

  ctx.font = '46px PhSansB';
  ctx.fillText(o.pnlPct, PAD, 412);

  // Divider.
  ctx.strokeStyle = COL.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, 470);
  ctx.lineTo(W - PAD, 470);
  ctx.stroke();

  // Stats (≤4 kolom).
  const stats = o.stats.slice(0, 4);
  const span = (W - PAD * 2) / stats.length;
  stats.forEach((s, i) => {
    const x = PAD + span * i;
    ctx.fillStyle = COL.muted;
    ctx.font = '20px PhSansB';
    ctx.fillText(s.label.toUpperCase(), x, 522);
    ctx.fillStyle = COL.text;
    ctx.font = '30px PhSans';
    ctx.fillText(s.value, x, 560);
  });

  // Footer.
  ctx.fillStyle = COL.muted;
  ctx.font = '20px PhMono';
  ctx.fillText(o.footerLeft, PAD, H - 40);
  const right = 'uniswap v3';
  ctx.font = '20px PhSans';
  const rw = ctx.measureText(right).width;
  ctx.fillText(right, W - PAD - rw, H - 40);

  return canvas.toBuffer('image/png');
}
