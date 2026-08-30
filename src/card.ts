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
  shape?: 'spot' | 'bidask'; // badge di kanan pair; kosong = tak digambar
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
    // kanan dan ruang kosong di kiri — persis tempat teks kartu ini.
    const s = Math.max(W / img.width, H / img.height);
    ctx.drawImage(img, W - img.width * s, (H - img.height * s) / 2, img.width * s, img.height * s);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.bg0);
    g.addColorStop(1, COL.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Selubung gelap MIRING yang memudar habis, bukan panel bertepi. Artwork
  // menembus sampai ke area teks; peralihannya tak berbatas garis.
  // Gradasi WAJIB mencapai nol (760) SEBELUM tepi kliping paling kiri (800),
  // kalau tidak sisa kegelapan di garis potong terbaca sebagai garis tegak.
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
  ctx.fillStyle = COL.muted;
  ctx.font = '19px PhSansB';
  ctx.fillText('PHILIPS', X, 84);
  ctx.fillStyle = COL.text;
  ctx.font = '29px PhSansB';
  ctx.fillText(o.pair, X, 128);

  // Badge bentuk posisi, tepat di kanan pair. Warnanya NETRAL (bukan hijau/merah):
  // ini keterangan, bukan hasil — memakai warna hasil akan bersaing dengan angka
  // besar di bawahnya. Tingginya mengikuti tinggi huruf pair, bukan angka mati.
  if (o.shape) {
    const label = o.shape === 'bidask' ? 'BID-ASK' : 'SPOT';
    const pairW = ctx.measureText(o.pair).width;
    ctx.font = '15px PhSansB';
    const tw = ctx.measureText(label).width;
    const padX = 11;
    const bw = tw + padX * 2;
    const bh = 26;
    const bx = X + pairW + 16;
    const by = 128 - bh + 5; // sejajar dasar huruf pair
    ctx.fillStyle = COL.chipBg;
    roundRect(ctx, bx, by, bw, bh, 7);
    ctx.fill();
    ctx.strokeStyle = COL.line;
    ctx.lineWidth = 1;
    roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 7);
    ctx.stroke();
    ctx.fillStyle = COL.muted;
    ctx.fillText(label, bx + padX, by + bh - 8);
  }

  // Label hasil + garis bawah selebar KATANYA SENDIRI (LOSS lebih pendek dari
  // PROFIT; lebar mati akan menyisakan garis menggantung).
  const word = o.positive ? 'PROFIT' : 'LOSS';
  ctx.fillStyle = accent;
  ctx.font = '19px PhSansB';
  ctx.fillText(word, X, 208);
  ctx.fillRect(X, 216, ctx.measureText(word).width, 2);

  // Nominal + persen ikut warna hasil. Satuan ('USDT') dipisah dan digambar
  // lebih kecil: yang membuat '-138.61 USDT' jauh lebih panjang dari '+$18.42'
  // adalah satuannya, bukan angkanya — dipisah begini kedua kartu seukuran.
  // Angkanya tetap MENGECIL sendiri kalau ekstrem panjang (jaring pengaman).
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

  // Statistik 2x2 — tanpa kotak, cuma jarak.
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
export type CalendarCardOpts = {
  title: string; // 'Robinhood · USDG'
  subtitle: string; // '30 days'
  days: Array<{ date: Date; net: number; trades: number }>;
  unit: string;
  netLabel: string; // '+42.10 USDG'
  positive: boolean;
  stats: Array<{ label: string; value: string }>; // <=4
  footerLeft: string;
};

/**
 * Kalender PnL 30 hari — TANPA artwork, murni data.
 *
 * Tiga lapis supaya tak jadi kisi datar: kisi kalender SEJAJAR HARI (kolom = hari
 * dalam minggu, seperti kalender sungguhan), kurva kumulatif di kiri bawah yang
 * memperlihatkan bentuk perjalanannya, dan cincin penanda di hari terbaik & terburuk.
 * Kepekatan kotak relatif terhadap hari terkuat: skala absolut membuat satu hari
 * besar meratakan sisanya jadi abu-abu.
 */
export async function renderCalendarCard(o: CalendarCardOpts, scale = 2): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const accent = o.positive ? COL.green : COL.red;

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, COL.bg0);
  g.addColorStop(1, COL.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(140, 140, 10, 140, 140, 680);
  glow.addColorStop(0, accent + '1C');
  glow.addColorStop(1, accent + '00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const X = 76;
  ctx.fillStyle = COL.muted;
  ctx.font = '19px PhSansB';
  ctx.fillText('PHILIPS', X, 76);
  ctx.fillStyle = COL.text;
  ctx.font = '28px PhSansB';
  ctx.fillText(o.title, X, 116);
  ctx.fillStyle = COL.muted;
  ctx.font = '16px PhSans';
  ctx.fillText(o.subtitle, X, 142);

  ctx.fillStyle = accent;
  ctx.font = '18px PhSansB';
  const word = o.positive ? 'NET PROFIT' : 'NET LOSS';
  ctx.fillText(word, X, 194);
  ctx.fillRect(X, 202, ctx.measureText(word).width, 2);
  const sp = o.netLabel.indexOf(' ');
  const num = sp < 0 ? o.netLabel : o.netLabel.slice(0, sp);
  const unit = sp < 0 ? '' : o.netLabel.slice(sp + 1);
  let npx = 70;
  ctx.font = `${npx}px PhSansB`;
  while (npx > 34 && ctx.measureText(num).width > 300) {
    npx -= 3;
    ctx.font = `${npx}px PhSansB`;
  }
  ctx.fillText(num, X - 2, 274);
  if (unit) {
    const nw = ctx.measureText(num).width;
    ctx.font = `${Math.round(npx * 0.42)}px PhSansB`;
    ctx.fillText(unit, X - 2 + nw + 12, 274);
  }

  o.stats.slice(0, 4).forEach((st, i) => {
    const sx = X + (i % 2) * 190;
    const sy = 330 + Math.floor(i / 2) * 66;
    ctx.fillStyle = COL.muted;
    ctx.font = '13px PhSansB';
    ctx.fillText(st.label.toUpperCase(), sx, sy);
    ctx.fillStyle = COL.text;
    ctx.font = '22px PhSansB';
    ctx.fillText(st.value, sx, sy + 28);
  });

  // ── Kurva kumulatif: bentuk perjalanan, bukan cuma titik-titik harian ──
  {
    const cx = X;
    const cy = 486;
    const cw = 372;
    const ch = 78;
    let run = 0;
    const cum = o.days.map((d) => (run += d.net));
    const lo = Math.min(0, ...cum);
    const hi = Math.max(0, ...cum);
    const span = hi - lo || 1;
    const px = (i: number) => cx + (i / Math.max(1, o.days.length - 1)) * cw;
    const py = (v: number) => cy + ch - ((v - lo) / span) * ch;

    ctx.strokeStyle = COL.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, py(0));
    ctx.lineTo(cx + cw, py(0));
    ctx.stroke();

    const area = ctx.createLinearGradient(0, cy, 0, cy + ch);
    area.addColorStop(0, accent + '3A');
    area.addColorStop(1, accent + '00');
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    cum.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(px(cum.length - 1), py(0));
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.beginPath();
    cum.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(px(cum.length - 1), py(cum[cum.length - 1] ?? 0), 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COL.muted;
    ctx.font = '12px PhSansB';
    ctx.fillText('CUMULATIVE', cx, cy - 12);
  }

  // ── Kisi kalender: kolom = hari dalam minggu, seperti kalender sungguhan ──
  const CELL = 64;
  const GAP = 8;
  const COLS = 7;
  const gw = COLS * CELL + (COLS - 1) * GAP;
  const gx = W - 76 - gw;
  const gy = 168;
  const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  ctx.fillStyle = COL.muted;
  ctx.font = '13px PhSansB';
  WD.forEach((w, i) => {
    const x = gx + i * (CELL + GAP);
    ctx.fillText(w, x + CELL / 2 - ctx.measureText(w).width / 2, gy - 12);
  });

  // Senin = 0. Hari pertama digeser ke kolom hari-nya sendiri.
  // getUTC*, bukan getDay/getDate: `date` adalah tengah malam UTC yang MEWAKILI
  // satu hari WIB (lihat wibBuckets). Membacanya dengan getter lokal akan
  // menggeser kolom & label tanggal begitu zona waktu mesin berubah.
  const wd = (d: Date) => (d.getUTCDay() + 6) % 7;
  const lead = o.days.length ? wd(o.days[0].date) : 0;
  const peak = Math.max(...o.days.map((d) => Math.abs(d.net)), 0);
  const traded = o.days.filter((d) => d.trades > 0);
  const best = traded.reduce<null | (typeof o.days)[number]>((a, d) => (a === null || d.net > a.net ? d : a), null);
  const worst = traded.reduce<null | (typeof o.days)[number]>((a, d) => (a === null || d.net < a.net ? d : a), null);

  o.days.forEach((d, i) => {
    const slot = lead + i;
    const x = gx + (slot % COLS) * (CELL + GAP);
    const y = gy + Math.floor(slot / COLS) * (CELL + GAP);
    if (d.trades === 0) {
      ctx.fillStyle = COL.card;
      roundRect(ctx, x, y, CELL, CELL, 10);
      ctx.fill();
      ctx.strokeStyle = COL.line;
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 0.5, CELL - 1, CELL - 1, 10);
      ctx.stroke();
    } else {
      // Lantai 0.25: hari bertrade kecil tetap harus terbaca sebagai warna.
      const a = peak > 0 ? 0.25 + 0.75 * Math.min(1, Math.abs(d.net) / peak) : 0.6;
      ctx.fillStyle = (d.net >= 0 ? COL.green : COL.red) + Math.round(a * 255).toString(16).padStart(2, '0');
      roundRect(ctx, x, y, CELL, CELL, 10);
      ctx.fill();
    }
    // Cincin di hari terbaik & terburuk — dua titik yang paling sering dicari.
    if (d.trades > 0 && (d === best || d === worst)) {
      ctx.strokeStyle = COL.text;
      ctx.lineWidth = 2;
      roundRect(ctx, x - 3, y - 3, CELL + 6, CELL + 6, 13);
      ctx.stroke();
    }
    ctx.fillStyle = d.trades === 0 ? COL.muted : '#0B0E14';
    ctx.font = '15px PhSansB';
    const label = String(d.date.getUTCDate());
    ctx.fillText(label, x + CELL / 2 - ctx.measureText(label).width / 2, y + CELL / 2 + 1);
    if (d.trades > 0) {
      ctx.font = '11px PhSansB';
      const t = `${d.trades}`;
      ctx.fillText(t, x + CELL / 2 - ctx.measureText(t).width / 2, y + CELL / 2 + 18);
    }
  });

  // Legenda.
  const rows = Math.ceil((lead + o.days.length) / COLS);
  const ly = gy + rows * (CELL + GAP) + 22;
  const chip = (x: number, fill: string, outline: boolean, text: string) => {
    ctx.fillStyle = fill;
    roundRect(ctx, x, ly - 9, 16, 16, 5);
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = COL.line;
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, ly - 8.5, 15, 15, 5);
      ctx.stroke();
    }
    ctx.fillStyle = COL.muted;
    ctx.font = '13px PhSans';
    ctx.fillText(text, x + 23, ly + 4);
    return x + 23 + ctx.measureText(text).width + 22;
  };
  let lx = gx;
  lx = chip(lx, COL.card, true, 'no trades');
  lx = chip(lx, COL.red, false, 'loss');
  lx = chip(lx, COL.green, false, 'profit');
  ctx.fillStyle = COL.muted;
  ctx.font = '13px PhSans';
  ctx.fillText('◻ best / worst', lx, ly + 4);

  ctx.fillStyle = COL.muted;
  ctx.font = '16px PhMono';
  ctx.fillText(o.footerLeft, X, H - 40);

  return canvas.toBuffer('image/png');
}

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
