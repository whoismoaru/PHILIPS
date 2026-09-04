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
  ['Send native', 21_000n],
  ['Approve', 46_000n],
  ['Swap', 280_000n],
  ['Open LP', 447_000n],
  ['Close LP', 267_000n],
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

const usd = (v: number): string =>
  v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(5)}`;

const idr = (v: number): string =>
  `Rp${Math.round(v).toLocaleString('id-ID')}`;

async function blockOf(cc: ChainCtx, rate: number | null): Promise<string[]> {
  const [price, nativeUsd] = await Promise.all([gasPriceOf(cc), getEthUsd(cc.wethAddress, cc).catch(() => null)]);
  if (price === null) return [bold(cc.label), italic('RPC unreachable — try again shortly.')];

  const head = `${bold(cc.label)} · ${esc(gwei(price))} gwei${nativeUsd ? ` · ${esc(cc.nativeSymbol)} ${esc(usd(nativeUsd))}` : ''}`;
  // Tanpa harga native, ongkosnya cuma bisa disebut dalam satuan native — menuliskan
  // "$0.00" di situ akan mengaku tahu sesuatu yang tak kita tahu.
  const rows = OPS.map(([label, units]) => {
    const wei = price * units;
    const native = Number(ethers.formatEther(wei));
    if (!nativeUsd) return `${esc(label)} · ${bold(`${native.toFixed(6)} ${cc.nativeSymbol}`)}`;
    const d = native * nativeUsd;
    return `${esc(label)} · ${bold(usd(d))}${rate ? ` · ${bold(idr(d * rate))}` : ''}`;
  });
  return [head, ...rows];
}

/** Kartu penuh. Diekspor supaya bisa diuji tanpa Telegram (scripts/smoke-gas.ts). */
export async function gasCard(): Promise<string> {
  const rate = await usdToIdr();
  const blocks = await Promise.all(Object.values(CHAINS).map((cc) => blockOf(cc, rate)));
  return [
    bold('⛽ GAS NOW'),
    rate ? italic(`USD→IDR ${idr(rate)} · live`) : italic('USD→IDR unavailable — showing USD only'),
    '',
    ...blocks.flatMap((b) => [...b, '']),
    italic('Gas units = median of this wallet’s real transactions (14 d). Prices read live from each chain’s own RPC.'),
    // Jam baca membuat Refresh JUJUR: tanpanya, menekan tombol saat gas tak
    // bergerak menghasilkan pesan identik — Telegram menolaknya ("not modified")
    // dan kartunya diam, seolah tombolnya rusak.
    italic(`Read ${new Date().toLocaleTimeString('en-GB', { hour12: false })} ${offsetLabel()}`),
  ].join('\n');
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
