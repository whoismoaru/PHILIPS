import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, parseAmt, isStaleFlow, registerFlowReset } from '../core.js';
import { CHAINS, getChain, isStableBase, type ChainCtx, type BaseKind } from '../chains.js';
import { bestBridgeQuote, executeBridgeVia, type BridgeProvider } from '../bridgeRoute.js';
import { NATIVE } from '../relay.js';
import { lifiSupports, lifiBridgeQuote } from '../lifi.js';
import { cctpSupport } from '../cctp.js';
import { ERC20_ABI } from '../chain.js';
import { getEthUsd } from '../screening.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';

/**
 * /bridge -- move funds between chains.
 *
 * One of the least reversible money paths here: once sent, the funds are on another chain
 * and only another bridge brings them back. So:
 *  - the direction is chosen explicitly, with no default a stray tap could take,
 *  - the quote is REQUESTED AGAIN at execution, floored at the figure the user actually
 *    saw (relay.executeBridge),
 *  - sessions expire and in-flight locks apply, as on every other money path.
 */

// Bridge quotes go stale fast; past this the card has to be rebuilt.
const QUOTE_TTL_MS = 120_000;
/** Gas that must be left behind: the bridge is paid for on the origin chain. */
const GAS_RESERVE_WEI = ethers.parseEther('0.0005');

type BridgeFlow = {
  fromKey: string;
  toKey: string;
  kind?: BaseKind; // the chosen source asset: weth for native, or a stablecoin
  originCurrency?: string; // the address of the asset being sent (NATIVE for native)
  destinationCurrency?: string; // alamat aset diterima di chain tujuan
  srcDecimals?: number;
  dstDecimals?: number;
  srcSymbol?: string;
  awaitingAmount?: boolean;
  amountWei?: bigint;
  minOutWei?: bigint;
  inLabel?: string;
  outLabel?: string;
  provider?: BridgeProvider; // the chosen provider, Relay or LI.FI, re-executed at confirmation
  quotedAt?: number;
  startedAt: number;
};
const flows = new Map<number, BridgeFlow>();
const inFlight = new Set<number>();
registerFlowReset((uid) => flows.delete(uid));

/** How the source asset is labelled: native uses the chain's symbol, a stablecoin its own. */
const assetLabel = (cc: ChainCtx, kind: BaseKind): string =>
  kind === 'weth' ? cc.nativeSymbol : (cc.bases.find((b) => b.kind === kind)?.symbol ?? kind.toUpperCase());

/**
 * Balance per base asset on one chain, as "714 USDG / $714".
 *
 * A balance that cannot be read falls back to the bare symbol rather than "0": zero is a
 * claim about the wallet, an unread balance is a claim about the RPC.
 */
async function heldLabels(cc: ChainCtx): Promise<Map<BaseKind, string>> {
  const out = new Map<BaseKind, string>();
  const px = cc.bases.some((b) => b.kind === 'weth')
    ? await getEthUsd(cc.wethAddress, cc).catch(() => null)
    : null;
  await Promise.all(
    cc.bases.map(async (b) => {
      try {
        const wei: bigint =
          b.kind === 'weth'
            ? await cc.provider.getBalance(cc.wallet.address)
            : await new ethers.Contract(b.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
        const sym = assetLabel(cc, b.kind);
        const amt = Number(ethers.formatUnits(wei, b.decimals));
        const usd = b.kind === 'weth' ? (px === null ? null : amt * px) : amt;
        const amtLabel = amt.toLocaleString('id-ID', { maximumFractionDigits: b.kind === 'weth' ? 6 : 2 });
        out.set(
          b.kind,
          `${amtLabel} ${sym}${usd === null ? '' : ` / $${usd.toLocaleString('id-ID', { maximumFractionDigits: 2 })}`}`,
        );
      } catch {
        /* unreadable: the caller falls back to the plain symbol */
      }
    }),
  );
  return out;
}

/**
 * Map the source asset onto its counterpart on the destination chain:
 *  - native goes to the destination's native,
 *  - a stablecoin goes to the same stablecoin there, or the first one it has.
 * Throws when the destination has nothing suitable to receive it.
 */
function resolveAssets(from: ChainCtx, to: ChainCtx, kind: BaseKind) {
  const srcBase = from.bases.find((b) => b.kind === kind);
  if (!srcBase) throw new Error(`${from.label} has no ${kind.toUpperCase()}`);
  if (kind === 'weth') {
    return {
      originCurrency: NATIVE,
      destinationCurrency: NATIVE,
      srcDecimals: 18,
      dstDecimals: 18,
      srcSymbol: from.nativeSymbol,
      dstSymbol: to.nativeSymbol,
    };
  }
  const dstBase = to.bases.find((b) => b.kind === kind) ?? to.bases.find((b) => isStableBase(b.kind));
  if (!dstBase) throw new Error(`${to.label} has no stablecoin to receive ${srcBase.symbol}.`);
  return {
    originCurrency: srcBase.address,
    destinationCurrency: dstBase.address,
    srcDecimals: srcBase.decimals,
    dstDecimals: dstBase.decimals,
    srcSymbol: srcBase.symbol,
    dstSymbol: dstBase.symbol,
  };
}

/** The source asset's balance, native or ERC20, formatted to its own decimals. */
async function assetBalance(cc: ChainCtx, kind: BaseKind): Promise<{ wei: bigint; label: string }> {
  if (kind === 'weth') {
    const wei = await cc.provider.getBalance(cc.wallet.address).catch(() => 0n);
    return { wei, label: `${Number(ethers.formatEther(wei)).toFixed(6)} ${cc.nativeSymbol}` };
  }
  const b = cc.bases.find((x) => x.kind === kind)!;
  const erc = new ethers.Contract(b.address, ERC20_ABI, cc.provider);
  const wei: bigint = await erc.balanceOf(cc.wallet.address).catch(() => 0n);
  return { wei, label: `${Number(ethers.formatUnits(wei, b.decimals)).toFixed(4)} ${b.symbol}` };
}

/**
 * Chains a bridge can actually reach.
 *
 * A chain being ENABLED is not the same as being bridgeable: Arc is live, its contracts
 * are verified and LI.FI lists it in /v1/chains and /v1/tools -- yet /v1/quote still
 * answers "Chain 5042 is not supported", and Relay does not carry it at all. Offering the
 * route anyway gives a button that can only fail after the user has picked an amount, so
 * the pairs are filtered to what a provider will really quote.
 *
 * LI.FI's diamond map is the test: every chain in it has been quoted against. Relay is
 * not consulted here because it covers a superset of those chains today.
 */
/**
 * Can these two chains actually be bridged BETWEEN?
 *
 * Tested as a PAIR, not per chain. Arc is reachable only through CCTP, so "Arc is
 * bridgeable" plus "Robinhood is bridgeable" does not make Robinhood → Arc a route --
 * LI.FI does not carry Arc, and Circle has not enabled burning on Robinhood. Offering it
 * anyway gives a button that fails after the amount is typed.
 */
const routable = (a: ChainCtx, b: ChainCtx): boolean =>
  (lifiSupports(a) && lifiSupports(b) && pairOk(a, b)) || (cctpChains.has(a.key) && cctpChains.has(b.key));

/**
 * Chains an aggregator covers only PARTIALLY, so being listed is not the same as being
 * routable. Arc is the case this exists for: on 16 Sep 2026 LI.FI began quoting INTO it
 * (Base -> Arc via polymerStandard, small amounts via gasZipBridge) while OUT of it still
 * returns no route at all.
 */
const PARTIAL = new Set(['arc']);
const pairProbe = new Map<string, { t: number; ok: boolean }>();
const PROBE_TTL_MS = 10 * 60_000;

/** The synchronous read of the probe cache; unknown pairs are assumed routable until asked. */
function pairOk(a: ChainCtx, b: ChainCtx): boolean {
  if (!PARTIAL.has(a.key) && !PARTIAL.has(b.key)) return true;
  return pairProbe.get(`${a.key}:${b.key}`)?.ok ?? false;
}

/**
 * Ask LI.FI for a token-sized quote on each pair that touches a partially covered chain,
 * so the menu offers only what can really be sent. Four pairs, in parallel, cached for ten
 * minutes -- the alternative is a button that fails after the owner has typed an amount.
 */
async function probePartialPairs(): Promise<void> {
  const list = Object.values(CHAINS);
  const pairs: Array<[ChainCtx, ChainCtx]> = [];
  for (const a of list)
    for (const b of list)
      if (a.key !== b.key && (PARTIAL.has(a.key) || PARTIAL.has(b.key)) && lifiSupports(a) && lifiSupports(b)) {
        const hit = pairProbe.get(`${a.key}:${b.key}`);
        if (!hit || Date.now() - hit.t > PROBE_TTL_MS) pairs.push([a, b]);
      }
  await Promise.all(
    pairs.map(async ([a, b]) => {
      const src = a.bases.find((x) => isStableBase(x.kind)) ?? a.bases[0];
      const dst = b.bases.find((x) => isStableBase(x.kind)) ?? b.bases[0];
      const amount = 10n ** BigInt(src.decimals); // one unit: enough to answer "is there a route?"
      const ok = await lifiBridgeQuote(a, b, amount, { originCurrency: src.address, destinationCurrency: dst.address })
        .then(() => true)
        .catch(() => false);
      pairProbe.set(`${a.key}:${b.key}`, { t: Date.now(), ok });
    }),
  );
}

/**
 * Chains reachable by CCTP, resolved ONCE at startup.
 *
 * The check is an on-chain read, and the route list is built on every /bridge -- doing it
 * per tap would put five RPC round-trips in front of the menu. A chain that switches on
 * later (Circle has CCTP deployed on Robinhood and BSC with burning still disabled) is
 * picked up on the next restart.
 */
const cctpChains = new Set<string>();

/**
 * Refresh which chains CCTP can reach. Called before the menu is drawn, not once at
 * startup: Arc's public RPC drops calls often enough that a single failed probe at boot
 * would hide its only route until the next restart. cctpSupport caches a success for good,
 * so this is a no-op read once each chain has answered.
 */
async function refreshCctpChains(): Promise<void> {
  await Promise.all(
    Object.values(CHAINS).map(async (cc) => {
      const ok = await cctpSupport(cc).then((x) => !!x).catch(() => false);
      if (ok) cctpChains.add(cc.key);
    }),
  );
}
void refreshCctpChains().then(() => {
  if (cctpChains.size) console.log(`[cctp] USDC transfers available on: ${[...cctpChains].join(', ')}`);
});

/** Every direction between the active chains. With one chain there is nothing to bridge. */
function routes(): Array<{ from: ChainCtx; to: ChainCtx }> {
  const list = Object.values(CHAINS);
  const out: Array<{ from: ChainCtx; to: ChainCtx }> = [];
  for (const from of list) for (const to of list) if (from.key !== to.key && routable(from, to)) out.push({ from, to });
  return out;
}

export async function cmdBridge(ctx: any) {
  await Promise.all([refreshCctpChains(), probePartialPairs()]);
  const rs = routes();
  if (rs.length === 0) return ctx.reply(msg.msgBridgeUnavailable(), html);
  flows.delete(ctx.from.id);
  // TWO per row, filled evenly across all twelve pairs. Telegram splits a row's width
  // between its buttons and offers no width of its own, so buttons-per-row is the only
  // lever: at three, "HyperEVM → Robinhood" gets a third of the screen and wraps.
  // Grouping by source chain is what made the old vertical list twelve rows long, and it
  // is no longer needed now that every button names both ends itself.
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < rs.length; i += 2) {
    rows.push(
      rs.slice(i, i + 2).map((r) => Markup.button.callback(`${r.from.label} → ${r.to.label}`, `br:${r.from.key}:${r.to.key}`)),
    );
  }
  rows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  return ctx.reply(msg.msgBridgePick(rs.map((r) => ({ from: r.from.label, to: r.to.label }))), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('bridge', cmdBridge);

// Once a route is chosen, offer the assets that can be bridged from the origin chain:
// its native asset plus each stablecoin it holds.
bot.action(/^br:(\w+):(\w+)$/, async (ctx) => {
  const [fromKey, toKey] = [ctx.match[1], ctx.match[2]];
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];
  if (!from || !to) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  flows.set(ctx.from!.id, { fromKey, toKey, startedAt: Date.now() });
  // Each button carries what is actually held, the same shape /swap uses. Picking an
  // asset blind and only then being told the balance is zero wastes two taps.
  const held = await heldLabels(from);
  // "→ BNB" / "→ USDT": the asset that actually lands. A stablecoin does not always keep
  // its name across chains (USDG here, USDT there), so naming only the source asset
  // leaves the arrival a surprise.
  const rows = from.bases.flatMap((b) => {
    let dst: string;
    try {
      dst = resolveAssets(from, to, b.kind).dstSymbol;
    } catch {
      return []; // no receiving asset on the destination chain: not a route, not a button
    }
    return [[Markup.button.callback(`${held.get(b.kind) ?? assetLabel(from, b.kind)} → ${dst}`, `bra:${fromKey}:${toKey}:${b.kind}`)]];
  });
  rows.push([Markup.button.callback('⬅️ Back', 'br:back'), Markup.button.callback('❌ Cancel', 'cancel')]);
  await ctx.editMessageText(msg.msgBridgeAsset(from.label, to.label), { ...html, ...Markup.inlineKeyboard(rows) });
});

// The asset is picked, so ask for the amount.
bot.action(/^bra:(\w+):(\w+):(\w+)$/, async (ctx) => {
  const [fromKey, toKey, kind] = [ctx.match[1], ctx.match[2], ctx.match[3] as BaseKind];
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];
  if (!from || !to) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  let a: ReturnType<typeof resolveAssets>;
  try {
    a = resolveAssets(from, to, kind);
  } catch (e) {
    return ctx.editMessageText(msg.msgError('bridge', (e as Error).message), html);
  }
  flows.set(ctx.from!.id, {
    fromKey,
    toKey,
    kind,
    originCurrency: a.originCurrency,
    destinationCurrency: a.destinationCurrency,
    srcDecimals: a.srcDecimals,
    dstDecimals: a.dstDecimals,
    srcSymbol: a.srcSymbol,
    awaitingAmount: true,
    startedAt: Date.now(),
  });
  // The same "714 USDG / $714" line the asset button carried, so the figure the user
  // tapped is the figure still on screen while they type.
  const held = await heldLabels(from);
  const bal = await assetBalance(from, kind);
  await ctx.editMessageText(msg.msgBridgeAmount(from.label, to.label, held.get(kind) ?? bal.label, a.srcSymbol), {
    ...html,
    ...Markup.inlineKeyboard([
      ...pctPresets.chunkButtons(pctPresets.get('bridge').map((p) => Markup.button.callback(`${p}%`, `brpct:${p}`))),
      [Markup.button.callback('⬅️ Back', `br:${fromKey}:${toKey}`)],
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

/**
 * A percentage of the balance, turned into an amount to bridge.
 *
 * For a NATIVE asset the percentage is taken from the balance minus the gas reserve: the
 * bridge is paid for on the ORIGIN chain, so 100% of the raw balance would leave nothing
 * to pay for the transaction itself. A stablecoin is used in full -- its gas comes from
 * native, and that is checked separately on the quote path.
 */
bot.action(/^brpct:(\d+)$/, async (ctx) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow?.awaitingAmount) return ctx.answerCbQuery('Expired — start again with /bridge.');
  const from = CHAINS[flow.fromKey];
  if (!from) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  const kind = flow.kind ?? 'weth';
  const { wei: bal } = await assetBalance(from, kind);
  const usable = kind === 'weth' ? (bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n) : bal;
  const pct = Number(ctx.match[1]);
  const wei = pct >= 100 ? usable : (usable * BigInt(pct)) / 100n;
  if (wei <= 0n) {
    return ctx.reply(
      msg.msgError('bridge', `Nothing left to bridge on ${from.label} after the gas reserve.`),
      html,
    );
  }
  return void (await bridgeQuote(ctx, flow, wei));
});

bot.action('br:back', async (ctx) => {
  await ctx.answerCbQuery();
  flows.delete(ctx.from!.id);
  return cmdBridge(ctx);
});

/** A typed amount becomes a quote plus the confirmation card. Called from the text handler in index.ts. */
export async function handleBridgeAmount(ctx: any, raw: string): Promise<boolean> {
  const flow = flows.get(ctx.from.id);
  if (!flow?.awaitingAmount) return false;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const from = CHAINS[flow.fromKey];
  const to = CHAINS[flow.toKey];
  const kind = flow.kind ?? 'weth';
  const isNative = kind === 'weth';
  const wei = parseAmt(raw, flow.srcDecimals ?? 18);
  if (wei === null) {
    await ctx.reply(msg.msgInvalidAmount(), html);
    return true;
  }
  await bridgeQuote(ctx, flow, wei);
  return true;
}

/** Check the balance, quote, and build the confirmation card. Shared by the typed amount and the percentage buttons. */
async function bridgeQuote(ctx: any, flow: BridgeFlow, wei: bigint): Promise<void> {
  const from = CHAINS[flow.fromKey];
  const to = CHAINS[flow.toKey];
  const kind = flow.kind ?? 'weth';
  const isNative = kind === 'weth';
  const prog = await ctx.reply(msg.msgProgress('requesting bridge quote…'), html);
  try {
    // Native: keep gas back, since it is paid on the origin chain. A stablecoin: check the
    // token balance covers it AND that native remains to pay for gas -- without which the
    // transaction itself fails.
    const nativeBal: bigint = await from.provider.getBalance(from.wallet.address);
    if (isNative) {
      if (wei + GAS_RESERVE_WEI > nativeBal) {
        await editProgress(ctx, prog, msg.msgError('bridge',
          `Amount plus gas exceeds your balance (${ethers.formatEther(nativeBal)} ${from.nativeSymbol}). Leave ~${ethers.formatEther(GAS_RESERVE_WEI)} for gas.`));
        return;
      }
    } else {
      const tokBal = (await assetBalance(from, kind)).wei;
      if (wei > tokBal) {
        await editProgress(ctx, prog, msg.msgError('bridge',
          `Amount exceeds your ${flow.srcSymbol} balance (${Number(ethers.formatUnits(tokBal, flow.srcDecimals ?? 18)).toFixed(4)}).`));
        return;
      }
      if (nativeBal < GAS_RESERVE_WEI) {
        await editProgress(ctx, prog, msg.msgError('bridge',
          `Not enough ${from.nativeSymbol} for gas on ${from.label} (need ~${ethers.formatEther(GAS_RESERVE_WEI)}).`));
        return;
      }
    }
    const assets = { originCurrency: flow.originCurrency, destinationCurrency: flow.destinationCurrency };
    const { provider, quote: q } = await bestBridgeQuote(from, to, wei, assets);
    flow.awaitingAmount = false;
    flow.amountWei = wei;
    flow.provider = provider;
    // The floor is what the user ACTUALLY saw, less a 1% tolerance.
    flow.minOutWei = (q.outWei * 99n) / 100n;
    flow.inLabel = q.inLabel;
    flow.outLabel = q.outLabel;
    flow.quotedAt = Date.now();
    // A bridge now goes the moment the amount is set, matching /swap. The Confirm card's
    // protections are all still in force: minOutWei is the floor the fill is held to,
    // balance and gas were checked above, and a dry run still never sends.
    if (!config.safety.dryRun) {
      await editProgress(ctx, prog, msg.msgProgress(`bridging ${q.inLabel} → ${q.outLabel}…`));
      // execBridge is written for a button press: hand it the two callback-only methods,
      // aimed at the progress bubble, rather than copying the money path for this entry.
      const auto: any = Object.create(ctx);
      auto.answerCbQuery = async () => {};
      auto.editMessageText = (text: string, extra?: any) =>
        ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, text, extra).catch(() => {});
      return execBridge(auto);
    }

    await editProgress(
      ctx,
      prog,
      msg.msgBridgeConfirm({
        fromLabel: from.label,
        toLabel: to.label,
        inLabel: q.inLabel,
        outLabel: q.outLabel,
        impactPct: q.impactPct,
        feeUsd: q.feeUsd,
        etaSec: q.etaSec,
        dryRun: config.safety.dryRun,
      }),
      {
        ...html,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Bridge', 'br:go')],
          [Markup.button.callback('⬅️ Back', `br:${flow.fromKey}:${flow.toKey}`), Markup.button.callback('❌ Cancel', 'cancel')],
        ]),
      },
    );
  } catch (e) {
    await editProgress(ctx, prog, msg.msgError('bridge', (e as Error).message));
  }
}

/**
 * Send the bridge the flow describes. Registered as Confirm, and called directly when a
 * typed amount goes straight out -- one implementation, so the two entry points cannot
 * drift apart on a path that cannot be undone.
 */
async function execBridge(ctx: any) {
  const uid = ctx.from!.id;
  const flow = flows.get(uid);
  if (!flow?.amountWei || flow.minOutWei === undefined) return ctx.answerCbQuery('Expired — start again with /bridge.');
  if (Date.now() - (flow.quotedAt ?? 0) > QUOTE_TTL_MS) {
    flows.delete(uid);
    await ctx.answerCbQuery('Quote expired.');
    return ctx.reply(msg.msgError('bridge', 'The quote is older than 2 minutes — run /bridge again for fresh numbers.'), html);
  }
  if (inFlight.has(uid)) return ctx.answerCbQuery('Processing…');
  inFlight.add(uid);
  const { fromKey, toKey, amountWei, minOutWei, inLabel, outLabel, provider, originCurrency, destinationCurrency } = flow;
  flows.delete(uid); // idempotency: clear it BEFORE executing, so a double-tap cannot bridge twice
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(
        msg.msgBridgeDone({ fromLabel: from.label, toLabel: to.label, inLabel: inLabel!, outLabel: outLabel!, txHashes: [], dryRun: true }),
        html,
      );
      return;
    }
    await ctx.editMessageText(msg.msgProgress(`bridging ${from.label} → ${to.label}…`), html).catch(() => {});
    const r = await executeBridgeVia(provider ?? 'relay', from, to, amountWei!, minOutWei!, { originCurrency, destinationCurrency });
    console.log(`[bridge] via ${provider ?? 'relay'} ${from.key}→${to.key} ${inLabel} → ${outLabel} tx ${r.txHashes.join(',')}`);
    await ctx.editMessageText(
      msg.msgBridgeDone({
        fromLabel: from.label,
        toLabel: to.label,
        inLabel: inLabel!,
        // Use the confirmed out label, which already carries the destination asset's symbol
        // and decimals. Raw outWei without them misprints a 6-decimal stablecoin.
        outLabel: outLabel!,
        txHashes: r.txHashes,
        dryRun: false,
      }),
      html,
    );
  } catch (e) {
    await ctx.reply(msg.msgError('bridge', (e as Error).message), html);
  } finally {
    inFlight.delete(uid);
    store.endMoneyOp();
  }
}

// The spinner is released here, in the handler: a button that returns without answering
// keeps spinning until Telegram times it out. execBridge answers again on its guard
// paths, which Telegram simply ignores.
bot.action('br:go', async (ctx: any) => {
  await ctx.answerCbQuery();
  return execBridge(ctx);
});
