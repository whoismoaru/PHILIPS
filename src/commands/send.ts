import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, parseAmt, isStaleFlow, registerFlowReset } from '../core.js';
import { CHAINS, isStableBase, type ChainCtx, type BaseAsset } from '../chains.js';
import { ERC20_ABI } from '../chain.js';

/**
 * The shared ERC20_ABI deliberately carries only reads and approve: this bot almost never
 * transfers a token directly, everything goes through a router. /send is the first path
 * that needs `transfer`, so the ABI is widened HERE alone rather than in the shared one
 * that dozens of other callers use.
 */
const ERC20_SEND_ABI = [...ERC20_ABI, 'function transfer(address to, uint256 amount) returns (bool)'];
import { gasBuffer } from '../uniswap.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';
import { getEthUsd } from '../screening.js';

/**
 * /send -- withdraw funds to another address.
 *
 * An EVM address carries NO chain information: the same `0xabc...` is valid on every chain,
 * and nothing about it says which one is meant. So what is "detected" here is what can
 * genuinely be detected:
 *  - which chains YOU hold a balance on, and how much,
 *  - whether the destination is a CONTRACT on that chain (sending to a contract that does
 *    not accept transfers burns the funds, so it is flagged before anything is signed).
 *
 * This is a one-way path with no recall, so it follows /bridge's shape: explicit choices,
 * in-flight locks, and sessions that expire.
 */

type SendFlow = {
  to?: string;
  awaitingAddress?: boolean;
  awaitingAmount?: boolean;
  chainKey?: string;
  asset?: { address: string | null; symbol: string; decimals: number }; // null = native
  isContract?: boolean;
  amountWei?: bigint;
  startedAt: number;
};

const flows = new Map<number, SendFlow>();
const sending = new Set<number>();
registerFlowReset((uid) => flows.delete(uid));

/** Native that MUST be left for gas -- sending everything fails the transaction itself. */
const fmtAmt = (wei: bigint, dec: number) => Number(ethers.formatUnits(wei, dec)).toLocaleString('id-ID', {
  maximumFractionDigits: dec >= 18 ? 6 : 2,
});

/** What can actually be sent from one chain: its native asset plus each funded base. */
async function assetsOn(cc: ChainCtx): Promise<Array<{ address: string | null; symbol: string; decimals: number; wei: bigint }>> {
  const out: Array<{ address: string | null; symbol: string; decimals: number; wei: bigint }> = [];
  const nat = await cc.provider.getBalance(cc.wallet.address).catch(() => 0n);
  if (nat > 0n) out.push({ address: null, symbol: cc.nativeSymbol, decimals: 18, wei: nat });
  for (const b of cc.bases as BaseAsset[]) {
    if (!isStableBase(b.kind)) continue; // wrapped-native is /unwrap's business, not a send
    const wei: bigint = await new ethers.Contract(b.address, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .catch(() => 0n);
    if (wei > 0n) out.push({ address: b.address, symbol: b.symbol, decimals: b.decimals, wei });
  }
  return out;
}

export async function cmdSend(ctx: any) {
  flows.set(ctx.from.id, { awaitingAddress: true, startedAt: Date.now() });
  return ctx.reply(msg.msgSendAskAddress(), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'positions_back')]]),
  });
}
bot.command('send', cmdSend);

// Back = ask for the address again, which is the step before this one. cmdSend clears
// the flow itself, so a half-filled withdrawal cannot survive the trip backwards.
bot.action('snd:back', async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return cmdSend(ctx);
});

/** An address is pasted: scan all five chains and offer the ones holding something. */
export async function handleSendAddress(ctx: any, raw: string): Promise<boolean> {
  const flow = flows.get(ctx.from.id);
  if (!flow?.awaitingAddress) return false;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const t = raw.trim();
  if (!ethers.isAddress(t)) {
    await ctx.reply(msg.msgError('send', 'That is not a valid EVM address. Paste a 0x… address.'), html);
    return true;
  }
  const to = ethers.getAddress(t);
  flow.to = to;
  flow.awaitingAddress = false;

  const prog = await ctx.reply(msg.msgProgress('checking where you can send from…'), html);
  // The address is the same on every chain, so what is scanned is YOUR balance on each.
  const found = await Promise.all(
    Object.values(CHAINS).map(async (cc) => ({
      cc,
      assets: await assetsOn(cc).catch(() => []),
      isContract: (await cc.provider.getCode(to).catch(() => '0x')) !== '0x',
    })),
  );
  const usable = found.filter((f) => f.assets.length > 0);
  if (usable.length === 0) {
    flows.delete(ctx.from.id);
    await editProgress(ctx, prog, msg.msgError('send', 'No spendable balance on any chain.'));
    return true;
  }
  // Same shape as /swap and /bridge: "Chain: amount SYMBOL / $value". A price that
  // cannot be read drops the dollar half rather than printing $0.
  const prices = new Map<string, number | null>();
  await Promise.all(
    usable.map(async (f) => prices.set(f.cc.key, await getEthUsd(f.cc.wethAddress, f.cc).catch(() => null))),
  );
  const rows = usable.flatMap((f) =>
    f.assets.map((a) => {
      const amt = Number(ethers.formatUnits(a.wei, a.decimals));
      const px = a.address === null ? prices.get(f.cc.key) ?? null : 1;
      const usd = px === null ? '' : ` / $${(amt * px).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
      return Markup.button.callback(
        `${f.cc.label}: ${fmtAmt(a.wei, a.decimals)} ${a.symbol}${usd}${f.isContract ? ' ⚠️' : ''}`,
        `snd:${f.cc.key}:${a.address ?? 'native'}`,
      );
    }),
  );
  await editProgress(
    ctx,
    prog,
    msg.msgSendPickAsset(to, usable.map((f) => f.cc.label), found.some((f) => f.isContract)),
    {
      ...html,
      ...Markup.inlineKeyboard([
        ...rows.map((r) => [r]),
        [Markup.button.callback('⬅️ Back', 'snd:back')],
        [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
      ]),
    },
  );
  return true;
}

bot.action(/^snd:(\w+):(native|0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow?.to) return ctx.answerCbQuery('Expired — start again with /send.');
  const cc = CHAINS[ctx.match[1]];
  if (!cc) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  // Compare addresses in lower case: the base addresses in chains.ts are not uniformly cased
  // (USDG Robinhood tersimpan lowercase, sisanya checksummed), jadi membandingkan
  // comparing the strings verbatim makes an asset that plainly exists read as "missing".
  const addr = ctx.match[2] === 'native' ? null : ctx.match[2].toLowerCase();
  const list = await assetsOn(cc).catch(() => []);
  const a = list.find((x) => (x.address?.toLowerCase() ?? 'native') === (addr ?? 'native'));
  if (!a) return ctx.editMessageText(msg.msgError('send', 'That balance is gone — start again with /send.'), html);
  flow.chainKey = cc.key;
  flow.asset = { address: a.address, symbol: a.symbol, decimals: a.decimals };
  flow.isContract = (await cc.provider.getCode(flow.to).catch(() => '0x')) !== '0x';
  flow.awaitingAmount = true;
  return renderAmount(ctx, flow, a.wei);
});

/** How much may really be sent: native has its gas reserve taken off first. */
async function sendableWei(cc: ChainCtx, flow: SendFlow): Promise<bigint> {
  if (flow.asset!.address) {
    return (await new ethers.Contract(flow.asset!.address, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .catch(() => 0n)) as bigint;
  }
  const [bal, buf] = await Promise.all([cc.provider.getBalance(cc.wallet.address), gasBuffer(cc)]);
  return bal > buf ? bal - buf : 0n;
}

async function renderAmount(ctx: any, flow: SendFlow, balWei: bigint) {
  const cc = CHAINS[flow.chainKey!]!;
  const usable = await sendableWei(cc, flow);
  const rows = [
    ...pctPresets.chunkButtons(pctPresets.get('send').map((p) => Markup.button.callback(`${p}%`, `sndpct:${p}`))),
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ];
  return ctx.editMessageText(
    msg.msgSendAmount({
      to: flow.to!,
      chainLabel: cc.label,
      symbol: flow.asset!.symbol,
      balance: `${fmtAmt(balWei, flow.asset!.decimals)} ${flow.asset!.symbol}`,
      // Same "amount SYMBOL / $value" shape as the button that got here. The dollar half
      // is dropped when the price cannot be read, never shown as $0.
      usable: await (async () => {
        const label = `${fmtAmt(usable, flow.asset!.decimals)} ${flow.asset!.symbol}`;
        const px = flow.asset!.address === null ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : 1;
        if (px === null) return label;
        const usd = Number(ethers.formatUnits(usable, flow.asset!.decimals)) * px;
        return `${label} / $${usd.toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
      })(),
      nativeReserve: flow.asset!.address === null,
      isContract: !!flow.isContract,
    }),
    { ...html, ...Markup.inlineKeyboard(rows) },
  );
}

bot.action(/^sndpct:(\d+)$/, async (ctx) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow?.awaitingAmount || !flow.asset) return ctx.answerCbQuery('Expired — start again with /send.');
  await ctx.answerCbQuery();
  const cc = CHAINS[flow.chainKey!]!;
  const usable = await sendableWei(cc, flow);
  const pct = Number(ctx.match[1]);
  const wei = pct >= 100 ? usable : (usable * BigInt(pct)) / 100n;
  if (wei <= 0n) {
    return ctx.reply(msg.msgError('send', `Nothing left to send after the gas reserve.`), html);
  }
  return confirm(ctx, flow, wei);
});

/** A typed amount becomes the confirmation card. Called from the main text handler. */
export async function handleSendAmount(ctx: any, raw: string): Promise<boolean> {
  const flow = flows.get(ctx.from.id);
  if (!flow?.awaitingAmount || !flow.asset) return false;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const cc = CHAINS[flow.chainKey!]!;
  // "0.1%" is a PERCENTAGE, not an amount, and the buttons only offer whole numbers.
  // parseAmt rejects it as an invalid amount; without this branch the user just gets
  // "enter a valid amount" with no hint that the percent sign is what went wrong.
  const pctTyped = raw.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
  const usableNow = await sendableWei(cc, flow);
  if (pctTyped) {
    const pct = Number(pctTyped[1]);
    if (!(pct > 0 && pct <= 100)) {
      await ctx.reply(msg.msgError('send', 'Percentage must be between 0 and 100.'), html);
      return true;
    }
    const w = pct >= 100 ? usableNow : (usableNow * BigInt(Math.round(pct * 1000))) / 100_000n;
    if (w <= 0n) {
      await ctx.reply(msg.msgError('send', 'That percentage rounds to zero.'), html);
      return true;
    }
    await confirm(ctx, flow, w);
    return true;
  }
  const wei = parseAmt(raw, flow.asset.decimals);
  if (wei === null) {
    await ctx.reply(msg.msgInvalidAmount(), html);
    return true;
  }
  if (wei <= 0n || wei > usableNow) {
    await ctx.reply(
      msg.msgError('send', `Amount exceeds what you can send (${fmtAmt(usableNow, flow.asset.decimals)} ${flow.asset.symbol}).`),
      html,
    );
    return true;
  }
  await confirm(ctx, flow, wei);
  return true;
}

async function confirm(ctx: any, flow: SendFlow, wei: bigint) {
  const cc = CHAINS[flow.chainKey!]!;
  flow.amountWei = wei;
  flow.awaitingAmount = false;
  // No confirm step, matching /swap and /bridge. What the button used to guard is still
  // guarded: the amount was checked against the spendable balance (gas reserve included)
  // before this is reached, and a dry run still sends nothing.
  if (!config.safety.dryRun) {
    const prog = await ctx.reply(
      msg.msgProgress(`withdrawing ${fmtAmt(wei, flow.asset!.decimals)} ${flow.asset!.symbol} on ${cc.label}…`),
      html,
    );
    // execSend is written for a button press: hand it the two callback-only methods,
    // aimed at the progress bubble.
    const auto: any = Object.create(ctx);
    auto.answerCbQuery = async () => {};
    auto.editMessageText = (text: string, extra?: any) =>
      ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, text, extra).catch(() => {});
    return execSend(auto);
  }
  return ctx.reply(
    msg.msgSendConfirm({
      to: flow.to!,
      chainLabel: cc.label,
      amount: `${fmtAmt(wei, flow.asset!.decimals)} ${flow.asset!.symbol}`,
      isContract: !!flow.isContract,
      dryRun: config.safety.dryRun,
    }),
    {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Confirm & Withdraw ${fmtAmt(wei, flow.asset!.decimals)} ${flow.asset!.symbol}`, 'sndgo')],
        [Markup.button.callback('⬅️ Back', 'snd:back')],
        [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
      ]),
    },
  );
}

/**
 * Send the withdrawal the flow describes. Registered as Confirm, and called directly
 * when an amount is entered -- one implementation, so the two entry points cannot drift
 * on the one path in this bot that sends money OUT of the wallet.
 */
async function execSend(ctx: any) {
  const uid = ctx.from!.id;
  const flow = flows.get(uid);
  if (!flow?.amountWei || !flow.asset || !flow.to) return ctx.answerCbQuery('Expired — start again with /send.');
  if (sending.has(uid)) return ctx.answerCbQuery('Processing…');
  sending.add(uid);
  store.beginMoneyOp();
  const cc = CHAINS[flow.chainKey!]!;
  const { to, asset, amountWei } = flow;
  flows.delete(uid); // idempotency: clear it BEFORE executing, so a double-tap cannot send twice
  await ctx.answerCbQuery('Sending…');
  try {
    const label = `${fmtAmt(amountWei, asset.decimals)} ${asset.symbol}`;
    if (config.safety.dryRun) {
      return void (await ctx.editMessageText(msg.msgSendDone({ to, chainLabel: cc.label, amount: label, txHash: null, dryRun: true }), html));
    }
    await ctx.editMessageText(msg.msgProgress(`sending ${label} on ${cc.label}…`), html).catch(() => {});
    const tx = asset.address
      ? await new ethers.Contract(asset.address, ERC20_SEND_ABI, cc.wallet).transfer(to, amountWei)
      : await (cc.wallet as ethers.Wallet).sendTransaction({ to, value: amountWei });
    const rc = await tx.wait();
    const hash = rc?.hash ?? tx.hash;
    console.log(`[send] ${label} → ${to} (${cc.key}) tx ${hash}`);
    await ctx.editMessageText(msg.msgSendDone({ to, chainLabel: cc.label, amount: label, txHash: hash, dryRun: false }), html);
  } catch (e) {
    await ctx.reply(msg.msgError('send', (e as Error).message), html);
  } finally {
    sending.delete(uid);
    store.endMoneyOp();
  }
}

// The spinner is answered in the handler; execSend answers again on its guard paths,
// which Telegram ignores.
bot.action('sndgo', async (ctx: any) => {
  await ctx.answerCbQuery();
  return execSend(ctx);
});
