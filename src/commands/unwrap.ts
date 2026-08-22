import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress } from '../core.js';
import { getChain } from '../chains.js';
import { getEthUsd } from '../screening.js';
import * as store from '../store.js';
import * as msg from '../messages.js';

/**
 * /unwrap — kembalikan WETH nyangkut ke ETH native, on demand.
 *
 * Monitor sudah menyapu WETH otomatis, tapi cuma tiap 1 menit dan hanya saat
 * tak ada operasi uang berjalan — jadi tepat setelah close/open yang separuh
 * gagal, saldonya nongkrong sebagai WETH sampai sapuan berikutnya. Ini jalur
 * manualnya: baca saldo, konfirmasi, satu tx withdraw().
 */

// Sama dengan ambang debu monitor: di bawah ini gas unwrap > nilainya.
const WETH_DUST = 10_000_000_000_000n; // 0.00001 WETH

const unwrapping = new Set<string>(); // anti double-tap: tx kedua unwrap 0 & buang gas

/** Simbol wrapped & native chain ini (WETH/ETH, WBNB/BNB). */
const symbolsOf = (cc: ReturnType<typeof getChain>) => ({
  wrapped: cc.bases.find((b) => b.kind === 'weth')?.symbol ?? 'WETH',
  native: cc.nativeSymbol,
});

async function cmdUnwrap(ctx: any) {
  const cc = getChain();
  const { wrapped, native } = symbolsOf(cc);
  const prog = await ctx.reply(msg.msgProgress('reading WETH balance…'), html);
  let bal: bigint;
  try {
    bal = await cc.weth.balanceOf(cc.wallet.address);
  } catch (e) {
    return editProgress(ctx, prog, msg.msgError('unwrap', (e as Error).message));
  }
  if (bal < WETH_DUST) {
    return editProgress(ctx, prog, msg.msgUnwrapNone(`${msg.fmtEth(WETH_DUST)} ${wrapped}`, wrapped, native));
  }
  const eu = await getEthUsd(cc.wethAddress, cc).catch(() => null);
  const amt = Number(ethers.formatEther(bal));
  return editProgress(
    ctx,
    prog,
    msg.msgUnwrapConfirm(`${msg.fmtEth(bal)} ${wrapped}`, eu !== null ? msg.usdPlain(amt * eu) : null, config.safety.dryRun, wrapped, native),
    {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`🔄 Unwrap All to ${native}`, 'unwrap:go')],
        [Markup.button.callback('❌ Cancel', 'cancel')],
      ]),
    },
  );
}
bot.command('unwrap', cmdUnwrap);

bot.action('unwrap:go', async (ctx) => {
  const cc = getChain();
  const { wrapped, native } = symbolsOf(cc);
  const key = cc.key;
  if (unwrapping.has(key)) return ctx.answerCbQuery('Processing…');
  unwrapping.add(key);
  // Monitor tak boleh ikut menyapu WETH yang sama di tengah tx ini (tabrakan nonce).
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    // Saldo dibaca ULANG di sini: kartu konfirmasi bisa saja sudah lama, dan
    // withdraw() dengan angka basi = revert + gas hangus.
    const bal: bigint = await cc.weth.balanceOf(cc.wallet.address);
    if (bal < WETH_DUST) {
      return void (await ctx.editMessageText(msg.msgUnwrapNone(`${msg.fmtEth(WETH_DUST)} ${wrapped}`, wrapped, native), html));
    }
    if (config.safety.dryRun) {
      return void (await ctx.editMessageText(msg.msgUnwrapDone(msg.fmtEth(bal), null, wrapped, native), html));
    }
    await ctx.editMessageText(msg.msgProgress(`unwrapping ${wrapped} → ${native}…`), html).catch(() => {});
    const tx = await cc.weth.withdraw(bal);
    const rc = await tx.wait();
    console.log(`[unwrap] ${ethers.formatEther(bal)} WETH → ETH (${cc.key}) tx ${rc?.hash}`);
    await ctx.editMessageText(msg.msgUnwrapDone(msg.fmtEth(bal), rc?.hash ?? null, wrapped, native), html);
  } catch (e) {
    await ctx.reply(msg.msgError('unwrap', (e as Error).message), html);
  } finally {
    unwrapping.delete(key);
    store.endMoneyOp();
  }
});
