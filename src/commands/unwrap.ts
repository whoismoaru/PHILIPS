import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress } from '../core.js';
import { getChain, CHAINS, type ChainCtx } from '../chains.js';
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

/**
 * Semua chain yang punya wrapped-native NYANGKUT di atas ambang debu.
 *
 * Dulu perintah ini cuma melihat `getChain()` — chain yang sedang aktif. WBNB
 * nyangkut di BSC saat kamu sedang di Robinhood terbaca "tak ada yang perlu
 * di-unwrap", padahal ada. Sapuan otomatis monitor memang sudah melintasi semua
 * chain; jalur manualnya yang tertinggal.
 */
/** Label chain yang benar-benar diperiksa — dipakai kartu "tak ada yang nyangkut". */
const scannedChains = (): string[] =>
  Object.values(CHAINS).filter((cc) => cc.hasWethBase).map((cc) => cc.label);

async function stuckEverywhere(): Promise<Array<{ cc: ChainCtx; bal: bigint }>> {
  const found = await Promise.all(
    Object.values(CHAINS).map(async (cc) => {
      if (!cc.hasWethBase) return null;
      const bal: bigint = await cc.weth.balanceOf(cc.wallet.address).catch(() => 0n);
      return bal >= WETH_DUST ? { cc, bal } : null;
    }),
  );
  return found.filter((x): x is { cc: ChainCtx; bal: bigint } => x !== null);
}

async function cmdUnwrap(ctx: any) {
  const cc = getChain();
  const { wrapped, native } = symbolsOf(cc);
  const prog = await ctx.reply(msg.msgProgress('reading wrapped-native balances…'), html);
  let stuck: Awaited<ReturnType<typeof stuckEverywhere>>;
  try {
    stuck = await stuckEverywhere();
  } catch (e) {
    return editProgress(ctx, prog, msg.msgError('unwrap', (e as Error).message));
  }
  if (stuck.length === 0) {
    return editProgress(ctx, prog, msg.msgUnwrapNone(`${msg.fmtEth(WETH_DUST)} ${wrapped}`, wrapped, native, scannedChains()));
  }
  const one = stuck.length === 1 ? stuck[0] : null;
  const eu = one ? await getEthUsd(one.cc.wethAddress, one.cc).catch(() => null) : null;
  const amt = one ? Number(ethers.formatEther(one.bal)) : 0;
  const s1 = one ? symbolsOf(one.cc) : { wrapped, native };
  return editProgress(
    ctx,
    prog,
    msg.msgUnwrapConfirm(
      one ? `${msg.fmtEth(one.bal)} ${s1.wrapped}` : '',
      eu !== null ? msg.usdPlain(amt * eu) : null,
      config.safety.dryRun,
      s1.wrapped,
      s1.native,
      stuck.map((x) => ({ label: x.cc.label, amount: `${msg.fmtEth(x.bal)} ${symbolsOf(x.cc).wrapped}` })),
    ),
    {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(one ? `🔄 Unwrap All to ${s1.native}` : `🔄 Unwrap All (${stuck.length} chains)`, 'unwrap:go')],
        [Markup.button.callback('❌ Cancel', 'cancel')],
      ]),
    },
  );
}
bot.command('unwrap', cmdUnwrap);

bot.action('unwrap:go', async (ctx) => {
  const { wrapped, native } = symbolsOf(getChain());
  // Satu tx per chain, jadi kunci anti double-tap juga per chain.
  // Saldo dibaca ULANG di sini: kartu konfirmasi bisa saja sudah lama, dan
  // withdraw() dengan angka basi = revert + gas hangus.
  const stuck = (await stuckEverywhere().catch(() => [])).filter((x) => !unwrapping.has(x.cc.key));
  if (stuck.length === 0) {
    await ctx.answerCbQuery('Processing…');
    return void (await ctx.editMessageText(msg.msgUnwrapNone(`${msg.fmtEth(WETH_DUST)} ${wrapped}`, wrapped, native, scannedChains()), html));
  }
  for (const x of stuck) unwrapping.add(x.cc.key);
  // Monitor tak boleh ikut menyapu wrapped-native yang sama di tengah tx ini
  // (tabrakan nonce).
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) {
      const total = stuck.reduce((a, x) => a + x.bal, 0n);
      return void (await ctx.editMessageText(msg.msgUnwrapDone(msg.fmtEth(total), null, wrapped, native), html));
    }
    const done: string[] = [];
    const failed: string[] = [];
    let lastHash: string | null = null;
    let total = 0n;
    for (const { cc, bal } of stuck) {
      const s = symbolsOf(cc);
      await ctx.editMessageText(msg.msgProgress(`unwrapping ${s.wrapped} → ${s.native} (${cc.label})…`), html).catch(() => {});
      try {
        const tx = await cc.weth.withdraw(bal);
        const rc = await tx.wait();
        lastHash = rc?.hash ?? tx.hash;
        total += bal;
        done.push(`${cc.label}: ${msg.fmtEth(bal)} ${s.wrapped}`);
        console.log(`[unwrap] ${ethers.formatEther(bal)} ${s.wrapped} → ${s.native} (${cc.key}) tx ${lastHash}`);
      } catch (e) {
        // Satu chain gagal TIDAK boleh membatalkan sisanya — dananya terpisah.
        failed.push(`${cc.label}: ${(e as Error).message.slice(0, 80)}`);
        console.log(`[unwrap] ${cc.key} gagal: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    if (done.length) {
      await ctx.editMessageText(msg.msgUnwrapDone(msg.fmtEth(total), lastHash, wrapped, native), html);
    }
    if (failed.length) {
      await ctx.reply(msg.msgError('unwrap', failed.join('\n')), html);
    }
  } catch (e) {
    await ctx.reply(msg.msgError('unwrap', (e as Error).message), html);
  } finally {
    for (const x of stuck) unwrapping.delete(x.cc.key);
    store.endMoneyOp();
  }
});
