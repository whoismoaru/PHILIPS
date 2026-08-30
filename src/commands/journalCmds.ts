import { Markup, Input } from 'telegraf';
import { config } from '../config.js';
import { bot, html } from '../core.js';
import { CHAINS } from '../chains.js';
import { getEthUsd } from '../screening.js';
import { renderProfitCard } from '../card.js';
import * as journal from '../journal.js';
import * as msg from '../messages.js';

/** /history & /pnl — pembacaan jurnal trade tertutup. Nol RPC, nol state. */

export function cmdHistory(ctx: any) {
  const total = journal.statsFor(0).count;
  const items = journal.readMine(8).map((e) => ({
    tokenId: e.tokenId,
    symbol: e.symbol,
    pnlPct: e.pnlPct,
    pnlEth: e.pnlEth,
    reason: e.reason,
    ca: e.ca,
    chain: e.chain,
    baseKind: e.baseKind,
    closedAt: e.closedAt,
  }));
  return ctx.reply(msg.msgJournal(items, total), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('🧾 PnL Recap', 'pnl'), Markup.button.callback('📊 View Positions', 'positions')]]),
  });
}

// /pnl — dua langkah: pilih CHAIN dulu (bubble), lalu PERIODE. Rekapnya sendiri
// tetap dipisah per denominasi, karena satu chain bisa punya dua base (mis.
// Robinhood: ETH & USDG; BSC: BNB & USDT).

/** Nama tampilan chain: dari config kalau chain-nya aktif, kalau tidak dari key-nya. */
const chainLabel = (key: string): string =>
  CHAINS[key]?.label ?? key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Chain yang ditawarkan = yang aktif sekarang + yang punya riwayat di jurnal.
 *
 * Dua angka, bukan satu. `trades` = seluruh entri jurnal; `scored` = yang benar-benar
 * masuk W/L. Bedanya besar (728 vs 246) karena 466 di antaranya impas di bawah
 * ±$0,1, plus 11 yang hasilnya tak terbaca dan 5 sweep. Pemilih dulu hanya
 * menyebut angka pertama sambil menulis "closed trades", lalu kartu rekap dua
 * tap kemudian menyebut angka kedua dengan kata yang sama — seolah 600 trade
 * hilang di antara dua layar.
 */
function pnlChains(): Array<{ key: string; label: string; trades: number; scored: number }> {
  const hist = new Map(journal.chainsWithHistory().map((c) => [c.key, c.trades]));
  const keys = new Set<string>([...Object.keys(CHAINS), ...hist.keys()]);
  const scoredOf = (key?: string) =>
    journal.statsFor(0, key).books.reduce((a, b) => a + b.known, 0);
  const per = [...keys]
    .map((key) => ({ key, label: chainLabel(key), trades: hist.get(key) ?? 0, scored: scoredOf(key) }))
    .sort((a, b) => b.trades - a.trades || a.label.localeCompare(b.label));
  // Gabungan semua chain di paling atas — pertanyaan pertama biasanya "totalnya berapa".
  const total = per.reduce((a, c) => a + c.trades, 0);
  return total > 0
    ? [{ key: ALL, label: 'All chains', trades: total, scored: scoredOf(undefined) }, ...per]
    : per;
}

/** Kunci semu untuk gabungan lintas chain. */
const ALL = 'all';

/**
 * Kurs USD tiap satuan buku. Stablecoin ≈ $1; native dihargai lewat wrapped-native
 * CHAIN-NYA SENDIRI (BNB pakai WBNB, HYPE pakai WHYPE) — memakai harga ETH untuk
 * semuanya pernah membuat nilai LP HyperEVM 30x lipat.
 */
async function usdRates(): Promise<Map<string, number | null>> {
  const m = new Map<string, number | null>();
  for (const cc of Object.values(CHAINS)) {
    for (const b of cc.bases) {
      const unit = journal.unitOf(cc.key, b.kind);
      if (m.has(unit)) continue;
      m.set(unit, b.kind === 'weth' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : 1);
    }
  }
  return m;
}

/** Baris tombol, 2 per baris. */
const rows2 = <T,>(items: T[], make: (x: T) => any) => {
  const out: any[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2).map(make));
  return out;
};

const chainKb = () =>
  Markup.inlineKeyboard([
    ...rows2(pnlChains(), (c) => Markup.button.callback(c.label, `pnlc:${c.key}`)),
    [Markup.button.callback('📜 History', 'history'), Markup.button.callback('📊 View Positions', 'positions')],
  ]);

const periodKb = (chain: string, active?: journal.PeriodKey) =>
  Markup.inlineKeyboard([
    ...rows2(Object.keys(journal.PERIODS) as journal.PeriodKey[], (k) =>
      Markup.button.callback(`${active === k ? '• ' : ''}${journal.PERIODS[k].label}`, `pnl:${chain}:${k}`),
    ),
    [Markup.button.callback('‹ Chains', 'pnlback'), Markup.button.callback('📜 History', 'history')],
  ]);

export function cmdPnl(ctx: any) {
  return ctx.reply(msg.msgPnlPicker(pnlChains()), { ...html, ...chainKb() });
}
bot.command('pnl', cmdPnl);

/**
 * Ganti isi kartu di tempat dengan TEKS.
 *
 * Kartu PnL adalah dokumen PNG — dokumen punya caption, bukan text, jadi
 * editMessageText padanya ditolak Telegram: "there is no text in the message to
 * edit". Itu yang terjadi saat menekan Back dari kartu gambar ke pemilih chain.
 * Kalau pesan yang ada tak bisa dijadikan teks, ganti utuh: hapus lalu kirim baru.
 */
const swap = async (ctx: any, text: string, extra: any) => {
  try {
    return await ctx.editMessageText(text, extra);
  } catch (e) {
    const m = (e as Error).message;
    if (/not modified/i.test(m)) return;
    if (!/no text in the message|message can't be edited|MESSAGE_ID_INVALID/i.test(m)) throw e;
    await ctx.deleteMessage().catch(() => {});
    return ctx.reply(text, extra);
  }
};

const n2 = (v: number, unit: string): string => {
  const d = unit === 'USDG' || unit === 'USDT' ? 2 : 5;
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)} ${unit}`;
};

/**
 * Kartu PnL sebagai GAMBAR — artwork yang sama dengan profit card saat close, jadi
 * rekap ini terbaca sebagai "momen" yang sepadan, bukan sekadar tabel teks.
 * Buku utama (paling banyak trade) jadi angka besar; buku lain masuk baris stats.
 */
async function pnlImage(chain: string, key: journal.PeriodKey, s: journal.PeriodStats): Promise<Buffer | null> {
  const main = s.books[0];
  if (!main) return null;
  const wr = journal.winrateOf(main);
  // Format kartu: TRADES / PROFIT / LOSS — gross-nya langsung terbaca dan kolomnya
  // pas tanpa menabrak artwork. Profit factor & rata-rata menang/kalah dipindah ke
  // caption + kartu teks, tempat yang memang muat.
  const stats: Array<{ label: string; value: string }> = [
    { label: 'trades', value: `${main.known} (${main.wins}W/${main.losses}L)` },
    { label: 'profit', value: n2(main.grossWin, main.unit) },
    { label: 'loss', value: n2(main.grossLoss, main.unit) },
  ];
  // Gambar ini cuma memuat SATU buku (yang paling banyak trade). Judulnya dulu
  // berbunyi "All chains · All Time" di atas angka yang sebenarnya hanya USDG —
  // terbaca sebagai total seluruh chain, padahal USDT & ETH tak ikut. Satuannya
  // kini disebut di judul, dan buku lain yang tak muat dihitung di kotak stats:
  // kartu ini paling sering di-screenshot, jadi ia harus berdiri sendiri.
  const lain = s.books.length - 1;
  if (lain > 0) stats.push({ label: 'other books', value: `${lain} (see caption)` });
  return renderProfitCard({
    pair: `${chain === ALL ? 'All chains' : chainLabel(chain)} · ${main.unit} · ${journal.PERIODS[key].label}`,
    positive: main.net >= 0,
    pnlBig: n2(main.net, main.unit),
    pnlPct: `${wr.toFixed(1)}% winrate`,
    stats,
    footerLeft: `${s.known} scored${s.books.reduce((n, b) => n + b.flats, 0) ? ` · ${s.books.reduce((n, b) => n + b.flats, 0)} flat` : ''} · ${new Date().toISOString().slice(0, 10)}`,
  }).catch(() => null);
}

/**
 * Jumlah semua buku dalam USD, atau null bila ADA satu saja kurs yang tak terbaca.
 * Setengah total lebih buruk daripada tak ada total: ia terbaca sebagai fakta.
 */
function usdTotalOf(s: journal.PeriodStats, rates: Map<string, number | null>): number | null {
  let t = 0;
  for (const b of s.books) {
    const r = rates.get(b.unit);
    if (r === null || r === undefined) return null;
    t += b.net * r;
  }
  return t;
}

/** Caption ringkas — detailnya sudah terbaca di gambar (batas caption 1024 char). */
function pnlCaption(chain: string, key: journal.PeriodKey, s: journal.PeriodStats, usdTotal?: number | null): string {
  const p = journal.PERIODS[key];
  const lines = [`📈 <b>PnL Recap</b> · <b>${chain === ALL ? 'All chains' : chainLabel(chain)}</b> · ${p.label}`, ''];
  if (s.books.length === 0) lines.push('<i>no closed trades with a measured result in this period.</i>');
  else
    for (const b of s.books)
      lines.push(
        `${b.net >= 0 ? '🟢' : '🔴'} <b>${b.unit}</b> ${n2(b.net, b.unit)} · ${b.known} trades · ` +
          `${journal.winrateOf(b).toFixed(1)}% WR${journal.profitFactorOf(b) === null ? '' : ` · PF ${journal.profitFactorOf(b)!.toFixed(2)}`}`,
      );
  if (usdTotal !== undefined && usdTotal !== null && s.books.length > 1)
    lines.push('', `<b>All books ≈ ${msg.usdPlain(usdTotal)}</b> <i>(books converted at current rates)</i>`);
  // Rekonsiliasi: jumlah entri jurnal HARUS bisa ditelusuri dari kartu ini.
  // Tanpa baris flat, selisih 728 vs 246 tak punya penjelasan di mana pun.
  const scored = s.books.reduce((a, b) => a + b.known, 0);
  const flats = s.books.reduce((a, b) => a + b.flats, 0);
  const tail: string[] = [`${s.count} closed → ${scored} scored`];
  if (flats) tail.push(`${flats} break-even`);
  if (s.untracked) tail.push(`${s.untracked} result unknown`);
  if (s.recovered) tail.push(`${s.recovered} sweep credited`);
  lines.push('', `<i>${tail.join(' · ')}</i>`);
  lines.push('', `<i>${config.safety.dryRun ? 'DRY RUN' : 'LIVE'}</i>`);
  return lines.join('\n');
}

/**
 * Tampilkan rekap. Kartunya adalah DOKUMEN PNG (bukan foto): Telegram mengompres
 * foto jadi JPEG dan artefaknya paling terlihat pada teks tajam di latar gelap —
 * persis isi kartu ini. Tombol periode meng-edit media+caption di tempat, jadi tetap
 * satu pesan. Gagal render → jatuh ke kartu teks, rekap tak boleh hilang.
 */
async function renderPnl(ctx: any, chain: string, key: journal.PeriodKey, fresh = false) {
  const p = journal.PERIODS[key];
  // chain === ALL → statsFor tanpa filter. Bukunya tetap dipisah per satuan, jadi
  // tak ada USDG yang dijumlahkan dengan ETH; yang digabung cuma cakupan chain-nya.
  // '1 Month' = 30 hari WIB PENUH, jadi angkanya tak bergeser tiap kartu dibuka;
  // 1d/1w tetap rolling, karena "1 hari terakhir" memang berarti 24 jam ke belakang.
  const since = p.ms === 0 ? 0 : key === '1m' ? journal.monthStartMs(30) : Date.now() - p.ms;
  const s = journal.statsFor(since, chain === ALL ? undefined : chain);
  const kb = periodKb(chain, key);
  const usdTotal = s.books.length > 1 ? usdTotalOf(s, await usdRates()) : null;
  const text = msg.msgPnl({
    dryRun: config.safety.dryRun,
    chainLabel: chain === ALL ? 'All chains' : chainLabel(chain),
    periodLabel: p.label,
    known: s.known,
    count: s.count,
    untracked: s.untracked,
    excluded: s.excluded,
    recovered: s.recovered,
    usdTotal,
    books: s.books,
  });
  const buf = await pnlImage(chain, key, s);
  if (!buf) return fresh ? ctx.reply(text, { ...html, ...kb }) : swap(ctx, text, { ...html, ...kb });

  const doc = Input.fromBuffer(buf, `philips-pnl-${chain}-${key}.png`);
  const caption = pnlCaption(chain, key, s, usdTotal);
  if (fresh) {
    // Pesan pemilih chain berupa TEKS — tak bisa di-edit jadi dokumen. Ganti utuh.
    await ctx.deleteMessage().catch(() => {});
    return ctx.replyWithDocument(doc, { caption, parse_mode: 'HTML', ...kb });
  }
  return ctx
    .editMessageMedia({ type: 'document', media: doc, caption, parse_mode: 'HTML' }, kb)
    .catch((e: Error) => {
      if (/not modified/i.test(e.message)) return;
      return swap(ctx, text, { ...html, ...kb }); // media tak bisa di-edit → teks saja
    });
}

// Kembali ke pemilih chain — EDIT kartu yang sama, jangan kirim pesan baru.
bot.action('pnlback', async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return swap(ctx, msg.msgPnlPicker(pnlChains()), { ...html, ...chainKb() });
});

// Langkah 1 → 2: chain dipilih, langsung tampilkan All Time (jawaban paling berguna).
bot.action(/^pnlc:([a-z0-9_-]+)$/i, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1], 'all', true);
});

bot.action(/^pnl:([a-z0-9_-]+):(1d|1w|1m|all)$/i, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1], ctx.match[2] as journal.PeriodKey);
});
