import { ethers } from 'ethers';
import { Markup } from 'telegraf';
import { bot, html } from '../core.js';
import { CHAINS, type ChainCtx } from '../chains.js';
import { bold, code, esc, note, nowWib } from '../messages.js';
import { stableFunds, xQuote, xExecute, gasChain, gasSpendable, type StableFund } from '../xchain.js';
import { getEthUsd } from '../screening.js';
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

/** Exported so the preview script can render it without a running bot. */
/** The gas pocket as the card shows it. Read by `show`, passed in so `render` stays pure. */
export type Pocket = { label: string; symbol: string; usd: number };

/** Below this the pocket is called out: every chain's gas is refilled from it. */
export const GAS_LOW_USD = 3;

export function render(
  funds: StableFund[],
  home: ChainCtx | undefined,
  pocket?: Pocket | null,
): { text: string; kb: any } {
  const total = funds.reduce((s, f) => s + f.usd, 0);
  const away = sweepable(funds, home?.chainId);
  const awayUsd = away.reduce((s, f) => s + f.usd, 0);

  const body: string[] = [
    funds.length ? `🏦 ${bold('Treasury')} · ${funds.length} balance${funds.length === 1 ? '' : 's'}` : `🏦 ${bold('Treasury')}`,
    '',
  ];

  if (funds.length === 0) {
    body.push('⚪ No stablecoin on any chain.', '', note('deposit USDC or USDT on one chain — buys and LPs pull it across by themselves.'));
  } else {
    // Monospace block so the dollar column lines up; no emoji inside <pre> (cell widths
    // differ and would break the alignment).
    const rows = funds.map((f) => {
      const chain = f.ctx.chainId === home?.chainId ? `${f.ctx.label} (home)` : f.ctx.label;
      return `${chain.padEnd(20).slice(0, 20)}${f.base.symbol.padEnd(7).slice(0, 7)}${fmtUsd(f.usd).padStart(11)}`;
    });
    body.push(`<pre>${esc(['chain'.padEnd(20) + 'stable'.padEnd(7) + 'usd'.padStart(11), ...rows].join('\n'))}</pre>`);
    body.push('', `💰 ${bold(`Total: ${fmtUsd(total)}`)}`);
  }

  // Gas is a separate pot on purpose (see fundGasFromPocket): it is never taken from the
  // stablecoins above, so it needs its own line or it would run dry unseen.
  if (pocket) {
    const low = pocket.usd < GAS_LOW_USD;
    body.push(
      '',
      `${low ? '🟡' : '⛽'} Gas pocket: ${bold(fmtUsd(pocket.usd))} ${esc(pocket.symbol)} on ${esc(pocket.label)}`,
    );
    if (low) body.push(note(`top up ${esc(pocket.symbol)} on ${esc(pocket.label)} — it pays gas on every chain.`));
  }

  if (!home) {
    body.push('', `⚠️ Home chain ${code(HOME_KEY)} is not configured — set ${code('TREASURY_CHAIN')} and restart.`);
  } else if (away.length) {
    body.push('', `🟡 ${fmtUsd(awayUsd)} sits off ${esc(home.label)} on ${away.length} chain${away.length === 1 ? '' : 's'}.`);
  } else if (funds.length) {
    body.push('', `🟢 All of it is on ${esc(home.label)}.`);
  }
  if (funds.some((f) => f.usd < MIN_SWEEP_USD)) {
    body.push(note(`under ${fmtUsd(MIN_SWEEP_USD)} per chain is left alone — a bridge would cost more than it moves.`));
  }
  body.push(note(`${config.safety.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));

  const rows: any[] = [];
  // Money action on its own row, and it names the amount at stake rather than asking
  // "are you sure?" about nothing.
  if (home && away.length) rows.push([Markup.button.callback(`♻️ Sweep ${fmtUsd(awayUsd)} → ${home.label}`, 'trsweep')]);
  rows.push([Markup.button.callback('🔄 Refresh', 'trshow'), Markup.button.callback('❌ Close', 'dismiss')]);
  return { text: body.join('\n'), kb: Markup.inlineKeyboard(rows) };
}

/** Spendable pocket balance in dollars; null when its native cannot be priced. */
async function readPocket(gc: ChainCtx): Promise<Pocket | null> {
  const [bal, usdPer] = await Promise.all([
    gc.provider.getBalance(gc.wallet.address).catch(() => null),
    getEthUsd(gc.wethAddress, gc).catch(() => null),
  ]);
  if (bal === null || !usdPer) return null;
  return { label: gc.label, symbol: gc.nativeSymbol, usd: Number(ethers.formatEther(gasSpendable(bal))) * usdPer };
}

async function show(ctx: any, edit: boolean) {
  const home = homeChain();
  const gc = gasChain();
  const [funds, pocket] = await Promise.all([stableFunds(0.01), readPocket(gc)]);
  const { text, kb } = render(funds, home, pocket);
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
    let landed = 0;
    // Chains are swept one at a time, not in parallel: each leg is a real bridge whose
    // arrival is waited on, and a failure part-way must leave the rest untouched and
    // reportable rather than firing five routes at once.
    for (const f of away) {
      try {
        await ctx
          .editMessageText(
            [`♻️ ${bold('Sweeping')} · ${done.length + failed.length + 1}/${away.length}`, '', `${esc(f.ctx.label)} — ${fmtUsd(f.usd)} ${esc(f.base.symbol)}`, '', note('waiting for the balance to land on the destination chain…')].join('\n'),
            html,
          )
          .catch(() => {});
        if (config.safety.dryRun) {
          done.push(`${f.ctx.label}: ${fmtUsd(f.usd)} (dry run)`);
          continue;
        }
        const q = await xQuote(f, home, homeBase.address, f.balWei);
        const minOut = (q.quote.outWei * 97n) / 100n;
        const r = await xExecute(q, home, homeBase.address, f.balWei, minOut);
        const got = Number(ethers.formatUnits(r.received, homeBase.decimals));
        landed += got;
        done.push(`${f.ctx.label}: ${fmtUsd(f.usd)} → ${fmtUsd(got)} ${homeBase.symbol} (${Math.round(r.waitedMs / 1000)}s)`);
      } catch (e) {
        failed.push(`${f.ctx.label}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
    // Header states the outcome in one glance: all home, or partly stuck.
    const head = failed.length === 0 ? `✅ ${bold('Sweep complete')}` : `🟡 ${bold('Sweep partly done')}`;
    const body = [head, ''];
    if (done.length) body.push(...done.map((l) => `✅ ${esc(l)}`));
    if (failed.length) body.push('', ...failed.map((l) => `❌ ${esc(l)}`));
    if (landed > 0) body.push('', `💰 ${bold(`Landed: ${fmtUsd(landed)} ${homeBase.symbol} on ${home.label}`)}`);
    if (failed.length) body.push('', note('the failed chains still hold their balance — tap Sweep again to retry just those.'));
    body.push(note('counted from the balance that actually arrived, not from the quote.'));
    body.push(note(`${config.safety.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
    await ctx.editMessageText(body.join('\n'), html);
    await show(ctx, false);
  } catch (e) {
    await ctx.reply(`❌ ${bold('Sweep failed')}\n\n${esc((e as Error).message)}`, html);
  } finally {
    sweeping.delete(uid);
  }
});
