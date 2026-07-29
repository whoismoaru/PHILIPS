import { Markup } from 'telegraf';
import { config } from '../config.js';
import { bot, html, editProgress, maxEthLabel } from '../core.js';
import { getChain, rebuildChains } from '../chains.js';
import * as walletStore from '../walletStore.js';
import * as store from '../store.js';
import * as msg from '../messages.js';

/**
 * Perintah dompet: /connect /settings /disconnect.
 * `awaitingSecret` & `handleSecret` diekspor karena handler teks di index.ts
 * harus mendahulukan alur ini sebelum detektor rahasia-nyasar bekerja.
 */

// ---------- /connect /settings /disconnect — dompet ----------
export const awaitingSecret = new Set<number>();

function cmdConnect(ctx: any) {
  if (walletStore.isConnected()) return ctx.reply(msg.msgAlreadyConnected(walletStore.address()!), html);
  awaitingSecret.add(ctx.from.id);
  return ctx.reply(msg.msgConnectPrompt(), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batalkan Koneksi', 'connect:cancel')]]),
  });
}
bot.command('connect', cmdConnect);
bot.action('connect', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdConnect(ctx);
});
bot.action('connect:cancel', async (ctx) => {
  awaitingSecret.delete(ctx.from!.id);
  await ctx.answerCbQuery('Dibatalkan');
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
        [Markup.button.callback('💧 Buka LP', 'howto:add'), Markup.button.callback('📋 Posisi', 'positions')],
        [Markup.button.callback('⚙️ Pengaturan', 'settings')],
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
  if (addr) rows.push([Markup.button.callback('🔴 Putuskan Dompet', 'disconnect')]);
  else rows.push([Markup.button.callback('🔗 Hubungkan Dompet', 'connect')]);
  return ctx.reply(msg.msgSettings(addr, bal, cc.label, config.safety.dryRun, maxEthLabel), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('settings', cmdSettings);
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
      [Markup.button.callback('✅ Ya, Putuskan & Hapus Data', 'disconnect:ok')],
      [Markup.button.callback('❌ Tidak, Tetap Terhubung', 'cancel')],
    ]),
  });
}
bot.command('disconnect', cmdDisconnect);
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

