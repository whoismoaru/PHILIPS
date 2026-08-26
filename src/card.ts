import { createCanvas, loadImage, GlobalFonts, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { join } from 'node:path';

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

/**
 * Latar kartu: artwork di data/. Di-decode SEKALI lalu di-cache — close bisa
 * beruntun dan decode JPEG tiap kali itu sia-sia.
 * File hilang/rusak → null, kartu jatuh ke latar gradient (close TAK boleh gagal
 * gara-gara hiasan).
 */
const BG_FILE = join(process.cwd(), 'data', 'PHILIPS ANIME.jpg');
let bgImg: Image | null | undefined;
async function background(): Promise<Image | null> {
  if (bgImg !== undefined) return bgImg;
  try {
    bgImg = await loadImage(BG_FILE);
  } catch (e) {
    bgImg = null;
    console.error(`[card] latar tak terbaca (${BG_FILE}) — pakai gradient:`, (e as Error).message);
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

/**
 * scale: kelipatan resolusi keluaran. Seluruh tata letak tetap ditulis dalam
 * satuan logis (W x H) — ctx.scale yang membesarkannya, jadi tak ada koordinat
 * yang perlu diubah. Teks jadi tajam saat di-zoom; artwork sumbernya 1280x720
 * sehingga di atas ~1.9x ia mulai melunak.
 */
export async function renderProfitCard(o: ProfitCardOpts, scale = 2): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const accent = o.positive ? COL.green : COL.red;

  const img = await background();
  if (img) {
    // Cover RATA KANAN, bukan crop tengah: komposisi artwork menaruh karakter di
    // kanan dan ruang kosong di kiri — persis tempat panel kartu ini.
    const s = Math.max(W / img.width, H / img.height);
    ctx.drawImage(img, W - img.width * s, (H - img.height * s) / 2, img.width * s, img.height * s);
    // Scrim lembut saja: kontras teks sekarang datang dari panel kaca di bawah,
    // jadi artwork tak perlu digelapkan sekeras dulu.
    const sc = ctx.createLinearGradient(0, 0, W, 0);
    sc.addColorStop(0, 'rgba(7,10,16,0.86)');
    sc.addColorStop(0.55, 'rgba(7,10,16,0.55)');
    sc.addColorStop(1, 'rgba(7,10,16,0.10)');
    ctx.fillStyle = sc;
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.bg0);
    g.addColorStop(1, COL.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Panel kaca. Menggantikan tumpukan teks telanjang + garis pemisah yang
  // dulu terpotong di tengah udara. Panel memberi tepi yang disengaja, jadi
  // tata letak boleh bernapas tanpa terlihat kaku.
  const PX = 44;
  const PY = 40;
  const PWID = 680;
  const PHGT = H - PY * 2 - 8;
  ctx.save();
  roundRect(ctx, PX, PY, PWID, PHGT, 34);
  ctx.clip();
  ctx.fillStyle = 'rgba(9,12,19,0.80)';
  ctx.fillRect(PX, PY, PWID, PHGT);
  // Cahaya accent dari kiri-atas: kedalaman, sekaligus mewarnai kartu sesuai hasil.
  const glow = ctx.createRadialGradient(PX + 150, PY + 150, 10, PX + 150, PY + 150, 430);
  glow.addColorStop(0, accent + '1C');
  glow.addColorStop(1, accent + '00');
  ctx.fillStyle = glow;
  ctx.fillRect(PX, PY, PWID, PHGT);
  ctx.restore();
  roundRect(ctx, PX + 0.5, PY + 0.5, PWID - 1, PHGT - 1, 34);
  ctx.strokeStyle = 'rgba(255,255,255,0.11)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const CX = PX + 44; // margin kiri isi panel
  const CW = PWID - 88; // lebar isi panel

  // ── Header: penanda accent + wordmark, lalu pasangan token sebagai chip.
  ctx.fillStyle = accent;
  roundRect(ctx, CX, PY + 44, 8, 30, 4);
  ctx.fill();
  ctx.fillStyle = COL.text;
  ctx.font = '30px PhSansB';
  ctx.fillText('PHILIPS', CX + 22, PY + 69);

  const chipH = 40;
  const chipY = PY + 92;
  ctx.font = '21px PhSans';
  const chipW = ctx.measureText(o.pair).width + 36;
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  roundRect(ctx, CX, chipY, chipW, chipH, chipH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  roundRect(ctx, CX + 0.5, chipY + 0.5, chipW - 1, chipH - 1, chipH / 2);
  ctx.stroke();
  ctx.fillStyle = COL.text;
  ctx.fillText(o.pair, CX + 18, chipY + 27);

  // ── Hero: label, angka besar, lalu persen dalam pil bernada accent.
  ctx.fillStyle = accent;
  ctx.font = '21px PhSansB';
  ctx.fillText(o.positive ? 'PROFIT' : 'LOSS', CX, PY + 196);

  // Angka utama MENGECIL sendiri sampai muat di panel. Ukuran mati cocok untuk
  // '+$1.42' tapi '-138.61 USDT' meluber keluar panel — rekap PnL memang sering
  // panjang (nilai + satuan).
  let heroPx = 106;
  ctx.font = `${heroPx}px PhSansB`;
  while (heroPx > 46 && ctx.measureText(o.pnlBig).width > CW) {
    heroPx -= 4;
    ctx.font = `${heroPx}px PhSansB`;
  }
  const heroY = PY + 296 - Math.round((106 - heroPx) * 0.35);
  ctx.fillStyle = COL.text;
  ctx.fillText(o.pnlBig, CX - 2, heroY);

  const pctTxt = `${o.positive ? '▲' : '▼'}  ${o.pnlPct}`;
  ctx.font = '30px PhSansB';
  const pctW = ctx.measureText(pctTxt).width + 40;
  const pctY = heroY + 24;
  ctx.fillStyle = accent + '24';
  roundRect(ctx, CX, pctY, pctW, 52, 26);
  ctx.fill();
  ctx.strokeStyle = accent + '59';
  ctx.lineWidth = 1.5;
  roundRect(ctx, CX + 0.75, pctY + 0.75, pctW - 1.5, 50.5, 26);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillText(pctTxt, CX + 20, pctY + 36);

  // ── Stats sebagai kartu kecil, bukan kolom teks telanjang. Font nilai turun
  // bertahap supaya empat stat tetap muat sebelum ada yang dibuang.
  const stats = o.stats.slice(0, 4);
  const GAP = 10;
  const statsY = PY + PHGT - 152;
  const statH = 84;
  let vPx = 24;
  let widths: number[] = [];
  for (const px of [24, 22, 20, 18]) {
    vPx = px;
    widths = stats.map((s) => {
      ctx.font = '16px PhSansB';
      const lw = ctx.measureText(s.label.toUpperCase()).width;
      ctx.font = `${px}px PhSans`;
      return Math.max(lw, ctx.measureText(s.value).width) + 32;
    });
    if (widths.reduce((a, b) => a + b, 0) + GAP * (stats.length - 1) <= CW) break;
  }
  let sx = CX;
  stats.forEach((s, i) => {
    const w = widths[i];
    if (sx + w > CX + CW) return; // lebih baik satu stat hilang daripada meluber
    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    roundRect(ctx, sx, statsY, w, statH, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    roundRect(ctx, sx + 0.5, statsY + 0.5, w - 1, statH - 1, 16);
    ctx.stroke();
    ctx.fillStyle = COL.muted;
    ctx.font = '16px PhSansB';
    ctx.fillText(s.label.toUpperCase(), sx + 16, statsY + 32);
    ctx.fillStyle = COL.text;
    ctx.font = `${vPx}px PhSans`;
    ctx.fillText(s.value, sx + 16, statsY + 64);
    sx += w + GAP;
  });

  ctx.fillStyle = COL.muted;
  ctx.font = '18px PhMono';
  ctx.fillText(o.footerLeft, CX, PY + PHGT - 34);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// Kartu POSITION (daftar LP aktif) — dirender sebagai PNG, bukan teks Telegram.
// Alasan: kolom lurus butuh lebar karakter yang bisa diukur. Di pesan Telegram
// itu hanya mungkin dengan font monospace; di kanvas kita ukur sendiri
// (measureText) sehingga kolom lurus SEKALIGUS fontnya proporsional & rapi.
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
  netPositive: boolean | null; // null = tak diketahui → warna netral
  footer: string; // 'LIVE · 17:42 WIB'
  moreCount: number; // baris yang tak muat
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

  // Lebar kolom diukur dari isi sebenarnya — inilah yang membuat kolom lurus
  // tanpa perlu font monospace.
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

  // Kolom kanan disimpan sebagai TEPI KANAN: dengan textAlign='right', fillText(s, X)
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

    // Titik status: lingkaran, bukan emoji — ukurannya pasti di semua sistem.
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
