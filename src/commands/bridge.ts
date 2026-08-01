import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, parseAmt, isStaleFlow, registerFlowReset } from '../core.js';
import { CHAINS, getChain, type ChainCtx } from '../chains.js';
import { getBridgeQuote, executeBridge } from '../relay.js';
import * as store from '../store.js';
import * as msg from '../messages.js';

/**
 * /bridge — pindahkan dana NATIVE antar chain lewat Relay.
 *
 * Jalur uang paling tak bisa dibatalkan di bot ini: begitu terkirim, dana ada di
 * chain lain dan hanya bridge lain yang bisa membawanya kembali. Karena itu:
 *  - arah dipilih eksplisit (tak ada default yang bisa salah tap),
 *  - quote DIMINTA ULANG saat konfirmasi, dengan lantai minimum dari angka yang
 *    benar-benar dilihat user (relay.executeBridge),
 *  - sesi kedaluwarsa dan kunci in-flight seperti alur uang lain.
 */

// Quote bridge cepat basi; di atas ini kartu wajib dibuat ulang.
const QUOTE_TTL_MS = 120_000;
/** Sisa gas yang tak boleh ikut dikirim (bridge dibayar di chain asal). */
const GAS_RESERVE_WEI = ethers.parseEther('0.0005');

type BridgeFlow = {
  fromKey: string;
  toKey: string;
  awaitingAmount?: boolean;
  amountWei?: bigint;
  minOutWei?: bigint;
  inLabel?: string;
  outLabel?: string;
  quotedAt?: number;
  startedAt: number;
};
const flows = new Map<number, BridgeFlow>();
const inFlight = new Set<number>();
registerFlowReset((uid) => flows.delete(uid));

/** Semua pasangan arah antar chain aktif. Satu chain = tak ada yang bisa dijembatani. */
function routes(): Array<{ from: ChainCtx; to: ChainCtx }> {
  const list = Object.values(CHAINS);
  const out: Array<{ from: ChainCtx; to: ChainCtx }> = [];
  for (const from of list) for (const to of list) if (from.key !== to.key) out.push({ from, to });
  return out;
}

async function cmdBridge(ctx: any) {
  const rs = routes();
  if (rs.length === 0) return ctx.reply(msg.msgBridgeUnavailable(), html);
  flows.delete(ctx.from.id);
  const rows = rs.map((r) => [
    Markup.button.callback(`${r.from.label} → ${r.to.label}`, `br:${r.from.key}:${r.to.key}`),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  return ctx.reply(msg.msgBridgePick(rs.map((r) => ({ from: r.from.label, to: r.to.label }))), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('bridge', cmdBridge);

bot.action(/^br:(\w+):(\w+)$/, async (ctx) => {
  const [fromKey, toKey] = [ctx.match[1], ctx.match[2]];
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];
  if (!from || !to) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  flows.set(ctx.from!.id, { fromKey, toKey, awaitingAmount: true, startedAt: Date.now() });
  const bal = await from.provider
    .getBalance(from.wallet.address)
    .then((b) => `${Number(ethers.formatEther(b)).toFixed(6)} ${from.nativeSymbol}`)
    .catch(() => '?');
  await ctx.editMessageText(msg.msgBridgeAmount(from.label, to.label, bal, from.nativeSymbol), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'br:back')], [Markup.button.callback('❌ Cancel', 'cancel')]]),
  });
});

bot.action('br:back', async (ctx) => {
  await ctx.answerCbQuery();
  flows.delete(ctx.from!.id);
  return cmdBridge(ctx);
});

/** Ketikan nominal → quote + kartu konfirmasi. Dipanggil handler teks index.ts. */
export async function handleBridgeAmount(ctx: any, raw: string): Promise<boolean> {
  const flow = flows.get(ctx.from.id);
  if (!flow?.awaitingAmount) return false;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const from = CHAINS[flow.fromKey];
  const to = CHAINS[flow.toKey];
  const wei = parseAmt(raw, 18);
  if (wei === null) {
    await ctx.reply(msg.msgInvalidAmount(), html);
    return true;
  }
  const prog = await ctx.reply(msg.msgProgress('requesting bridge quote…'), html);
  try {
    const bal: bigint = await from.provider.getBalance(from.wallet.address);
    // Gas dibayar di chain ASAL. Mengirim seluruh saldo membuat tx-nya sendiri gagal
    // — lebih baik ditolak di sini daripada gas hangus tanpa dana berpindah.
    if (wei + GAS_RESERVE_WEI > bal) {
      await editProgress(
        ctx,
        prog,
        msg.msgError(
          'bridge',
          `Amount plus gas exceeds your balance (${ethers.formatEther(bal)} ${from.nativeSymbol}). Leave ~${ethers.formatEther(GAS_RESERVE_WEI)} for gas.`,
        ),
      );
      return true;
    }
    const q = await getBridgeQuote(from, to, wei);
    flow.awaitingAmount = false;
    flow.amountWei = wei;
    // Lantai minimum = hasil yang BENAR-BENAR dilihat user, dikurangi toleransi 1%.
    flow.minOutWei = (q.outWei * 99n) / 100n;
    flow.inLabel = q.inLabel;
    flow.outLabel = q.outLabel;
    flow.quotedAt = Date.now();
    await editProgress(
      ctx,
      prog,
      msg.msgBridgeConfirm({
        fromLabel: from.label,
        toLabel: to.label,
        inLabel: q.inLabel,
        outLabel: q.outLabel,
        impactPct: q.impactPct,
        feeUsd: q.feeUsd,
        etaSec: q.etaSec,
        dryRun: config.safety.dryRun,
      }),
      {
        ...html,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Bridge', 'br:go')],
          [Markup.button.callback('⬅️ Back', `br:${flow.fromKey}:${flow.toKey}`), Markup.button.callback('❌ Cancel', 'cancel')],
        ]),
      },
    );
  } catch (e) {
    await editProgress(ctx, prog, msg.msgError('bridge', (e as Error).message));
  }
  return true;
}

bot.action('br:go', async (ctx) => {
  const uid = ctx.from!.id;
  const flow = flows.get(uid);
  if (!flow?.amountWei || flow.minOutWei === undefined) return ctx.answerCbQuery('Expired — start again with /bridge.');
  if (Date.now() - (flow.quotedAt ?? 0) > QUOTE_TTL_MS) {
    flows.delete(uid);
    await ctx.answerCbQuery('Quote expired.');
    return ctx.reply(msg.msgError('bridge', 'The quote is older than 2 minutes — run /bridge again for fresh numbers.'), html);
  }
  if (inFlight.has(uid)) return ctx.answerCbQuery('Processing…');
  inFlight.add(uid);
  const { fromKey, toKey, amountWei, minOutWei, inLabel, outLabel } = flow;
  flows.delete(uid); // idempotency: hapus SEBELUM eksekusi (double-tap tak bridge dobel)
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(
        msg.msgBridgeDone({ fromLabel: from.label, toLabel: to.label, inLabel: inLabel!, outLabel: outLabel!, txHashes: [], dryRun: true }),
        html,
      );
      return;
    }
    await ctx.editMessageText(msg.msgProgress(`bridging ${from.label} → ${to.label}…`), html).catch(() => {});
    const r = await executeBridge(from, to, amountWei!, minOutWei!);
    console.log(`[bridge] ${from.key}→${to.key} ${inLabel} → ${outLabel} tx ${r.txHashes.join(',')}`);
    await ctx.editMessageText(
      msg.msgBridgeDone({
        fromLabel: from.label,
        toLabel: to.label,
        inLabel: inLabel!,
        outLabel: `${Number(ethers.formatEther(r.outWei)).toFixed(6)} ${to.nativeSymbol}`,
        txHashes: r.txHashes,
        dryRun: false,
      }),
      html,
    );
  } catch (e) {
    await ctx.reply(msg.msgError('bridge', (e as Error).message), html);
  } finally {
    inFlight.delete(uid);
    store.endMoneyOp();
  }
});
