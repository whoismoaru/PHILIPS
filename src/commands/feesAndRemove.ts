import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, mapLimit, POS_CARD_CONCURRENCY } from '../core.js';
import { ctxOf } from '../chains.js';
import { getPositionDetail, collectFeesOnly, removeLiquidityPct } from '../uniswap.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';

/**
 * /claim_fees — panen fee tanpa menutup posisi.
 * /remove_lp  — tarik 25/50/75% (posisi tetap hidup) atau 100% (dialihkan ke
 *               jalur /stop yang sudah menangani burn + jurnal + cashout).
 */

// ---------- /claim_fees — panen fee tanpa menutup posisi ----------
/** Ringkas fee belum diklaim per posisi (dibaca on-chain via collect.staticCall). */
async function unclaimedList(): Promise<Array<{ rec: store.PosRecord; label: string; base: number }>> {
  const out = await mapLimit(store.active(), POS_CARD_CONCURRENCY, async (rec) => {
    try {
      const d = await getPositionDetail(rec.tokenId, ctxOf(rec));
      const amt = Number(ethers.formatUnits(d.feesBaseWei, d.baseDecimals));
      return { rec, label: `${amt.toFixed(d.baseDecimals >= 18 ? 5 : 2)} ${d.baseSymbol}`, base: amt };
    } catch {
      return null;
    }
  });
  return out.filter((x): x is { rec: store.PosRecord; label: string; base: number } => x !== null && x.base > 0);
}

async function cmdClaimFees(ctx: any) {
  const prog = await ctx.reply(msg.msgProgress('reading unclaimed fees…'), html);
  const list = await unclaimedList();
  if (!list.length) return editProgress(ctx, prog, msg.msgNoFees());
  const rows = list.map((x) => [
    Markup.button.callback(`💵 ${x.rec.symbol} · ${x.label}`, `claim:${x.rec.tokenId}`),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  await editProgress(
    ctx,
    prog,
    msg.msgClaimPick(list.map((x) => ({ symbol: x.rec.symbol, id: x.rec.tokenId, label: x.label }))),
    { ...html, ...Markup.inlineKeyboard(rows) },
  );
}
bot.command('claim_fees', cmdClaimFees);

const claiming = new Set<string>(); // anti double-tap: tx kedua menarik 0 & buang gas
bot.action(/^claim:(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  if (claiming.has(id)) return ctx.answerCbQuery('Processing…');
  const rec = store.active().find((r) => r.tokenId === id);
  if (!rec) return ctx.answerCbQuery('Position is no longer active.');
  claiming.add(id);
  await ctx.answerCbQuery();
  store.beginMoneyOp(); // sweep monitor tak boleh mengirim tx dari dompet yang sama
  try {
    const cc = ctxOf(rec);
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgClaimDone(id, '(dry run)', null), html);
      return;
    }
    const d = await getPositionDetail(id, cc);
    const res = await collectFeesOnly(id, cc);
    const baseRaw = d.baseIsToken0 ? res.amount0 : res.amount1;
    const otherRaw = d.baseIsToken0 ? res.amount1 : res.amount0;
    const label =
      `${Number(ethers.formatUnits(baseRaw, d.baseDecimals)).toFixed(d.baseDecimals >= 18 ? 5 : 2)} ${d.baseSymbol}` +
      (otherRaw > 0n ? ` + ${Number(ethers.formatUnits(otherRaw, d.otherDecimals)).toFixed(4)} ${d.otherSymbol}` : '');
    await ctx.editMessageText(msg.msgClaimDone(id, label, res.txHash), html);
  } catch (e) {
    await ctx.reply(msg.msgError('claim', (e as Error).message), html);
  } finally {
    claiming.delete(id);
    store.endMoneyOp();
  }
});

// ---------- /remove_lp — tarik sebagian / seluruh likuiditas ----------
async function cmdRemoveLp(ctx: any) {
  const active = store.active();
  if (!active.length) return ctx.reply(msg.msgNoActiveToStop(), html);
  const rows = active.map((r) => [
    Markup.button.callback(`${r.symbol} · #${r.tokenId}`, `rm:${r.tokenId}`),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  await ctx.reply(msg.msgRemovePick(active.map((r) => ({ symbol: r.symbol, id: r.tokenId }))), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('remove_lp', cmdRemoveLp);

bot.action(/^rm:(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgRemovePct(id), {
    ...html,
    ...Markup.inlineKeyboard([
      ...pctPresets.chunkButtons(pctPresets.get('stop').map((p) => Markup.button.callback(`${p}%`, `rmpct:${id}:${p}`))),
      [Markup.button.callback('100% (close position)', `stop:${id}`)],
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

bot.action(/^rmpct:(\d+):(\d+)$/, async (ctx) => {
  const [id, pct] = [ctx.match[1], Number(ctx.match[2])];
  await ctx.answerCbQuery();
  const rec = store.active().find((r) => r.tokenId === id);
  if (!rec) return ctx.editMessageText(msg.msgAlreadyClosed(id), html);
  let est = '—';
  try {
    const d = await getPositionDetail(id, ctxOf(rec));
    const v = Number(ethers.formatUnits(d.valueBaseWei, d.baseDecimals)) * (pct / 100);
    est = `≈ ${v.toFixed(d.baseDecimals >= 18 ? 5 : 2)} ${d.baseSymbol}`;
  } catch {
    /* estimasi opsional — jangan blokir penarikan hanya karena RPC baca gagal */
  }
  await ctx.editMessageText(msg.msgRemoveConfirm(id, rec.symbol, pct, est, config.safety.dryRun), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Withdraw', `rmok:${id}:${pct}`)],
      [Markup.button.callback('⬅️ Back', `rm:${id}`), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

const removing = new Set<string>();
bot.action(/^rmok:(\d+):(\d+)$/, async (ctx) => {
  const [id, pct] = [ctx.match[1], Number(ctx.match[2])];
  if (removing.has(id)) return ctx.answerCbQuery('Processing…');
  const rec = store.active().find((r) => r.tokenId === id);
  if (!rec) return ctx.answerCbQuery('Position is no longer active.');
  removing.add(id);
  await ctx.answerCbQuery();
  store.beginMoneyOp(); // idem: penarikan sebagian juga mengirim tx
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgRemoveDone(id, pct, null), html);
      return;
    }
    const { txHash } = await removeLiquidityPct(id, pct, ctxOf(rec));
    // Modal tercatat harus ikut menyusut. Tanpa ini sisa posisi dibandingkan dengan
    // modal PENUH: tarik 50% → kartu selamanya menampilkan −50%, dan alert rugi
    // bersih langsung menyala padahal dananya sudah ada di dompet.
    const kept = 100n - BigInt(pct);
    const keptWei = (BigInt(rec.initialWethWei || '0') * kept) / 100n;
    store.update(id, {
      initialWethWei: keptWei.toString(),
      ...(rec.nominalEth ? { nominalEth: String((Number(rec.nominalEth) * Number(kept)) / 100) } : {}),
      ilAlerted: false,
    });
    await ctx.editMessageText(msg.msgRemoveDone(id, pct, txHash), html);
  } catch (e) {
    await ctx.reply(msg.msgError('remove', (e as Error).message), html);
  } finally {
    removing.delete(id);
    store.endMoneyOp();
  }
});

