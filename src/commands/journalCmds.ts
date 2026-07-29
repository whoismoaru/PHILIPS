import { Markup } from 'telegraf';
import { config } from '../config.js';
import { bot, html } from '../core.js';
import * as journal from '../journal.js';
import * as msg from '../messages.js';

/** /history & /pnl — pembacaan jurnal trade tertutup. Nol RPC, nol state. */

export function cmdHistory(ctx: any) {
  const total = journal.lifetimeStats().count;
  const items = journal.read(8).map((e) => ({
    tokenId: e.tokenId,
    symbol: e.symbol,
    pnlPct: e.pnlPct,
    pnlEth: e.pnlEth,
    reason: e.reason,
    ca: e.ca,
    chain: e.chain,
    closedAt: e.closedAt,
  }));
  return ctx.reply(msg.msgJournal(items, total), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('🧾 Rekap PnL', 'pnl'), Markup.button.callback('📋 Posisi', 'positions')]]),
  });
}
bot.command('history', cmdHistory);

// /pnl — rekap PnL seumur hidup (agregasi jurnal).
export function cmdPnl(ctx: any) {
  const s = journal.lifetimeStats();
  return ctx.reply(
    msg.msgPnl({
      dryRun: config.safety.dryRun,
      known: s.known,
      excluded: s.excluded,
      wins: s.wins,
      losses: s.losses,
      netEth: s.netEth,
      grossWin: s.grossWin,
      grossLoss: s.grossLoss,
      best: s.best,
      worst: s.worst,
      count: s.count,
    }),
    {
      ...html,
      ...Markup.inlineKeyboard([[Markup.button.callback('📜 Riwayat', 'history'), Markup.button.callback('📋 Posisi', 'positions')]]),
    },
  );
}
bot.command('pnl', cmdPnl);


