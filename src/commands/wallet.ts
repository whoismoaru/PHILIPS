import { Markup } from 'telegraf';
import { config } from '../config.js';
import { bot, html, editProgress, maxEthLabel } from '../core.js';
import { getChain, rebuildChains, gasFeeCapLabel } from '../chains.js';
import * as walletStore from '../walletStore.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';

/**
 * Dompet: /settings (hubungkan & putuskan lewat tombol di kartunya).
 * `awaitingSecret` & `handleSecret` diekspor karena handler teks di index.ts
 * harus mendahulukan alur ini sebelum detektor rahasia-nyasar bekerja.
 */

// ---------- /settings — dompet (connect & disconnect = tombol) ----------
export const awaitingSecret = new Set<number>();

function cmdConnect(ctx: any) {
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

/** Dipanggil dari handler teks saat user menempel kunci di alur /connect. */
export async function handleSecret(ctx: any, raw: string): Promise<void> {
  awaitingSecret.delete(ctx.from.id);
  // Hapus DULU, baru proses: kunci tak boleh nongkrong di chat semenit pun.
  await ctx.deleteMessage().catch(() => {});
  const prog = await ctx.reply(msg.msgConnectImporting(), html);
  try {
    const addr = walletStore.connect(raw);
    rebuildChains(); // kontrak lama masih memegang VoidSigner
    await editProgress(ctx, prog, msg.msgConnected(addr), {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💧 Add Liquidity', 'howto:add')],
        [Markup.button.callback('📊 View Positions', 'positions')],
        [Markup.button.callback('⚙️ Settings', 'settings')],
      ]),
    });
  } catch (e) {
    await editProgress(ctx, prog, msg.msgConnectFailed((e as Error).message));
  }
}

async function cmdSettings(ctx: any) {
  const addr = walletStore.address();
  const cc = getChain();
  const bal = addr ? await cc.provider.getBalance(addr).then((b) => `${msg.cleanUnits(b, 18)} ETH`).catch(() => '?') : null;
  const rows: any[] = [];
  // Tombol "Adjust Slippage" dari naskah sengaja TIDAK dipasang: slippage masih
  // konstanta di kode, jadi tombolnya cuma akan membuka kartu yang tak mengubah apa
  // pun. Pasang setelah nilainya benar-benar bisa disimpan & dipakai jalur swap.
  const gasCeil = gasFeeCapLabel() ? `${gasFeeCapLabel()} ${cc.nativeSymbol}` : null;
  // Angka persen tiap alur bisa diubah dari sini — dulu dipatok di kode, jadi
  // praktis tak pernah bisa disesuaikan tanpa edit + restart.
  rows.push([
    Markup.button.callback('🛒 Buy %', 'pct:buy'),
    Markup.button.callback('📉 Sell %', 'pct:sell'),
  ]);
  rows.push([
    Markup.button.callback('➕ Add LP %', 'pct:add'),
    Markup.button.callback('🗑️ Withdraw %', 'pct:stop'),
  ]);
  rows.push([Markup.button.callback('🌉 Bridge %', 'pct:bridge')]);
  if (addr) rows.push([Markup.button.callback('🔴 Disconnect Wallet', 'disconnect')]);
  else rows.push([Markup.button.callback('🔗 Connect Wallet', 'connect')]);
  rows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  return ctx.reply(msg.msgSettings(addr, bal, cc.label, config.safety.dryRun, maxEthLabel, gasCeil, pctPresets.all()), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('settings', cmdSettings);

/** Kartu satu alur: nilai sekarang + tombol ubah / kembalikan ke bawaan. */
function pctCardKb(flow: pctPresets.PctFlow) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Edit', `pctedit:${flow}`), Markup.button.callback('↩️ Reset', `pctreset:${flow}`)],
    [Markup.button.callback('⬅️ Back', 'settings')],
  ]);
}

bot.action(/^pct:(buy|sell|add|stop|bridge)$/, async (ctx) => {
  const flow = ctx.match[1] as pctPresets.PctFlow;
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    msg.msgPctPreset(pctPresets.FLOW_LABEL[flow], pctPresets.get(flow), pctPresets.defaultsFor(flow), flow === 'stop'),
    { ...html, ...pctCardKb(flow) },
  );
});

bot.action(/^pctedit:(buy|sell|add|stop|bridge)$/, async (ctx) => {
  const flow = ctx.match[1] as pctPresets.PctFlow;
  pctPresets.askEdit(ctx.from!.id, flow);
  await ctx.answerCbQuery();
  return ctx.editMessageText(msg.msgPctAsk(pctPresets.FLOW_LABEL[flow], pctPresets.get(flow), flow === 'stop'), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `pct:${flow}`)]]),
  });
});

bot.action(/^pctreset:(buy|sell|add|stop|bridge)$/, async (ctx) => {
  const flow = ctx.match[1] as pctPresets.PctFlow;
  pctPresets.clearEdit(ctx.from!.id);
  const v = pctPresets.reset(flow);
  await ctx.answerCbQuery('Reset');
  return ctx.editMessageText(
    msg.msgPctPreset(pctPresets.FLOW_LABEL[flow], v, pctPresets.defaultsFor(flow), flow === 'stop'),
    { ...html, ...pctCardKb(flow) },
  );
});

/**
 * Menerima daftar persen yang diketik user. Dipanggil dari penangan teks utama
 * (index.ts) SEBELUM alur nominal, supaya "25 50 75" tak terbaca sebagai nominal.
 * @returns true bila pesan ini memang jawaban untuk prompt persen.
 */
export async function handlePctReply(ctx: any, raw: string): Promise<boolean> {
  const flow = pctPresets.pendingEdit(ctx.from?.id);
  if (!flow) return false;
  const nums = pctPresets.parseList(raw);
  const saved = nums ? pctPresets.set(flow, nums) : null;
  if (!saved) {
    await ctx.reply(msg.msgPctInvalid(flow === 'stop'), html);
    return true; // tetap ditangani: jangan jatuh ke alur nominal
  }
  pctPresets.clearEdit(ctx.from.id);
  await ctx.reply(
    msg.msgPctPreset(pctPresets.FLOW_LABEL[flow], saved, pctPresets.defaultsFor(flow), flow === 'stop'),
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
  await ctx.editMessageText(msg.msgDisconnected(), html);
});

