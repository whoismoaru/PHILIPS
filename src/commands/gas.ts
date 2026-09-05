import { ethers } from 'ethers';
import { Markup } from 'telegraf';
import { bot, html } from '../core.js';
import { CHAINS, type ChainCtx } from '../chains.js';
import { getEthUsd } from '../screening.js';
import { bold, esc, italic } from '../messages.js';

/**
 * /gas — ongkos transaksi SAAT INI di tiap chain, dalam USD dan Rupiah.
 *
 * Harga gas diambil dari RPC chain itu sendiri (`getFeeData`) — sumber paling
 * resmi yang ada, dan yang persis dipakai bot saat mengirim tx. Tak ada oracle
 * pihak ketiga di jalur ini: angka yang ditampilkan = angka yang akan dibayar.
 *
 * Jumlah GAS-nya (bukan harganya) memakai median tx nyata wallet ini selama 14
 * hari — bukan tebakan. Estimasi teoretis (21k untuk semua) meleset jauh: satu
 * modifyLiquidities v4 makan >260k, dan itu operasi yang paling sering dipakai.
 */

/** Median gas terpakai per operasi, diukur dari 704 tx sukses wallet ini (14 hari).
 *  Kirim native tetap 21.000 — itu konstanta protokol, bukan hasil ukur. */
const OPS: Array<[string, bigint]> = [
  ['Swap', 280_000n],
  ['Open LP', 447_000n],
  ['Close LP', 267_000n],
];

/** Operasi murah di semua chain: tak layak satu seksi peringkat sendiri-sendiri,
 *  tapi tetap ditampilkan penuh — meringkasnya jadi "di bawah RpX" berarti memasang
 *  klaim yang diam-diam jadi bohong begitu gas bergerak. */
const MINOR: Array<[string, bigint]> = [
  ['Send', 21_000n],
  ['Approve', 46_000n],
];

/** Kurs USD→IDR. Indodax UTAMA (pasar kripto lokal, live) — itu kurs yang benar-benar
 *  dihadapi user saat menjual kripto ke rupiah, dan bergerak tiap detik. Bank rate
 *  jadi cadangan; ia cuma diperbarui sekali sehari. */
let idrCache: { v: number | null; t: number } = { v: null, t: 0 };

async function usdToIdr(): Promise<number | null> {
  if (Date.now() - idrCache.t < 300_000) return idrCache.v;
  const get = async (url: string, pick: (j: any) => unknown): Promise<number | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const n = Number(pick(await r.json()));
      return isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  const v =
    (await get('https://indodax.com/api/ticker/usdtidr', (j) => j?.ticker?.last)) ??
    (await get('https://open.er-api.com/v6/latest/USD', (j) => j?.rates?.IDR));
  idrCache = { v, t: Date.now() };
  return v;
}

/** Harga gas efektif yang akan dibayar. EIP-1559 → maxFee; legacy → gasPrice. */
async function gasPriceOf(cc: ChainCtx): Promise<bigint | null> {
  try {
    const f = await cc.provider.getFeeData();
    return f.gasPrice ?? f.maxFeePerGas ?? null;
  } catch {
    return null;
  }
}

const gwei = (wei: bigint): string => {
  const g = Number(ethers.formatUnits(wei, 'gwei'));
  return g >= 1 ? g.toFixed(2) : g.toPrecision(2);
};

/**
 * Ongkos dalam dolar, selalu dengan angka berarti.
 *
 * Pembulatan tetap (5 desimal) mencetak "$0" untuk operasi termurah — dan "$0"
 * itu bohong: gasnya tetap dibayar, cuma terlalu kecil untuk formatnya. Di bawah
 * satu sen dipakai 3 angka penting, jadi $0,0000045 tetap terbaca apa adanya.
 */
const usd = (v: number): string => {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  if (v === 0) return '$0';
  return `$${Number(v.toPrecision(3))}`;
};

const idr = (v: number): string =>
  `Rp${Math.round(v).toLocaleString('id-ID')}`;

type Row = { label: string; usd: number | null; native: number; sym: string };

/** Ongkos tiap operasi di satu chain. `null` = RPC chain itu tak menjawab. */
async function costsOf(cc: ChainCtx): Promise<{ label: string; gwei: string; nativeUsd: number | null; rows: Map<string, Row> } | null> {
  const [price, nativeUsd] = await Promise.all([gasPriceOf(cc), getEthUsd(cc.wethAddress, cc).catch(() => null)]);
  if (price === null) return null;
  const rows = new Map<string, Row>();
  for (const [label, units] of [...OPS, ...MINOR]) {
    const native = Number(ethers.formatEther(price * units));
    rows.set(label, { label, usd: nativeUsd === null ? null : native * nativeUsd, native, sym: cc.nativeSymbol });
  }
  return { label: cc.label, gwei: gwei(price), nativeUsd, rows };
}

type Chain = NonNullable<Awaited<ReturnType<typeof costsOf>>>;

/** Satu seksi: chain diurut dari termurah untuk operasi ini.
 *  Chain tanpa harga native TIDAK ikut diperingkat — mengurutkannya butuh angka USD
 *  yang justru tak kita punya; ia ditaruh di bawah dengan ongkos dalam satuan native. */
function section(op: string, chains: Chain[], rate: number | null): string[] {
  const withUsd = chains.filter((c) => c.rows.get(op)!.usd !== null).sort((a, b) => a.rows.get(op)!.usd! - b.rows.get(op)!.usd!);
  const noUsd = chains.filter((c) => c.rows.get(op)!.usd === null);
  const lines = withUsd.map((c, i) => {
    const r = c.rows.get(op)!;
    return `${i + 1}. ${esc(c.label)} = ${bold(usd(r.usd!))} / ${bold(rate ? idr(r.usd! * rate) : '—')}`;
  });
  for (const c of noUsd) {
    const r = c.rows.get(op)!;
    lines.push(`— ${esc(c.label)} = ${bold(`${r.native.toFixed(6)} ${r.sym}`)} ${italic('(no USD price)')}`);
  }
  return [bold(op.toUpperCase()), ...lines];
}

/** Kartu penuh. Diekspor supaya bisa diuji tanpa Telegram (scripts/smoke-gas.ts). */
export async function gasCard(): Promise<string> {
  const rate = await usdToIdr();
  const all = await Promise.all(Object.values(CHAINS).map(async (cc) => [cc.label, await costsOf(cc)] as const));
  const chains = all.filter((x): x is readonly [string, Chain] => x[1] !== null).map((x) => x[1]);
  const down = all.filter((x) => x[1] === null).map((x) => x[0]);

  if (!chains.length)
    return [bold('⛽️ GAS FEE'), '', italic('No chain responded — every RPC is down. Try again shortly.')].join('\n');

  return [
    bold('⛽️ GAS FEE'),
    '',
    ...OPS.flatMap(([op]) => [...section(op, chains, rate), '']),
    // SEND & APPROVE dipatok pada APPROVE, angka yang lebih MAHAL dari keduanya.
    // Memakai Send (21k) di seksi bernama "Send & Approve" akan memasang angka
    // yang meleset 55% ke bawah untuk separuh operasi yang dijanjikannya.
    ...section('Approve', chains, rate).map((l, i) => (i === 0 ? bold('SEND & APPROVE') : l)),
    '',
    ...(down.length ? [italic(`Unreachable: ${down.join(', ')}`), ''] : []),
    // Kaki kartu = JAM & ZONA saja (permintaan pemilik). Kurs dan catatan approve
    // pernah ikut nebeng di sini dan membuatnya jadi baris serba-guna.
    italic(clock()),
  ].join('\n');
}

/** Jam baca + zona server. Membuat Refresh JUJUR: tanpanya, menekan tombol saat gas
 *  tak bergerak menghasilkan pesan identik, Telegram menolaknya ("not modified"),
 *  dan kartunya diam seolah tombolnya rusak. */
function clock(): string {
  const d = new Date();
  const tanggal = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${tanggal} · ${d.toLocaleTimeString('en-GB', { hour12: false })} ${offsetLabel()}`;
}

/** Tombol tunggal: baca ulang semua chain. */
export const gasKeyboard = () => Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'gas:refresh')]]);

/** Label zona waktu server, supaya jam di kartu tak ambigu. */
function offsetLabel(): string {
  const m = -new Date().getTimezoneOffset();
  if (m === 0) return 'UTC';
  const sign = m > 0 ? '+' : '-';
  return `UTC${sign}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
}

bot.command('gas', async (ctx) => {
  const wait = await ctx.reply('⛽ Reading gas from each chain…');
  const text = await gasCard();
  const opts = { ...html, ...gasKeyboard() };
  await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, text, opts).catch(async () => {
    await ctx.reply(text, opts);
  });
});

bot.action('gas:refresh', async (ctx) => {
  await ctx.answerCbQuery('Reading gas…');
  try {
    await ctx.editMessageText(await gasCard(), { ...html, ...gasKeyboard() });
  } catch (e) {
    // "message is not modified" = angkanya belum bergerak — bukan kegagalan.
    if (!/not modified/i.test((e as Error).message)) throw e;
  }
});
