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
import { isSolAddress } from '../solana/addr.js';
import * as solWallet from '../solana/walletStore.js';
import { solHoldings, solUsd, type SolHolding } from '../solana/holdings.js';
import { sendSol } from '../solana/send.js';
import { txButtons } from '../chains.js';

/** Solana is not in CHAINS; its withdrawals carry this key. */
const SOL_KEY = 'solana';
/** SOL kept back for the fee (and a new token account's rent when sending a token). */
const SOL_RESERVE = 5_000_000n;
const WSOL = 'So11111111111111111111111111111111111111112';
const chainLabelOf = (key: string) => (key === SOL_KEY ? 'Solana' : CHAINS[key]!.label);

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
  /** Solana holdings offered for this withdrawal, indexed by the snds: buttons. */
  solList?: SolHolding[];
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
// /withdraw is the name on the menu; /send stays alive as a hidden alias.
bot.command('withdraw', cmdSend);
bot.command('send', cmdSend);

// Back = ask for the address again, which is the step before this one. cmdSend clears
// the flow itself, so a half-filled withdrawal cannot survive the trip backwards.
bot.action('snd:back', async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return cmdSend(ctx);
});

/** An address is pasted: scan all five chains and offer the ones holding something. */
/** True while /withdraw is waiting for a destination address. */
export const sendWantsAddress = (uid: number): boolean => !!flows.get(uid)?.awaitingAddress;

export async function handleSendAddress(ctx: any, raw: string): Promise<boolean> {
  const flow = flows.get(ctx.from.id);
  if (!flow?.awaitingAddress) return false;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const t = raw.trim();
  // A base58 address can only be Solana: list what the Solana wallet holds.
  if (isSolAddress(t) && !ethers.isAddress(t)) {
    const own = solWallet.address();
    if (!own || !solWallet.keypair()) {
      await ctx.reply(msg.msgError('send', 'No Solana wallet is connected. Connect one in /settings first.'), html);
      return true;
    }
    flow.to = t;
    flow.awaitingAddress = false;
    const prog = await ctx.reply(msg.msgProgress('reading your Solana balance…'), html);
    const list = (await solHoldings(own).catch(() => [] as SolHolding[]))
      .filter((h) => h.raw > 0n && (h.mint === WSOL || (h.usd ?? 0) >= 0.1))
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    if (list.length === 0) {
      flows.delete(ctx.from.id);
      await editProgress(ctx, prog, msg.msgError('send', 'No spendable balance on Solana.'));
      return true;
    }
    flow.solList = list;
    const rows = list.slice(0, 20).map((h, i) => [
      Markup.button.callback(
        `Solana: ${h.amount.toLocaleString('id-ID', { maximumFractionDigits: 4 })} ${h.symbol}${h.usd != null ? ` / $${h.usd.toLocaleString('id-ID', { maximumFractionDigits: 2 })}` : ''}`,
        `snds:${i}`,
      ),
    ]);
    await editProgress(ctx, prog, msg.msgSendPickAsset(t, ['Solana'], false), {
      ...html,
      ...Markup.inlineKeyboard([...rows, [Markup.button.callback('⬅️ Back', 'snd:back')], [Markup.button.callback('⬅️ Back to Menu', 'positions_back')]]),
    });
    return true;
  }
  if (!ethers.isAddress(t)) {
    await ctx.reply(msg.msgError('send', 'That is not a valid address. Paste a 0x… (EVM) or a Solana address.'), html);
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
  if (!flow?.to) return ctx.answerCbQuery('Expired. Start again with /send.');
  const cc = CHAINS[ctx.match[1]];
  if (!cc) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  // Compare addresses in lower case: the base addresses in chains.ts are not uniformly cased
  // (Robinhood's USDG is stored lower case, the rest checksummed), so comparing
  // comparing the strings verbatim makes an asset that plainly exists read as "missing".
  const addr = ctx.match[2] === 'native' ? null : ctx.match[2].toLowerCase();
  const list = await assetsOn(cc).catch(() => []);
  const a = list.find((x) => (x.address?.toLowerCase() ?? 'native') === (addr ?? 'native'));
  if (!a) return ctx.editMessageText(msg.msgError('send', 'That balance is gone. Start again with /withdraw.'), html);
  flow.chainKey = cc.key;
  flow.asset = { address: a.address, symbol: a.symbol, decimals: a.decimals };
  flow.isContract = (await cc.provider.getCode(flow.to).catch(() => '0x')) !== '0x';
  flow.awaitingAmount = true;
  return renderAmount(ctx, flow, a.wei);
});

bot.action(/^snds:(\d+)$/, async (ctx) => {
  const flow = flows.get(ctx.from!.id);
  const h = flow?.solList?.[Number(ctx.match[1])];
  if (!flow?.to || !h) return ctx.answerCbQuery('Expired. Start again with /withdraw.');
  await ctx.answerCbQuery();
  const decimals = h.amount > 0 ? Math.round(Math.log10(Number(h.raw) / h.amount)) : 9;
  flow.chainKey = SOL_KEY;
  flow.asset = { address: h.mint, symbol: h.symbol, decimals };
  flow.isContract = false;
  flow.awaitingAmount = true;
  return renderAmount(ctx, flow, h.raw);
});

/** What the Solana wallet can send of this asset now: SOL keeps its fee reserve. */
async function solSendable(flow: SendFlow): Promise<bigint> {
  const own = solWallet.address()!;
  const list = await solHoldings(own).catch(() => [] as SolHolding[]);
  const h = list.find((x) => x.mint === flow.asset!.address);
  if (!h) return 0n;
  if (h.mint === WSOL) return h.raw > SOL_RESERVE ? h.raw - SOL_RESERVE : 0n;
  return h.raw;
}

/** How much may really be sent: native has its gas reserve taken off first. */
async function sendableWei(cc: ChainCtx, flow: SendFlow): Promise<bigint> {
  if (flow.chainKey === SOL_KEY) return solSendable(flow);
  if (flow.asset!.address) {
    return (await new ethers.Contract(flow.asset!.address, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .catch(() => 0n)) as bigint;
  }
  const [bal, buf] = await Promise.all([cc.provider.getBalance(cc.wallet.address), gasBuffer(cc)]);
  return bal > buf ? bal - buf : 0n;
}

async function renderAmount(ctx: any, flow: SendFlow, balWei: bigint) {
  const cc = CHAINS[flow.chainKey!] ?? (null as unknown as ChainCtx);
  const usable = await sendableWei(cc, flow);
  const rows = [
    ...pctPresets.chunkButtons(pctPresets.get('send').map((p) => Markup.button.callback(`${p}%`, `sndpct:${p}`))),
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ];
  return ctx.editMessageText(
    msg.msgSendAmount({
      to: flow.to!,
      chainLabel: chainLabelOf(flow.chainKey!),
      symbol: flow.asset!.symbol,
      balance: `${fmtAmt(balWei, flow.asset!.decimals)} ${flow.asset!.symbol}`,
      // Same "amount SYMBOL / $value" shape as the button that got here. The dollar half
      // is dropped when the price cannot be read, never shown as $0.
      usable: await (async () => {
        const label = `${fmtAmt(usable, flow.asset!.decimals)} ${flow.asset!.symbol}`;
        const px =
          flow.chainKey === SOL_KEY
            ? flow.asset!.address === WSOL
              ? await solUsd().catch(() => null)
              : null
            : flow.asset!.address === null
              ? await getEthUsd(cc.wethAddress, cc).catch(() => null)
              : 1;
        if (px === null) return label;
        const usd = Number(ethers.formatUnits(usable, flow.asset!.decimals)) * px;
        return `${label} / $${usd.toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
      })(),
      nativeReserve: flow.asset!.address === null || flow.asset!.address === WSOL,
      isContract: !!flow.isContract,
    }),
    { ...html, ...Markup.inlineKeyboard(rows) },
  );
}

bot.action(/^sndpct:(\d+)$/, async (ctx) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow?.awaitingAmount || !flow.asset) return ctx.answerCbQuery('Expired. Start again with /send.');
  await ctx.answerCbQuery();
  const cc = CHAINS[flow.chainKey!] ?? (null as unknown as ChainCtx);
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
  const cc = CHAINS[flow.chainKey!] ?? (null as unknown as ChainCtx);
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
  const cc = CHAINS[flow.chainKey!] ?? (null as unknown as ChainCtx);
  flow.amountWei = wei;
  flow.awaitingAmount = false;
  // No confirm step, matching /swap and /bridge. What the button used to guard is still
  // guarded: the amount was checked against the spendable balance (gas reserve included)
  // before this is reached, and a dry run still sends nothing.
  if (!config.safety.dryRun) {
    const prog = await ctx.reply(
      msg.msgProgress(`withdrawing ${fmtAmt(wei, flow.asset!.decimals)} ${flow.asset!.symbol} on ${chainLabelOf(flow.chainKey!)}…`),
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
      chainLabel: chainLabelOf(flow.chainKey!),
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
  if (!flow?.amountWei || !flow.asset || !flow.to) return ctx.answerCbQuery('Expired. Start again with /send.');
  if (sending.has(uid)) return ctx.answerCbQuery('Processing…');
  sending.add(uid);
  store.beginMoneyOp();
  const cc = CHAINS[flow.chainKey!] ?? (null as unknown as ChainCtx);
  const { to, asset, amountWei } = flow;
  flows.delete(uid); // idempotency: clear it BEFORE executing, so a double-tap cannot send twice
  await ctx.answerCbQuery('Sending…');
  try {
    const label = `${fmtAmt(amountWei, asset.decimals)} ${asset.symbol}`;
    const chainLabel = chainLabelOf(flow.chainKey!);
    if (config.safety.dryRun) {
      return void (await ctx.editMessageText(msg.msgSendDone({ to, chainLabel, amount: label, txHash: null, dryRun: true }), html));
    }
    if (flow.chainKey === SOL_KEY) {
      await ctx.editMessageText(msg.msgProgress(`sending ${label} on Solana…`), html).catch(() => {});
      const sig = await sendSol(solWallet.keypair()!, to, asset.address!, amountWei);
      console.log(`[send] ${label} → ${to} (solana) tx ${sig}`);
      await ctx.editMessageText(msg.msgSendDone({ to, chainLabel, amount: label, txHash: sig, dryRun: false }), {
        ...html,
        ...Markup.inlineKeyboard(txButtons(SOL_KEY, [sig]).map((row) => row.map((x) => Markup.button.url(x.text, x.url)))),
      });
      return;
    }
    await ctx.editMessageText(msg.msgProgress(`sending ${label} on ${cc.label}…`), html).catch(() => {});
    const tx = asset.address
      ? await new ethers.Contract(asset.address, ERC20_SEND_ABI, cc.wallet).transfer(to, amountWei)
      : await (cc.wallet as ethers.Wallet).sendTransaction({ to, value: amountWei });
    const rc = await tx.wait();
    const hash = rc?.hash ?? tx.hash;
    console.log(`[send] ${label} → ${to} (${cc.key}) tx ${hash}`);
    await ctx.editMessageText(msg.msgSendDone({ to, chainLabel, amount: label, txHash: hash, dryRun: false }), {
      ...html,
      ...Markup.inlineKeyboard(txButtons(cc.key, [hash]).map((row) => row.map((x) => Markup.button.url(x.text, x.url)))),
    });
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
