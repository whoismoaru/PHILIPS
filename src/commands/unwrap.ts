import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress } from '../core.js';
import { getChain, CHAINS, type ChainCtx } from '../chains.js';
import { getEthUsd } from '../screening.js';
import * as store from '../store.js';
import * as msg from '../messages.js';

/**
 * /unwrap -- turn stuck wrapped native back into native, on demand.
 *
 * The monitor already sweeps it automatically, but only once a minute and only while no
 * money operation is running -- so right after a half-failed open or close, the balance
 * sits as wrapped native until the next sweep. This is the manual path: read the balance,
 * confirm, one withdraw() transaction.
 */

// The same dust threshold the monitor uses: below this, unwrapping costs more than it returns.
const WETH_DUST = 10_000_000_000_000n; // 0.00001 WETH

const unwrapping = new Set<string>(); // anti double-tap: tx kedua unwrap 0 & buang gas

/** This chain's wrapped and native symbols (WETH/ETH, WBNB/BNB). */
const symbolsOf = (cc: ReturnType<typeof getChain>) => ({
  wrapped: cc.bases.find((b) => b.kind === 'weth')?.symbol ?? 'WETH',
  native: cc.nativeSymbol,
});

/**
 * Every chain holding stuck wrapped native above the dust threshold.
 *
 * This command used to look only at `getChain()`, the active chain. WBNB stuck on BSC while
 * you were pointed at Robinhood read as "nothing to unwrap" when there plainly was. The
 * monitor's automatic sweep already crossed every chain; it was the manual path that had
 * been left behind.
 */
/** The chains actually checked, named by the "nothing stuck" card. */
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

export async function cmdUnwrap(ctx: any) {
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
  // One transaction per chain, so the double-tap lock is per chain too. The balance is read
  // AGAIN here: the confirmation card may be old, and withdraw() on a stale figure reverts
  // and burns the gas.
  const stuck = (await stuckEverywhere().catch(() => [])).filter((x) => !unwrapping.has(x.cc.key));
  if (stuck.length === 0) {
    await ctx.answerCbQuery('Processing…');
    return void (await ctx.editMessageText(msg.msgUnwrapNone(`${msg.fmtEth(WETH_DUST)} ${wrapped}`, wrapped, native, scannedChains()), html));
  }
  for (const x of stuck) unwrapping.add(x.cc.key);
  // The monitor must not sweep the same wrapped native in the middle of this transaction:
  // they would collide on the nonce.
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
        // One chain failing must not cancel the rest: the money is separate.
        failed.push(`${cc.label}: ${(e as Error).message.slice(0, 80)}`);
        console.log(`[unwrap] ${cc.key} failed: ${(e as Error).message.slice(0, 120)}`);
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
