import { ethers } from 'ethers';
import { Markup } from 'telegraf';
import { bot, html } from '../core.js';
import { CHAINS, type ChainCtx } from '../chains.js';
import { bold, esc, note } from '../messages.js';
import { stableFunds, xQuote, xExecute, type StableFund } from '../xchain.js';
import { config } from '../config.js';

/**
 * /treasury — every dollar the wallet holds as a stablecoin, on every chain, plus a
 * one-tap sweep of all of it back to a single home chain.
 *
 * This is the exit half of cross-chain trading: entries scatter capital onto whichever
 * chain the token lived on, and without a way back the balance ends up stranded in
 * five places. Selling already returns each position to its own chain's base asset;
 * this brings those remainders home.
 */

/** Which chain the treasury lives on. Base by default — deepest stablecoin liquidity. */
const HOME_KEY = process.env.TREASURY_CHAIN ?? 'base';
const homeChain = (): ChainCtx | undefined => CHAINS[HOME_KEY];

/** Dust is not worth a bridge: below this the fee eats more than it moves. */
const MIN_SWEEP_USD = 5;

/**
 * The funds a sweep may actually move: off the home chain, and worth more than the
 * bridge. Exported because getting it wrong is expensive in both directions -- including
 * the home chain would bridge money to itself, and dropping the dust floor would spend
 * more on fees than it recovers.
 */
export const sweepable = (funds: StableFund[], homeChainId?: number): StableFund[] =>
  funds.filter((f) => f.ctx.chainId !== homeChainId && f.usd >= MIN_SWEEP_USD);

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function render(funds: StableFund[], home: ChainCtx | undefined): { text: string; kb: any } {
  const total = funds.reduce((s, f) => s + f.usd, 0);
  const away = sweepable(funds, home?.chainId);
  const body: string[] = [`🏦 ${bold('Treasury')}`, ''];
  if (funds.length === 0) {
    body.push('No stablecoin balance on any chain.');
  } else {
    for (const f of funds) {
      const here = f.ctx.chainId === home?.chainId ? ' ← home' : '';
      body.push(`• ${bold(fmtUsd(f.usd))} ${esc(f.base.symbol)} · ${esc(f.ctx.label)}${here}`);
    }
    body.push('', `${bold('Total:')} ${fmtUsd(total)}`);
  }
  if (!home) {
    body.push('', `⚠️ Home chain ${esc(HOME_KEY)} is not configured — set TREASURY_CHAIN.`);
  } else if (away.length) {
    const awayUsd = away.reduce((s, f) => s + f.usd, 0);
    body.push('', note(`${fmtUsd(awayUsd)} sits off ${home.label} on ${away.length} chain(s) and can be swept home.`));
  }
  body.push(note(`balances below ${fmtUsd(MIN_SWEEP_USD)} are left alone — a bridge would cost more than it moves.`));
  const kb =
    home && away.length
      ? Markup.inlineKeyboard([
          [Markup.button.callback(`🏦 Sweep ${fmtUsd(away.reduce((s, f) => s + f.usd, 0))} → ${home.label}`, 'trsweep')],
          [Markup.button.callback('🔄 Refresh', 'trshow'), Markup.button.callback('❌ Close', 'cancel')],
        ])
      : Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'trshow'), Markup.button.callback('❌ Close', 'cancel')]]);
  return { text: body.join('\n'), kb };
}

async function show(ctx: any, edit: boolean) {
  const home = homeChain();
  const funds = await stableFunds(0.01);
  const { text, kb } = render(funds, home);
  const extra = { ...html, ...kb };
  return edit ? ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra)) : ctx.reply(text, extra);
}

bot.command('treasury', (ctx) => show(ctx, false));
bot.action('trshow', async (ctx) => {
  await ctx.answerCbQuery();
  return show(ctx, true);
});

const sweeping = new Set<number>();

bot.action('trsweep', async (ctx) => {
  const uid = ctx.from!.id;
  const home = homeChain();
  if (!home) return ctx.answerCbQuery('No home chain configured.');
  if (sweeping.has(uid)) return ctx.answerCbQuery('Sweeping…');
  sweeping.add(uid);
  await ctx.answerCbQuery('Sweeping…');
  try {
    const homeBase = home.bases.find((b) => !b.wrappable);
    if (!homeBase) throw new Error(`${home.label} has no stablecoin to sweep into.`);
    const away = sweepable(await stableFunds(MIN_SWEEP_USD), home.chainId);
    if (away.length === 0) return void (await show(ctx, true));

    const done: string[] = [];
    const failed: string[] = [];
    // Chains are swept one at a time, not in parallel: each leg is a real bridge whose
    // arrival is waited on, and a failure part-way must leave the rest untouched and
    // reportable rather than firing five routes at once.
    for (const f of away) {
      try {
        await ctx.editMessageText(`🏦 ${bold('Sweeping')}\n\n${esc(f.ctx.label)} · ${fmtUsd(f.usd)} ${esc(f.base.symbol)}…`, html);
        if (config.safety.dryRun) {
          done.push(`${f.ctx.label}: ${fmtUsd(f.usd)} (dry run)`);
          continue;
        }
        const q = await xQuote(f, home, homeBase.address, f.balWei);
        const minOut = (q.quote.outWei * 97n) / 100n;
        const r = await xExecute(q, home, homeBase.address, f.balWei, minOut);
        const got = Number(ethers.formatUnits(r.received, homeBase.decimals));
        done.push(`${f.ctx.label}: ${fmtUsd(f.usd)} → ${fmtUsd(got)} ${homeBase.symbol} (${Math.round(r.waitedMs / 1000)}s)`);
      } catch (e) {
        failed.push(`${f.ctx.label}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
    const body = [`🏦 ${bold('Sweep complete')}`, ''];
    if (done.length) body.push(...done.map((l) => `✅ ${esc(l)}`));
    if (failed.length) body.push('', ...failed.map((l) => `❌ ${esc(l)}`));
    body.push('', note('funds are counted from the balance that actually arrived, not from the quote.'));
    await ctx.editMessageText(body.join('\n'), html);
    await show(ctx, false);
  } catch (e) {
    await ctx.reply(`❌ ${bold('Sweep failed')}\n\n${esc((e as Error).message)}`, html);
  } finally {
    sweeping.delete(uid);
  }
});
