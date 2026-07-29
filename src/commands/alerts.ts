import { Markup } from 'telegraf';
import { bot, html } from '../core.js';
import * as alerts from '../alerts.js';
import * as msg from '../messages.js';

/** /alerts — sakelar notifikasi (in/out range, harga anjlok, rugi bersih). */

// ---------- /alerts — setelan notifikasi ----------
const DROP_OPTIONS: Array<number | null> = [10, 15, 25, 40, null];
const IL_OPTIONS: Array<number | null> = [null, 5, 10, 20, 30];

function alertsKeyboard() {
  const a = alerts.get();
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${a.rangeNotify ? '🔔' : '🔕'} In/out range: ${a.rangeNotify ? 'ON' : 'OFF'}`, 'al:range')],
    [Markup.button.callback(`📉 Harga anjlok: ${a.dropPct === null ? 'OFF' : `-${a.dropPct}%`}`, 'al:drop')],
    [Markup.button.callback(`⚠️ Rugi bersih: ${a.ilPct === null ? 'OFF' : `-${a.ilPct}%`}`, 'al:il')],
  ]);
}

async function cmdAlerts(ctx: any) {
  return ctx.reply(msg.msgAlerts(alerts.get()), { ...html, ...alertsKeyboard() });
}
bot.command('alerts', cmdAlerts);

bot.action(/^al:(range|drop|il)$/, async (ctx) => {
  const a = alerts.get();
  if (ctx.match[1] === 'range') alerts.set({ rangeNotify: !a.rangeNotify });
  else if (ctx.match[1] === 'drop') alerts.set({ dropPct: alerts.cycle(a.dropPct, DROP_OPTIONS) });
  else alerts.set({ ilPct: alerts.cycle(a.ilPct, IL_OPTIONS) });
  await ctx.answerCbQuery('Tersimpan');
  await ctx.editMessageText(msg.msgAlerts(alerts.get()), { ...html, ...alertsKeyboard() }).catch(() => {});
});

