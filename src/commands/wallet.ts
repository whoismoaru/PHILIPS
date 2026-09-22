import { Markup, Input } from 'telegraf';
import { rmSync, writeFileSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
import { config } from '../config.js';
import { bot, html, editProgress, maxEthLabel, registerFlowReset, startKeyboard, startCard } from '../core.js';
import { getChain, rebuildChains, gasFeeCapLabel, CHAINS } from '../chains.js';
import * as walletStore from '../walletStore.js';
import * as solWallet from '../solana/walletStore.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';
import { BG_CUSTOM, customBackground, invalidateBackground, renderProfitCard } from '../card.js';

/**
 * The wallet: /settings, with connect and disconnect as buttons on its card.
 * `awaitingSecret` and `handleSecret` are exported because the text handler in index.ts has
 * to give this flow precedence before its stray-secret detector runs.
 */

// ---------- /settings: the wallet, connected and disconnected by button ----------
export const awaitingSecret = new Set<number>();

export function cmdConnect(ctx: any) {
  if (walletStore.isConnected()) return ctx.reply(msg.msgAlreadyConnected(walletStore.address()!), html);
  awaitingSecret.add(ctx.from.id);
  return ctx.reply(msg.msgConnectPrompt(), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Connection', 'connect:cancel')]]),
  });
}
bot.action('connect', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdConnect(ctx);
});
bot.action('connect:cancel', async (ctx) => {
  awaitingSecret.delete(ctx.from!.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText(msg.msgCancelled(), html);
});

/** Called by the text handler when a key is pasted during the connect flow. */
export async function handleSecret(ctx: any, raw: string): Promise<void> {
  awaitingSecret.delete(ctx.from.id);
  // Delete FIRST, then process: the key must not sit in the chat for even a moment.
  await ctx.deleteMessage().catch(() => {});
  const prog = await ctx.reply(msg.msgConnectImporting(), html);
  try {
    const addr = walletStore.connect(raw);
    rebuildChains(); // the old contracts still hold a VoidSigner
    await editProgress(ctx, prog, msg.msgConnected(addr), html);
    // Then the same card /start shows, with the same grid -- a fresh connect lands the
    // user exactly where a returning one does, instead of on a three-button stub.
    await ctx.reply(startCard(), { ...html, ...startKeyboard() });
  } catch (e) {
    await editProgress(ctx, prog, msg.msgConnectFailed((e as Error).message));
  }
}

/**
 * The Solana key, connected separately from the EVM one.
 *
 * A parallel flow, deliberately not a branch inside the EVM one: the two keys are different
 * curves from different wallets, and one prompt that accepts either would make a mis-paste
 * silently connect the wrong chain.
 */
export const awaitingSolSecret = new Set<number>();

export function cmdConnectSol(ctx: any) {
  if (solWallet.isConnected()) return ctx.reply(msg.msgAlreadyConnected(solWallet.address()!), html);
  awaitingSolSecret.add(ctx.from.id);
  return ctx.reply(msg.msgConnectSolPrompt(), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Connection', 'connectsol:cancel')]]),
  });
}
bot.command('connect_sol', cmdConnectSol);
bot.action('connectsol', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdConnectSol(ctx);
});
bot.action('connectsol:cancel', async (ctx) => {
  awaitingSolSecret.delete(ctx.from!.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText(msg.msgCancelled(), html);
});

/** Called by the text handler when a Solana key is pasted during that flow. */
export async function handleSolSecret(ctx: any, raw: string): Promise<void> {
  awaitingSolSecret.delete(ctx.from.id);
  // Delete FIRST, then process: the key must not sit in the chat for even a moment.
  await ctx.deleteMessage().catch(() => {});
  const prog = await ctx.reply(msg.msgConnectImporting(), html);
  try {
    const addr = solWallet.connect(raw);
    await editProgress(ctx, prog, msg.msgConnected(addr), html);
    await ctx.reply(startCard(), { ...html, ...startKeyboard() });
  } catch (e) {
    // keys.ts never puts the pasted value in its errors; this message is safe to show.
    await editProgress(ctx, prog, msg.msgConnectFailed((e as Error).message));
  }
}

bot.action('disconnectsol', async (ctx: any) => {
  solWallet.disconnect();
  await ctx.answerCbQuery('Solana wallet disconnected');
  await ctx.deleteMessage().catch(() => {});
  return cmdSettings(ctx);
});

export async function cmdSettings(ctx: any) {
  const addr = walletStore.address();
  const cc = getChain();
  const rows: any[] = [];
  // The "Adjust Slippage" button from the design is deliberately absent: slippage is still
  // a constant in the code, so the button would open a card that changes nothing. Add it
  // once the value can really be stored and used by the swap path.
  const gasCeil = gasFeeCapLabel() ? `${gasFeeCapLabel()} ${cc.nativeSymbol}` : null;
  // Each flow's percentages are editable from here. They used to be hardcoded, so in
  // practice they could never be adjusted without an edit and a restart.
  // Labels follow the flows as they are now named. "Withdraw %" used to sit on pct:stop,
  // which is the share of an LP you close -- a different thing from a withdrawal to an
  // address, and the two shared one word.
  rows.push([
    Markup.button.callback('🛒 Buy %', 'pct:buy'),
    Markup.button.callback('💱 Swap %', 'pct:sell'),
  ]);
  rows.push([
    Markup.button.callback('➕ Add LP %', 'pct:add'),
    Markup.button.callback('⛔ Close LP %', 'pct:stop'),
  ]);
  rows.push([
    Markup.button.callback('🌉 Bridge %', 'pct:bridge'),
    Markup.button.callback('📤 Withdraw %', 'pct:send'),
  ]);
  // The LP shape is a one-off choice, so it lives here rather than being asked on every
  // deposit. The label carries the current value -- a toggle that does not say what it is
  // set to makes you tap it to find out.
  const sh = pctPresets.shape();
  rows.push([
    Markup.button.callback(`${sh === 'bidask' ? '◣' : '▬'} LP shape: ${sh === 'bidask' ? 'BID-ASK' : 'SPOT'}`, 'lpshape'),
    Markup.button.callback('🪜 Ladder legs', 'pct:legs'),
  ]);
  // The PnL card's backdrop. The label says which one is in use, so the state is visible
  // without opening anything.
  rows.push([
    Markup.button.callback(`🖼 PnL background: ${customBackground() ? 'custom' : 'default'}`, 'pnlbg'),
  ]);
  if (addr) rows.push([Markup.button.callback('🔴 Disconnect Wallet', 'disconnect')]);
  else rows.push([Markup.button.callback('🔗 Connect Wallet', 'connect')]);
  // Its own row and its own pair of actions: disconnecting one chain must never take the
  // other's key with it.
  rows.push([
    solWallet.isConnected()
      ? Markup.button.callback('🔴 Disconnect SOL Wallet', 'disconnectsol')
      : Markup.button.callback('🔗 Connect SOL Wallet', 'connectsol'),
  ]);
  rows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  return ctx.reply(msg.msgSettings(config.safety.dryRun, maxEthLabel, gasCeil, pctPresets.shape()), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('settings', cmdSettings);

// One tap flips it; the card redraws so the new value is visible immediately.
bot.action('lpshape', async (ctx: any) => {
  const next = pctPresets.shape() === 'bidask' ? 'spot' : 'bidask';
  pctPresets.setShape(next);
  await ctx.answerCbQuery(next === 'bidask' ? 'Bid-ask ladder' : 'Single spot position');
  await ctx.deleteMessage().catch(() => {});
  return cmdSettings(ctx);
});

// ---------- the PnL card's backdrop, set by sending a photo ----------
/** Owners waiting to send their backdrop. The photo handler in index.ts checks this. */
export const awaitingBg = new Set<number>();

bot.action('pnlbg', async (ctx: any) => {
  awaitingBg.add(ctx.from.id);
  await ctx.answerCbQuery();
  const rows = [
    ...(customBackground() ? [[Markup.button.callback('♻️ Restore the default', 'pnlbg:reset')]] : []),
    [Markup.button.callback('❌ Cancel', 'pnlbg:cancel')],
  ];
  return ctx.reply(msg.msgPnlBgPrompt(customBackground()), { ...html, ...Markup.inlineKeyboard(rows) });
});

bot.action('pnlbg:cancel', async (ctx: any) => {
  awaitingBg.delete(ctx.from.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText(msg.msgCancelled(), html);
});

bot.action('pnlbg:reset', async (ctx: any) => {
  awaitingBg.delete(ctx.from.id);
  rmSync(BG_CUSTOM, { force: true });
  invalidateBackground();
  await ctx.answerCbQuery('Default restored');
  await ctx.editMessageText(msg.msgPnlBgReset(), html);
});

/**
 * Store a photo sent during the flow as the PnL backdrop.
 *
 * Telegram is asked for the LARGEST size it kept: the card renders at 2400x1260 and a
 * thumbnail stretched over that is the one outcome nobody wants. The file is written only
 * after it decodes, so a broken download can never replace a working backdrop.
 */
export async function handleBgPhoto(ctx: any, fileId: string): Promise<void> {
  awaitingBg.delete(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('saving the backdrop…'), html);
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.href ?? String(link));
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Decode BEFORE writing: an unreadable file saved here would break every PnL card
    // until someone noticed and reset it.
    await loadImage(buf);
    writeFileSync(BG_CUSTOM, buf);
    invalidateBackground();
    await editProgress(ctx, prog, msg.msgPnlBgSaved(), html);
    // A preview, rendered from the real card, so the choice is judged on the thing
    // itself rather than on a promise that it will look fine.
    const png = await renderProfitCard({
      label: 'PnL Preview', positive: null, pnlBig: '+$0.00', pnlPct: 'no decided trade yet',
      stats: [
        { label: 'realized', value: '+$0.00' }, { label: 'unrealized', value: '—' },
        { label: 'closed', value: '0 (0W/0L)' }, { label: 'biggest win', value: '—' },
      ],
      footerLeft: `preview · ${msg.dateWibFull()}`,
    }).catch(() => null);
    if (png) await ctx.replyWithDocument(Input.fromBuffer(png, 'pnl-preview.png'));
  } catch (e) {
    await editProgress(ctx, prog, msg.msgError('background', (e as Error).message), html);
  }
}

// Any command cancels a percentage prompt left hanging -- otherwise the next amount typed
// is swallowed as an answer to it. awaitingSecret is cleared here too: without that, the
// generic Cancel button (and anything else calling resetFlows) left the connect prompt
// waiting, even though its branch is checked first in the text handler.
registerFlowReset((uid) => {
  pctPresets.clearEdit(uid);
  awaitingSecret.delete(uid);
  awaitingBg.delete(uid);
});

/** One flow's unit, limits and special notes, shared by all three settings cards. */
function pctOpts(flow: pctPresets.PctFlow) {
  const b = pctPresets.boundsFor(flow);
  return {
    unit: pctPresets.unitFor(flow),
    min: b.min,
    max: b.max,
    noteLine:
      flow === 'stop'
        ? '100% is not allowed here. Withdrawing everything closes the position, which has its own button.'
        : flow === 'legs'
          ? 'More legs means a smoother ladder but more RPC calls. Above 15 you want a paid endpoint.'
          : undefined,
  };
}

/** One flow's card: the current value plus buttons to change it or restore the defaults. */
function pctCardKb(flow: pctPresets.PctFlow) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Edit', `pctedit:${flow}`), Markup.button.callback('↩️ Reset', `pctreset:${flow}`)],
    [Markup.button.callback('⬅️ Back', 'settings')],
  ]);
}

bot.action(/^pct:(buy|sell|add|stop|bridge|legs|send)$/, async (ctx) => {
  const flow = ctx.match[1] as pctPresets.PctFlow;
  // Going back from the prompt means abandoning it. Without this the marker persists and
  // swallows the next text message, whichever flow it belonged to.
  pctPresets.clearEdit(ctx.from!.id);
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    msg.msgPctPreset(pctPresets.FLOW_LABEL[flow], pctPresets.get(flow), pctPresets.defaultsFor(flow), pctOpts(flow)),
    { ...html, ...pctCardKb(flow) },
  );
});

bot.action(/^pctedit:(buy|sell|add|stop|bridge|legs|send)$/, async (ctx) => {
  const flow = ctx.match[1] as pctPresets.PctFlow;
  pctPresets.askEdit(ctx.from!.id, flow);
  await ctx.answerCbQuery();
  return ctx.editMessageText(msg.msgPctAsk(pctPresets.FLOW_LABEL[flow], pctPresets.get(flow), pctOpts(flow)), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `pct:${flow}`)]]),
  });
});

bot.action(/^pctreset:(buy|sell|add|stop|bridge|legs|send)$/, async (ctx) => {
  const flow = ctx.match[1] as pctPresets.PctFlow;
  pctPresets.clearEdit(ctx.from!.id);
  const v = pctPresets.reset(flow);
  await ctx.answerCbQuery('Reset');
  return ctx.editMessageText(
    msg.msgPctPreset(pctPresets.FLOW_LABEL[flow], v, pctPresets.defaultsFor(flow), pctOpts(flow)),
    { ...html, ...pctCardKb(flow) },
  );
});

/**
 * Accepts a typed list of percentages. Called from the main text handler BEFORE the amount
 * flows, so "25 50 75" is not read as an amount.
 * @returns true when this message really was an answer to the percentage prompt.
 */
export async function handlePctReply(ctx: any, raw: string): Promise<boolean> {
  const flow = pctPresets.pendingEdit(ctx.from?.id);
  if (!flow) return false;
  const nums = pctPresets.parseList(raw);
  const saved = nums ? pctPresets.set(flow, nums) : null;
  if (!saved) {
    await ctx.reply(msg.msgPctInvalid(pctOpts(flow)), html);
    return true; // still handled here: never fall through to the amount flow
  }
  pctPresets.clearEdit(ctx.from.id);
  await ctx.reply(
    msg.msgPctPreset(pctPresets.FLOW_LABEL[flow], saved, pctPresets.defaultsFor(flow), pctOpts(flow)),
    { ...html, ...pctCardKb(flow) },
  );
  return true;
}
bot.action('settings', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdSettings(ctx);
});

async function cmdDisconnect(ctx: any) {
  if (!walletStore.isConnected()) return ctx.reply(msg.msgNeedWallet(), html);
  const openLp = store.active().length;
  return ctx.reply(msg.msgDisconnectConfirm(walletStore.address()!, openLp), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, Disconnect & Delete Key', 'disconnect:ok')],
      [Markup.button.callback('❌ No, Stay Connected', 'cancel')],
    ]),
  });
}
bot.action('disconnect', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdDisconnect(ctx);
});
bot.action('disconnect:ok', async (ctx) => {
  await ctx.answerCbQuery();
  walletStore.disconnect();
  rebuildChains();
  await ctx.editMessageText(msg.msgDisconnected(walletStore.envKeyRefused()), html);
});

