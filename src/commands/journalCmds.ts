import { Markup, Input } from 'telegraf';
import { config } from '../config.js';
import { bot, html } from '../core.js';
import { CHAINS } from '../chains.js';
import { getEthUsd } from '../screening.js';
import { renderProfitCard } from '../card.js';
import * as journal from '../journal.js';
import * as msg from '../messages.js';

/** /history and /pnl — reads of the closed-trade journal. No RPC, no state. */

export function cmdHistory(ctx: any) {
  const total = journal.statsFor(0).count;
  const items = journal.readMine(8).map((e) => ({
    tokenId: e.tokenId,
    symbol: e.symbol,
    pnlPct: e.pnlPct,
    pnlEth: e.pnlEth,
    reason: e.reason,
    ca: e.ca,
    chain: e.chain,
    baseKind: e.baseKind,
    closedAt: e.closedAt,
  }));
  return ctx.reply(msg.msgJournal(items, total), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('🧾 PnL Recap', 'pnl'), Markup.button.callback('📊 View Positions', 'positions')]]),
  });
}

// /pnl runs in two steps: pick a CHAIN first, then a PERIOD. The recap itself
// still splits by denomination, because one chain can carry two bases (Robinhood:
// ETH and USDG; BSC: BNB and USDT).

/** Display name for a chain: from config when it is enabled, otherwise its key. */
const chainLabel = (key: string): string =>
  CHAINS[key]?.label ?? key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Chains on offer = the ones enabled now, plus any with history in the journal.
 *
 * Two numbers, not one. `trades` counts positions; `scored` counts the ones that
 * actually reach W/L. The gap is wide because most of the rest are break-even
 * under +/-$0.1, alongside a handful with unreadable results and a few sweeps.
 * The picker used to show only the first while calling them "closed trades", and
 * the recap card two taps later showed the second under the same word — as if
 * hundreds of trades went missing between two screens.
 */
async function pnlChains(): Promise<Array<{ key: string; label: string; trades: number; scored: number }>> {
  const hist = new Map(journal.chainsWithHistory().map((c) => [c.key, c.trades]));
  const keys = new Set<string>([...Object.keys(CHAINS), ...hist.keys()]);
  // The SAME rates the card uses. Without this the picker values in native units
  // while the card values in USD, so their dust thresholds differ and the two
  // screens report different "scored" counts for identical data (Robinhood: 174
  // against 175).
  const rates = await usdRates();
  const usd = (u: string) => rates.get(u) ?? null;
  // POSITIONS, not journal entries: an 8-leg ladder is one position. Counting
  // entries here would have the picker promise 724 trades that never appear on
  // any card.
  const statOf = (key?: string) => {
    const st = journal.statsFor(0, key, usd);
    return { trades: st.positions, scored: st.books.reduce((a, b) => a + b.known, 0) };
  };
  const per = [...keys]
    .filter((key) => (hist.get(key) ?? 0) > 0 || key in CHAINS)
    .map((key) => ({ key, label: chainLabel(key), ...statOf(key) }))
    .sort((a, b) => b.trades - a.trades || a.label.localeCompare(b.label));
  // All chains combined sits on top: the first question is usually "what's the total".
  const all = statOf(undefined);
  return all.trades > 0 ? [{ key: ALL, label: 'All chains', ...all }, ...per] : per;
}

/** Pseudo-key for the cross-chain total. */
const ALL = 'all';

/**
 * USD rate per book unit. Stablecoins are ~$1; a native asset is priced through
 * ITS OWN chain's wrapped native (BNB via WBNB, HYPE via WHYPE). Pricing
 * everything with the ETH rate once inflated HyperEVM LP value 30-fold.
 */
async function usdRates(): Promise<Map<string, number | null>> {
  const m = new Map<string, number | null>();
  for (const cc of Object.values(CHAINS)) {
    for (const b of cc.bases) {
      const unit = journal.unitOf(cc.key, b.kind);
      if (m.has(unit)) continue;
      m.set(unit, b.kind === 'weth' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : 1);
    }
  }
  return m;
}

/** Button rows, two per row. */
const rows2 = <T,>(items: T[], make: (x: T) => any) => {
  const out: any[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2).map(make));
  return out;
};

const chainKb = (chains: Awaited<ReturnType<typeof pnlChains>>) =>
  Markup.inlineKeyboard([
    // Same order as the card: chains first, the All-chains total last.
    ...rows2(chains.filter((c) => c.key !== ALL), (c) => Markup.button.callback(c.label, `pnlc:${c.key}`)),
    ...(chains.some((c) => c.key === ALL) ? [[Markup.button.callback('All chains', `pnlc:${ALL}`)]] : []),
    // Same callback the other cards use, so every route to the menu lands on one card.
    [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
  ]);

const periodKb = (chain: string, active?: journal.PeriodKey) =>
  Markup.inlineKeyboard([
    ...rows2(Object.keys(journal.PERIODS) as journal.PeriodKey[], (k) =>
      Markup.button.callback(`${active === k ? '• ' : ''}${journal.PERIODS[k].label}`, `pnl:${chain}:${k}`),
    ),
    [Markup.button.callback('⬅️ Back', 'pnlback')],
  ]);

export async function cmdPnl(ctx: any) {
  const chains = await pnlChains();
  return ctx.reply(msg.msgPnlPicker(chains), { ...html, ...chainKb(chains) });
}
bot.command('pnl', cmdPnl);

/**
 * Replace a card's contents in place with TEXT.
 *
 * The PnL card is a PNG document, and documents carry a caption rather than text,
 * so Telegram refuses editMessageText on one: "there is no text in the message to
 * edit". That is what happened tapping Back from the image card to the chain
 * picker. When the existing message cannot become text, replace it outright:
 * delete, then send anew.
 */
const swap = async (ctx: any, text: string, extra: any) => {
  try {
    return await ctx.editMessageText(text, extra);
  } catch (e) {
    const m = (e as Error).message;
    if (/not modified/i.test(m)) return;
    if (!/no text in the message|message can't be edited|MESSAGE_ID_INVALID/i.test(m)) throw e;
    await ctx.deleteMessage().catch(() => {});
    return ctx.reply(text, extra);
  }
};

// Every recap figure is in dollars (see usdRates below), so it is printed as one --
// the unit suffix used to make a converted ETH book look like it was still ETH.
const n2 = (v: number, _unit: string): string =>
  `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The PnL card as an IMAGE — the same artwork as the profit card on close, so a
 * recap reads as an event of equal weight rather than a plain table. The main
 * book (most trades) becomes the headline figure; the rest go in the stats row.
 */
async function pnlImage(chain: string, key: journal.PeriodKey, s: journal.PeriodStats): Promise<Buffer | null> {
  const main = s.books[0];
  if (!main) return null;
  const wr = journal.winrateOf(main);
  // Card layout: TRADES / PROFIT / LOSS. The gross figures read at a glance and
  // the columns fit without colliding with the artwork. Profit factor and average
  // win/loss moved to the caption and text card, where there is room.
  const stats: Array<{ label: string; value: string }> = [
    { label: 'trades', value: `${main.known} (${main.wins}W/${main.losses}L)` }, // positions, not legs
    { label: 'profit', value: n2(main.grossWin, main.unit) },
    { label: 'loss', value: n2(main.grossLoss, main.unit) },
  ];
  // Everything is one USD book now, so this image covers the WHOLE period with no
  // other book left outside the frame. It used to read "All chains" above figures
  // that were really just USDG.
  return renderProfitCard({
    pair: `${chain === ALL ? 'All chains' : chainLabel(chain)} · ${journal.PERIODS[key].label}`,
    positive: main.net >= 0,
    pnlBig: n2(main.net, main.unit),
    pnlPct: `${wr.toFixed(1)}% winrate`,
    stats,
    footerLeft: `${s.known} of ${s.positions} positions scored${
      s.books.reduce((n, b) => n + b.flats, 0) ? ` · ${s.books.reduce((n, b) => n + b.flats, 0)} flat` : ''
    } · ${new Date().toISOString().slice(0, 10)}`,
  }).catch(() => null);
}

/** A short caption; the detail is already legible in the image (1024-char limit). */
function pnlCaption(chain: string, key: journal.PeriodKey, s: journal.PeriodStats): string {
  // Same card as the text fallback, on purpose: the caption used to carry its own
  // layout and its own rounding, so the image and the text disagreed on the totals.
  const main = s.books[0];
  return msg.msgPnl({
    dryRun: config.safety.dryRun,
    chainLabel: chain === ALL ? 'All chains' : chainLabel(chain),
    periodLabel: journal.PERIODS[key].label,
    trades: main?.known ?? 0,
    grossWin: main?.grossWin ?? 0,
    grossLoss: main?.grossLoss ?? 0,
    winratePct: main ? journal.winrateOf(main) : 0,
    empty: !main,
  });
}

/**
 * Render the recap. The card is sent as a PNG DOCUMENT, not a photo: Telegram
 * re-encodes photos as JPEG and the artefacts show worst on crisp text over a dark
 * background, which is exactly what this card is. Period buttons edit the media
 * and caption in place, so it stays one message. If rendering fails it falls back
 * to the text card — the recap must never just disappear.
 */
async function renderPnl(ctx: any, chain: string, key: journal.PeriodKey, fresh = false) {
  const p = journal.PERIODS[key];
  // chain === ALL means statsFor runs unfiltered. Books still split by unit, so no
  // USDG is ever added to ETH; only the chain coverage is combined. '1 Month' means
  // 30 WHOLE WIB days, so the figure does not drift each time the card opens; 1d and
  // 1w stay rolling, because "the last day" really does mean the last 24 hours.
  const since = p.ms === 0 ? 0 : key === '1m' ? journal.monthStartMs(30) : Date.now() - p.ms;
  // EVERY recap figure in USD (owner's call). Per-denomination books still exist
  // in storage; only the displayed unit changes. Without this the card hands over
  // four numbers in four units that cannot be compared with each other.
  const rates = await usdRates();
  const s = journal.statsFor(since, chain === ALL ? undefined : chain, (u) => rates.get(u) ?? null);
  const kb = periodKb(chain, key);
  // One USD book covers everything now, so the card reads off books[0] alone.
  const main = s.books[0];
  const text = msg.msgPnl({
    dryRun: config.safety.dryRun,
    chainLabel: chain === ALL ? 'All chains' : chainLabel(chain),
    periodLabel: p.label,
    trades: main?.known ?? 0,
    grossWin: main?.grossWin ?? 0,
    grossLoss: main?.grossLoss ?? 0,
    winratePct: main ? journal.winrateOf(main) : 0,
    empty: !main,
  });
  const buf = await pnlImage(chain, key, s);
  if (!buf) return fresh ? ctx.reply(text, { ...html, ...kb }) : swap(ctx, text, { ...html, ...kb });

  const doc = Input.fromBuffer(buf, `philips-pnl-${chain}-${key}.png`);
  const caption = pnlCaption(chain, key, s);
  if (fresh) {
    // The chain picker is a TEXT message and cannot be edited into a document.
    // Replace it outright.
    await ctx.deleteMessage().catch(() => {});
    return ctx.replyWithDocument(doc, { caption, parse_mode: 'HTML', ...kb });
  }
  return ctx
    .editMessageMedia({ type: 'document', media: doc, caption, parse_mode: 'HTML' }, kb)
    .catch((e: Error) => {
      if (/not modified/i.test(e.message)) return;
      return swap(ctx, text, { ...html, ...kb }); // media cannot be edited, so text only
    });
}

// Back to the chain picker: EDIT the same card, never send a new message.
bot.action('pnlback', async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  const chains = await pnlChains();
  return swap(ctx, msg.msgPnlPicker(chains), { ...html, ...chainKb(chains) });
});

// Step 1 -> 2: a chain is picked, so show All Time straight away (the most useful answer).
bot.action(/^pnlc:([a-z0-9_-]+)$/i, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1], 'all', true);
});

bot.action(/^pnl:([a-z0-9_-]+):(1d|1w|1m|all)$/i, async (ctx: any) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderPnl(ctx, ctx.match[1], ctx.match[2] as journal.PeriodKey);
});
