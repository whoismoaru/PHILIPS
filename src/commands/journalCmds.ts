import { Markup } from 'telegraf';
import { config } from '../config.js';
import { bot, html } from '../core.js';
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

// /pnl — pilih periode dulu (bubble), baru rekapnya. Rekap dipisah per denominasi.
const periodKb = (active?: journal.PeriodKey) =>
  Markup.inlineKeyboard([
    (['1d', '1w'] as journal.PeriodKey[]).map((k) =>
      Markup.button.callback(`${active === k ? '• ' : ''}${journal.PERIODS[k].label}`, `pnl:${k}`),
    ),
    (['1m', 'all'] as journal.PeriodKey[]).map((k) =>
      Markup.button.callback(`${active === k ? '• ' : ''}${journal.PERIODS[k].label}`, `pnl:${k}`),
    ),
    [Markup.button.callback('📜 History', 'history'), Markup.button.callback('📊 View Positions', 'positions')],
  ]);

export function cmdPnl(ctx: any) {
  return ctx.reply(msg.msgPnlPicker(), { ...html, ...periodKb() });
}
bot.command('pnl', cmdPnl);

/** Render rekap satu periode. edit=true → ganti isi kartu picker (bukan kirim baru). */
async function renderPnl(ctx: any, key: journal.PeriodKey, edit: boolean) {
  const p = journal.PERIODS[key];
  const s = journal.statsFor(p.ms === 0 ? 0 : Date.now() - p.ms);
  const text = msg.msgPnl({
    dryRun: config.safety.dryRun,
    periodLabel: p.label,
    known: s.known,
    count: s.count,
    untracked: s.untracked,
    excluded: s.excluded,
    books: s.books,
  });
  const extra = { ...html, ...periodKb(key) };
  if (!edit) return ctx.reply(text, extra);
  // "not modified" saat menekan periode yang sama = bukan error.
  return ctx.editMessageText(text, extra).catch((e: Error) => {
    if (!/not modified/i.test(e.message)) throw e;
  });
}

bot.action(/^pnl:(1d|1w|1m|all)$/, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1] as journal.PeriodKey, true);
});
