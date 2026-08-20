import { Markup } from 'telegraf';
import { config } from '../config.js';
import { bot, html } from '../core.js';
import { CHAINS } from '../chains.js';
import * as journal from '../journal.js';
import * as msg from '../messages.js';

/** /history & /pnl — pembacaan jurnal trade tertutup. Nol RPC, nol state. */

export function cmdHistory(ctx: any) {
  const total = journal.statsFor(0).count;
  const items = journal.read(8).map((e) => ({
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

/** Chain yang ditawarkan = yang aktif sekarang + yang punya riwayat di jurnal. */
function pnlChains(): Array<{ key: string; label: string; trades: number }> {
  const hist = new Map(journal.chainsWithHistory().map((c) => [c.key, c.trades]));
  const keys = new Set<string>([...Object.keys(CHAINS), ...hist.keys()]);
  return [...keys]
    .map((key) => ({ key, label: chainLabel(key), trades: hist.get(key) ?? 0 }))
    .sort((a, b) => b.trades - a.trades || a.label.localeCompare(b.label));
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
  const chains = pnlChains().map((c) => ({ label: c.label, trades: c.trades }));
  return ctx.reply(msg.msgPnlPicker(chains), { ...html, ...chainKb() });
}
bot.command('pnl', cmdPnl);

/** Ganti isi kartu di tempat; "not modified" bukan error. */
const swap = (ctx: any, text: string, extra: any) =>
  ctx.editMessageText(text, extra).catch((e: Error) => {
    if (!/not modified/i.test(e.message)) throw e;
  });

async function renderPnl(ctx: any, chain: string, key: journal.PeriodKey) {
  const p = journal.PERIODS[key];
  const s = journal.statsFor(p.ms === 0 ? 0 : Date.now() - p.ms, chain);
  return swap(
    ctx,
    msg.msgPnl({
      dryRun: config.safety.dryRun,
      chainLabel: chainLabel(chain),
      periodLabel: p.label,
      known: s.known,
      count: s.count,
      untracked: s.untracked,
      excluded: s.excluded,
      books: s.books,
    }),
    { ...html, ...periodKb(chain, key) },
  );
}

// Kembali ke pemilih chain — EDIT kartu yang sama, jangan kirim pesan baru.
bot.action('pnlback', async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  const chains = pnlChains().map((c) => ({ label: c.label, trades: c.trades }));
  return swap(ctx, msg.msgPnlPicker(chains), { ...html, ...chainKb() });
});

// Langkah 1 → 2: chain dipilih, langsung tampilkan All Time (jawaban paling berguna).
bot.action(/^pnlc:([a-z0-9_-]+)$/i, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1], 'all');
});

bot.action(/^pnl:([a-z0-9_-]+):(1d|1w|1m|all)$/i, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1], ctx.match[2] as journal.PeriodKey);
});
