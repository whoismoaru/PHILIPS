import { Markup, Input } from 'telegraf';
import {
  bot,
  html,
  capLabelFor,
  maxEth,
  maxStable,
  sleep,
  isGoneErr,
  isStaleFlow,
  parseAmt,
  mapLimit,
  mapLimitStream,
  editProgress,
  resetFlows,
  registerFlowReset,
  POS_CARD_CONCURRENCY,
  registeredCommands,
  startKeyboard,
  startCard,
} from './core.js';
import { renderProfitCard } from './card.js';
import { onchainV4Pools } from './onchainPools.js';
import { message } from 'telegraf/filters';
import { ethers } from 'ethers';
import { config, EXIT_CONFIG } from './config.js';
import { provider, ERC20_ABI, EXPLORER_HEADERS } from './chain.js';
import { retryOnce } from './retry.js';
import * as walletStore from './walletStore.js';
import {
  planAddSingleSided,
  planLadderSingleSided,
  ladderWeights,
  executeAddBatch,
  executeRemoveBatch,
  planAddTokenSide,
  ADD_GAS_UNITS,
  gasBuffer,
  executeAdd,
  executeRemove,
  collectFeesOnly,
  removeLiquidityPct,
  getPositionDetail,
  discoverAllPools,
  listPositions,
  type AddPlan,
  type PositionDetail,
} from './uniswap.js';
import { listPositionsV4, invalidateV4ListCache, v4Liquidity, v4PositionCount, v4Supported, closePositionV4, checkV4Status, v4NextTokenId, v4OwnerOf, v4OwnedIdsInRange, v4ListDegraded, openPositionV4, planLadderV4, openLadderV4, closeLadderV4, V4_UNPROTECTED_NOTE, v4BaseSymbol, v4BaseDecimals, currentTickV4, getPoolKeyV4, resolvePoolKeyV4, poolHealthV4, valuePositionV4, type V4Position, type V4LadderLeg } from './uniswapV4.js';
import * as v4store from './v4store.js';
import * as pctPresets from './pctPresets.js';
import { screenToken, formatScreen, bustScreenCache, getEthUsd, getTokenEthPrice } from './screening.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust, NATIVE, SLIP_MAX_PCT } from './relay.js';
import { startMonitor } from './monitor.js';
import * as store from './store.js';
import * as journal from './journal.js';
import * as msg from './messages.js';
import * as explore from './explore.js';
import * as krystal from './krystal.js';
import { awaitingSecret, handleSecret } from './commands/wallet.js';
import { cmdHistory, cmdPnl } from './commands/journalCmds.js';
import { cmdClaimFees } from './commands/feesAndRemove.js';
import { tokenSymbol as v4TokenSymbol, poolDepthV4, poolIdV4 } from './uniswapV4.js';
import { cmdBridge } from './commands/bridge.js';
import { cmdSend } from './commands/send.js';
import { cmdUnwrap } from './commands/unwrap.js';
import { cmdAlerts } from './commands/alerts.js';
import { cmdSettings, cmdConnect } from './commands/wallet.js';
import { gasCard, gasKeyboard } from './commands/gas.js';
import './commands/feesAndRemove.js';
import './commands/alerts.js';
import './commands/unwrap.js';
import './commands/gas.js';
import './commands/send.js';
import { handlePctReply } from './commands/wallet.js';
import { handleBridgeAmount } from './commands/bridge.js';
import { handleSendAddress, handleSendAmount } from './commands/send.js';
import {
  CHAINS,
  getChain,
  rebuildChains,
  detectChains,
  baseOf,
  baseDecimalsOf,
  basesFor,
  detectBase,
  isStableBase,
  baseSymbolOf,
  type ChainCtx,
  type BaseKind,
  type BaseAsset,
  venueCtx,
  ctxOf,
  pairLabel,
} from './chains.js';
import { swapExactInBest, previewSwapOut } from './swapRoute.js';

// The position has been burned or no longer exists on chain (the NFT is gone).

/**
 * PHILIPS LP Bot — the main brain.
 * Live commands: /start /help /portfolio /positions /history /pnl /explore /add /stop
 * /buy /sell /unwrap
 * Token screening runs automatically inside /add.
 */





/**
 * A typed amount to wei, or null when it makes no sense. `Number(raw) > 0` alone lets
 * '1e-9' and over-precise decimals through, and parseUnits then throws OUTSIDE the try
 * (a raw ERROR card). Excess decimals are TRUNCATED, never rounded up.
 */
// How many times a cash-out swap may repeat until the token balance is really zero.
const MAX_CLOSE_SWEEP = 4;
/** Max token holdings shown in /portfolio (after filtering to balance > 0). */
const SELL_HOLDINGS_CAP = 12; // the most tokens the /sell list will show
/** Max CA candidates whose balance gets checked (journal plus positions). */
const HOLDINGS_CAND_MAX = 20;
/** Concurrency while building position cards. */

/** Run fn over items with a concurrency cap (to stay within RPC rate limits). */


/**
 * Swap the ENTIRE token balance (not just the delta) to ETH, repeating until the
 * balance reaches zero. This covers leftovers from an earlier close, an RPC that has
 * not caught up, a Relay no-op, and partial swaps. Each pass swaps whatever full
 * balance remains.
 *
 * Using the full balance rather than only this position's proceeds is DELIBERATE
 * (confirmed by the owner, 1 Aug 2026): "close the position" means ending in ETH, not
 * keeping a bag. The side effect — a spot bag of the same token gets sold too — is
 * documented in the README.
 */
async function sweepTokenToBase(
  otherAddr: string,
  otherC: ethers.Contract,
  base: BaseAsset,
  cc: ChainCtx,
  notes: string[],
  keepFloor: bigint = 0n, // the token balance ALREADY held before the close, a spot bag, which must never be sold
): Promise<{ baseOut: bigint; txHashes: string[]; leftover: boolean; leftoverWei: bigint }> {
  let baseOut = 0n;
  const txHashes: string[] = [];
  let prev = -1n;
  for (let attempt = 1; attempt <= MAX_CLOSE_SWEEP; attempt++) {
    const total: bigint = await otherC.balanceOf(cc.wallet.address);
    // Sell ONLY what this position produced, on top of any bag already held.
    const bal = total > keepFloor ? total - keepFloor : 0n;
    if (bal === 0n) break;
    if (bal === prev) {
      notes.push(`${bal} token units left and not decreasing — swap stopped (needs a manual sweep).`);
      break;
    }
    prev = bal;
    try {
      if (isStableBase(base.kind)) {
        // A stablecoin base (USDG/USDT): swap token -> base (the generic function takes base.address).
        const r = await swapTokenToUsdgRobust(otherAddr, bal, base.address, cc);
        baseOut += r.outWei;
        txHashes.push(...r.txHashes);
        notes.push(`Swap ${attempt}: token → ${base.symbol} via ${r.route}`);
      } else {
        const r = await swapTokenToEthRobust(otherAddr, bal, cc);
        baseOut += r.outEthWei;
        txHashes.push(...r.txHashes);
        notes.push(`Swap ${attempt}: token → ETH via ${r.route}`);
      }
    } catch (e) {
      notes.push(`Swap attempt ${attempt} failed: ${(e as Error).message.slice(0, 140)}`);
      // ORPHAN GUARD: a swap error is sometimes FALSE — the tx (on a nonce clash, say)
      // was quietly sent and lands a few blocks later (the LIGER #774283 case: the
      // token sold but the bot believed it had failed, so PnL came out wrong). Do not
      // give up immediately: wait and check whether the token actually LEFT the
      // wallet. If the balance fell the swap really did run, so continue the loop and
      // let the remainder and proceeds be read; if not, it genuinely failed, so stop.
      let landed = false;
      for (let probe = 0; probe < 4; probe++) {
        await sleep(4000);
        const nowBal: bigint = await otherC.balanceOf(cc.wallet.address);
        const nowSell = nowBal > keepFloor ? nowBal - keepFloor : 0n;
        if (nowSell < bal) {
          landed = true;
          notes.push(`↳ but the token left the wallet — the swap actually landed (orphaned tx). Recounting.`);
          break;
        }
      }
      if (landed) continue; // the token moved, so measure again on the next pass
      break;
    }
    await sleep(1500); // give the balance time to settle on the RPC before re-checking
  }
  const finalTotal: bigint = await otherC.balanceOf(cc.wallet.address);
  const leftoverWei = finalTotal > keepFloor ? finalTotal - keepFloor : 0n;
  return { baseOut, txHashes, leftover: leftoverWei > 0n, leftoverWei };
}

/**
 * Gas pre-flight for an N-leg ladder: make sure the native balance covers gas (plus
 * the deposit when the base is native or wrappable). On failure it gives a friendly
 * "top up" message rather than a raw 'insufficient funds' revert. ~350k gas per leg
 * plus a 20% buffer.
 */
async function ensureGasForLegs(cc: ChainCtx, legs: number, nativeValueWei: bigint): Promise<void> {
  const [feeData, nativeBal] = await Promise.all([cc.provider.getFeeData(), cc.provider.getBalance(cc.wallet.address)]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasWei = (BigInt(Math.max(1, legs)) * 350_000n * gasPrice * 12n) / 10n;
  const need = gasWei + nativeValueWei;
  if (nativeBal < need) {
    throw new Error(
      `Not enough ${cc.nativeSymbol} on ${cc.label} for gas: need ~${ethers.formatEther(need)} ` +
        `(${legs} legs${nativeValueWei > 0n ? ' + deposit' : ''}), have ${ethers.formatEther(nativeBal)}. ` +
        `Top up ${cc.nativeSymbol} for gas.`,
    );
  }
}

/** Estimated network cost plus what is needed to open an LP, base-aware.
 *  WETH: both the deposit (the wrap) and gas come from native ETH. USDG: the deposit
 *  comes from the USDG balance (which must be held, as it cannot be wrapped) and gas
 *  from native ETH separately. */
async function estimateAddCost(cc: ChainCtx, base: import('./chains.js').BaseAsset, depositAmount: string) {
  const depositWei = ethers.parseUnits(depositAmount, base.decimals);
  const [feeData, nativeBal] = await Promise.all([
    cc.provider.getFeeData(),
    cc.provider.getBalance(cc.wallet.address),
  ]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasWei = gasPrice * ADD_GAS_UNITS;

  if (base.wrappable) {
    const wethBal: bigint = await cc.weth.balanceOf(cc.wallet.address);
    const nativeForDeposit = depositWei > wethBal ? depositWei - wethBal : 0n;
    const totalWei = nativeForDeposit + gasWei;
    const shortWei = totalWei > nativeBal ? totalWei - nativeBal : 0n;
    return {
      gasEth: msg.fmtEth(gasWei),
      needLabel: `${msg.fmtEth(totalWei)} ETH`,
      balanceLabel: `${msg.fmtEth(nativeBal)} ETH`,
      shortLabel: shortWei > 0n ? `${msg.fmtEth(shortWei)} ETH` : null,
    };
  }
  const erc = new ethers.Contract(base.address, ERC20_ABI, cc.provider);
  const bal: bigint = await erc.balanceOf(cc.wallet.address);
  const shortBase = depositWei > bal ? depositWei - bal : 0n;
  const shortGas = gasWei > nativeBal ? gasWei - nativeBal : 0n;
  const shorts: string[] = [];
  if (shortBase > 0n) shorts.push(`${ethers.formatUnits(shortBase, base.decimals)} ${base.symbol}`);
  if (shortGas > 0n) shorts.push(`${msg.fmtEth(shortGas)} ETH (gas)`);
  return {
    gasEth: msg.fmtEth(gasWei),
    needLabel: `${depositAmount} ${base.symbol} + gas`,
    balanceLabel: `${ethers.formatUnits(bal, base.decimals)} ${base.symbol} · ${msg.fmtEth(nativeBal)} ETH`,
    shortLabel: shorts.length ? shorts.join(' + ') : null,
  };
}

// The /add wizard flow (steps can move forward and back).
type AddFlow = {
  token: string;
  chain: string; // the key of the chain the token lives on
  screenBahaya: boolean;
  screenFailed?: boolean; // a screening ERROR, not a DANGER verdict: the token is simply unverified
  pools: explore.TokenPool[]; // a mirror of app.uniswap.org (v3 and v4), ordered by TVL
  selected?: explore.TokenPool; // the pool the user picked
  base?: BaseKind; // pasangan pool terpilih (weth | usdg)
  fee?: number;
  tokenDec?: number; // desimal token (sisi token)
  strategy?: 'base' | 'token'; // the deposit side: base buys the dip, token sells the rally (phase 6)
  rangePct?: number; // v3: lebar rentang %. v4: -1 = default single-sided
  ethAmount?: string;
  awaitingAmount?: boolean; // waiting for the user to type an amount
  plan?: AddPlan;
  shape?: 'spot' | 'bidask'; // bentuk ladder (sisi base); default spot = 1 leg (perilaku lama)
  legs?: number; // the ladder's leg count for bid-ask; spot is 1
  ladderPlans?: AddPlan[]; // the per-leg v3 plans, computed at the plan step and used at confirmation
  v4LadderLegs?: V4LadderLeg[]; // rencana per-leg v4 (batch modifyLiquidities)
  startedAt: number; // epoch ms, for session expiry, so a stale number is never consumed
};
const flows = new Map<number, AddFlow>();

/**
 * Drop EVERY half-finished flow belonging to a user. The text handler picks its
 * destination by static priority, so a stale flow can swallow an amount typed for a
 * new one (a leftover /buy catching the /add wizard's amount and producing a BUY card).
 * Called at the entry point of every flow, and by the Cancel button.
 */
/**
 * TOKEN HUB — paste a bare CA and get one identity card plus four actions.
 * The text and keyboard are stored so a "Back" button from any flow can re-render it
 * WITHOUT screening again (zero RPCs).
 */
type Hub = { ca: string; chainKey: string; text: string; kb: any; sym: string; dec: number; screenText: string; bahaya: boolean; reasons: string[]; failed: boolean };
const hubs = new Map<number, Hub>();

// Every piece of per-user state is registered with the central cleaner. The text
// handler picks its destination by static priority, so a stale flow can swallow an
// amount typed for a new one (a leftover /buy catching the /add_lp wizard's amount).
registerFlowReset((uid) => {
  flows.delete(uid);
  tswapFlows.delete(uid);
  hubs.delete(uid);
});
// Wizard and swap sessions expire: if a user walks away and types some other number
// much later, it must not be eaten by a stale flow. 15 minutes.

// Range width choices (%) with their risk labels.
// Named for the SHAPE of the range, not a verdict on it. The old names read backwards:
// a 10% range was called "Conservative" while it is the one that converts fastest and
// concentrates every dollar right under the price, and 90% was "Extreme" while it is the
// most patient of the five. A label that argues with the sentence above it is worse than
// no label.
const RANGE_OPTIONS = [
  { pct: 10, label: 'Tightest' },
  { pct: 30, label: 'Tight' },
  { pct: 50, label: 'Balanced' },
  { pct: 70, label: 'Wide' },
  { pct: 90, label: 'Widest' },
];

/** Leg-count choices for a Bid-Ask ladder. 8-10 is the free-tier sweet spot; 69 needs
 *  a paid RPC (on a free tier plus a 2-core VM, /positions and the monitor get heavy).
 *  Auto-capped to the spacing. */


/** Edit an existing progress message, or send a new one if that fails or none exists. */
// --- Guard: only the owner may use the bot ---
bot.use((ctx, next) => {
  // Ignore silently: replying to a stranger confirms this bot exists and can be made
  // to answer. Groups are refused too (a balance card would be readable by everyone).
  if (ctx.from?.id !== config.telegram.allowedUserId || (ctx.chat && ctx.chat.type !== 'private')) {
    console.log(`[guard] ignored an update from id ${ctx.from?.id} (chat ${ctx.chat?.type}); TELEGRAM_ALLOWED_USER_ID is ${config.telegram.allowedUserId}`);
    return;
  }
  return next();
});

// --- answerCbQuery must never take a handler down ---
// A callback query expires after ~15 seconds. When the flow behind a button takes
// longer than that (a cash-out, a swap), the "Loading..." reply fails with a 400 and
// throws BEFORE the real work runs. It is only a toast — swallow the error.
bot.use((ctx: any, next: any) => {
  if (typeof ctx.answerCbQuery === 'function') {
    const orig = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = (...a: unknown[]) => orig(...a).catch(() => undefined);
  }
  return next();
});

// --- Guard: commands that move money need a connected wallet ---
// Read-only commands (/status /positions /pools /help) are deliberately let through:
// watching without a wallet is legitimate, and those cards already mark themselves
// "not connected".
const NEEDS_WALLET = /^\/(add_lp|stop|claim_fees|buy|sell|swap|unwrap|bridge|send|withdraw)\b/;
// Buttons that ACTUALLY send a tx. Guarding commands alone is not enough: a flow can
// start with a wallet connected and then be disconnected, leaving the button still
// tappable — and what appears then is not "connect your wallet" but a raw VoidSigner error.
// The /start grid entries are guarded too: tapping `cmd:buy` must behave exactly like
// typing /buy, or an old start card left in the chat becomes a way around the guard
// after the wallet is disconnected.
const NEEDS_WALLET_CB =
  /^(addok|tswapok|close:|closev4go:|claim:|rmok:|unwrap:go|br:go|sndgo|cmd:(stop|claim_fees|buy|sell|swap|unwrap|bridge|send|withdraw)$)/;
bot.use((ctx: any, next: any) => {
  const t = ctx.message?.text ?? '';
  const cb = ctx.callbackQuery?.data ?? '';
  if ((NEEDS_WALLET.test(t) || NEEDS_WALLET_CB.test(cb)) && !walletStore.isConnected()) {
    if (cb) ctx.answerCbQuery('Wallet not connected.').catch(() => {});
    return ctx.reply(msg.msgNeedWallet(), html);
  }
  return next();
});

// ---------- Phase 1 ----------
/**
 * Sync the store with on-chain reality (active chain): import LP positions the wallet
 * holds but the store does not know about (opened manually in Uniswap or the CLI, say),
 * and mark tracked positions that no longer exist on chain as 'gone'. Fail-safe: if the
 * on-chain read fails it does NOT touch the store, so nothing is wrongly marked gone.
 */
async function syncOnChainPositions(cc: ChainCtx = getChain()): Promise<{ imported: number; gone: number }> {
  let onchain: Awaited<ReturnType<typeof listPositions>>;
  try {
    onchain = await listPositions(cc);
  } catch (e) {
    console.log('[sync] listPositions failed:', (e as Error).message.slice(0, 120));
    return { imported: 0, gone: 0 };
  }
  const onchainIds = new Set(onchain.map((p) => p.tokenId));
  let imported = 0;
  let gone = 0;
  // (1) Import on-chain positions (liquidity > 0) missing from the store.
  for (const p of onchain) {
    if (p.liquidity === 0n || store.get(p.tokenId)) continue;
    // Do not import a pool with no recognised base: the bot has no two-sided cash-out
    // route for one of those (see stopAndCashOut).
    const base = detectBase(cc, p.token0, p.token1);
    if (!base) continue;
    const isBase0 = base.address.toLowerCase() === p.token0.toLowerCase();
    store.addImported({
      tokenId: p.tokenId,
      chain: cc.key,
      ca: isBase0 ? p.token1 : p.token0,
      fee: p.fee,
      symbol: isBase0 ? p.token1Symbol : p.token0Symbol,
      baseKind: base.kind,
    });
    imported++;
  }
  // (2) Tracked positions on this chain that no longer exist on chain become 'gone'.
  for (const rec of store.active()) {
    if ((rec.chain ?? cc.key) !== cc.key) continue;
    if (!onchainIds.has(rec.tokenId)) {
      finalizeClose(rec.tokenId, { reason: 'gone' });
      gone++;
    }
  }
  if (imported || gone) console.log(`[sync] impor=${imported} gone=${gone} (chain ${cc.key})`);
  return { imported, gone };
}

/**
 * Grid buttons run the real command handler, not a copy of it.
 *
 * Every one of these is also reachable by typing the command, and two implementations
 * of the same action drift apart the moment one is edited. The handlers take the
 * Telegraf context either way, so a callback context works unchanged.
 */
const GRID_ACTIONS: Record<string, (ctx: any) => Promise<unknown>> = {
  claim_fees: cmdClaimFees,
  stop: cmdCloseAll,
  buy: cmdBuy,
  sell: cmdSell,
  swap: cmdSell,
  bridge: cmdBridge,
  send: cmdSend,
  withdraw: cmdSend,
  unwrap: cmdUnwrap,
  alerts: cmdAlerts,
  settings: cmdSettings,
  gas: async (ctx: any) => ctx.reply(await gasCard(), { ...html, ...gasKeyboard() }),
};

bot.action(/^cmd:([a-z_]+)$/, async (ctx: any) => {
  const fn = GRID_ACTIONS[ctx.match[1]];
  await ctx.answerCbQuery();
  if (!fn) return;
  return fn(ctx);
});

bot.start(async (ctx) => {
  // No wallet yet: ask for the key and nothing else. A welcome card whose every button
  // needs a wallet is a menu of things that cannot be tapped.
  //
  // cmdConnect, not a copy of its card: it also arms awaitingSecret, and a prompt that
  // asks for a key while nothing is listening would swallow whatever was pasted.
  if (!walletStore.isConnected()) return cmdConnect(ctx);
  const { imported, gone } = await syncOnChainPositions().catch(() => ({ imported: 0, gone: 0 }));
  await ctx.reply(startCard({ imported, gone }), { ...html, ...startKeyboard() });
});
// Dismiss an alert card. Delete the message; if Telegram refuses (a message older than
// 48 hours) fall back to editing the text so the buttons still go away.
bot.action('dismiss', async (ctx) => {
  await ctx.answerCbQuery('Dismissed');
  await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup(undefined).catch(() => {}));
});

bot.action('howitworks', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgHowItWorks(), html);
});
bot.action('howto:add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgAddHowTo(), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'dismiss')],
    ]),
  });
});

// Quick-action inline keyboard on the /help card (alongside the persistent reply
// keyboard). A 2-column grid (thumb-friendly); money actions get their own row.
const helpKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💰 Portfolio', 'portfolio'), Markup.button.callback('📊 Positions', 'positions')],
    // Close All is the one destructive action in the bot, so it keeps its own row and
    // says what it does. It has no other entry point now that /stop is menu-hidden.
    [Markup.button.callback('⛔ Emergency Close All', 'closeall_confirm')],
    [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
  ]);

bot.command('help', (ctx) =>
  ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, ...helpKeyboard() }),
);

// /help inline buttons run the matching command (ctx.reply works from a callback).
bot.action('portfolio', async (ctx) => {
  await ctx.answerCbQuery();
  return renderStatus(ctx, false);
});
bot.action('pnl', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdPnl(ctx);
});

bot.action('positions', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdPositions(ctx);
});
bot.action('status', async (ctx) => {
  await ctx.answerCbQuery();
  return renderStatus(ctx, false);
});
bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdHistory(ctx);
});
/**
 * Close EVERY open position, one after another.
 *
 * Each one goes through the SAME executor as its own Close button -- journal entry, PnL
 * card, sweeps and all -- so closing twenty positions cannot record them differently
 * from closing one. They run sequentially on purpose: they share a wallet, and two
 * closes in flight collide on the nonce.
 *
 * A failure on one position does not stop the rest; it is counted and named at the end.
 */
bot.action('closeall_confirm', async (ctx: any) => {
  await ctx.answerCbQuery();
  const v3 = store.active();
  const v4: Array<{ id: string; chain: ChainCtx }> = [];
  for (const c of Object.values(CHAINS).filter((x) => v4Supported(x))) {
    for (const p of await listPositionsV4(c).catch(() => [])) v4.push({ id: p.tokenId, chain: c });
  }
  const total = v3.length + v4.length;
  if (total === 0) return ctx.reply(msg.msgNoActiveToStop(), html);

  const prog = await ctx.reply(msg.msgProgress(`closing ${total} position${total === 1 ? '' : 's'}…`), html);
  const edit = (t: string) => ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, t, html).catch(() => {});
  let done = 0;
  const failed: string[] = [];
  // Each executor edits the card it was tapped on; here that is the progress bubble.
  const shim = (id: string) => {
    const c: any = Object.create(ctx);
    c.match = ['', id];
    c.answerCbQuery = async () => {};
    c.editMessageText = async (t: string, extra?: any) =>
      ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, t, extra).catch(() => {});
    return c;
  };
  for (const rec of v3) {
    try {
      await execCloseV3(shim(rec.tokenId));
      done++;
    } catch (e) {
      failed.push(`#${rec.tokenId}: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  for (const p of v4) {
    try {
      await execCloseV4(shim(p.id));
      done++;
    } catch (e) {
      failed.push(`#${p.id}: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  await edit(msg.msgCloseAllDone(done, total, failed));
});
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(msg.msgHelp(config.safety.dryRun), { ...html, ...helpKeyboard() });
});

// When /status last rendered, for the "Refreshed N seconds ago" footer (owner-only bot).
async function renderStatus(ctx: any, edit: boolean) {
  try {
    // The ETH price (main chain) once, used to value every ETH-native chain.
    // NOT awaited here: nothing below needs its value to START, while awaiting it holds
    // the whole card for ~700ms. It is picked up where it is actually used (v4 valuation
    // and the total) — the rest has already been running by then.
    const ccLp0 = getChain();
    const ethUsdP = getEthUsd(ccLp0.wethAddress, ccLp0).catch(() => null);
    // The v4 list and each v3 position's detail do not depend on chain balances either;
    // all three used to be chained (price -> balances -> LP -> v4) and their times added up.
    // EVERY v4-capable chain, not just the active one — same as /positions. BSC v4
    // positions were never counted, so this card's LP total was quietly missing their
    // entire value with nothing to indicate it.
    const v4P = Promise.all(
      Object.values(CHAINS)
        .filter((c) => v4Supported(c))
        .map(async (c) =>
          (await listPositionsV4(c).catch(() => [] as V4Position[])).map((p) => ({ cc: c, p })),
        ),
    ).then((x) => x.flat());
    const v3ValsP = mapLimit(store.active(), POS_CARD_CONCURRENCY, async (rec) => {
      try {
        const rcc = ctxOf(rec);
        const d = await getPositionDetail(rec.tokenId, rcc);
        const v = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, d.baseDecimals));
        // The native price comes from THAT POSITION'S chain: BNB priced by WBNB, HYPE by
        // WHYPE. Multiplying everything by the main chain's ETH price once inflated
        // HyperEVM LP value 30-fold.
        return baseToUsd(d.baseKind, v, rcc);
      } catch {
        return undefined;
      }
    });
    const [network, chains] = await Promise.all([
      provider.getNetwork(),
      // Native balances on EVERY chain (in parallel; a failed chain gives amount '?' and null usd).
      Promise.all(
        Object.values(CHAINS).map(async (c) => {
          // A stablecoin base is read ON ITS OWN CHAIN: USDG belongs to Robinhood, USDT
          // to BSC. A standalone "USDG" row used to hide which chain it was on.
          const stables: Array<{ symbol: string; amount: string; usd: number | null }> = [];
          for (const b of basesFor(c)) {
            if (!isStableBase(b.kind)) continue;
            try {
              const erc = new ethers.Contract(b.address, ERC20_ABI, c.provider);
              const raw: bigint = await erc.balanceOf(c.wallet.address);
              const amt = Number(ethers.formatUnits(raw, b.decimals));
              if (amt > 0) stables.push({ symbol: b.symbol, amount: amt.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), usd: amt }); // ≈ $1
            } catch {
            /* an unreadable stablecoin is skipped rather than failing the card */
            }
          }
          try {
            const b = await c.provider.getBalance(c.wallet.address);
            const amt = Number(ethers.formatEther(b));
            // The native price comes from THAT chain's own wrapped native: BNB priced
            // with WBNB, not with ETH. Unreadable gives null ("$?") and is not summed.
            const px = await getEthUsd(c.wethAddress, c).catch(() => null);
            const usd = px !== null ? amt * px : amt === 0 ? 0 : null;
            return { label: c.label, amount: amt.toFixed(4), symbol: c.nativeSymbol, usd, stables };
          } catch {
            return { label: c.label, amount: '?', symbol: c.nativeSymbol, usd: null, stables };
          }
        }),
      ),
    ]);
    // The value of live LP positions (v3 + v4). One position failing to read must not
    // fail the card; the number that failed is reported so the total does not read as fact.
    let lpUsd: number | null = null;
    let lpFailed = 0;
    const ethUsd = await ethUsdP;
    try {
      const [vals, v4] = await Promise.all([v3ValsP, v4P]);
      // The native price of THAT POSITION'S chain, not the active chain's.
      const pxOf = new Map<string, number | null>();
      for (const { cc: pcc } of v4)
        if (!pxOf.has(pcc.key)) pxOf.set(pcc.key, await getEthUsd(pcc.wethAddress, pcc).catch(() => null));
      const v4Vals = v4.map(({ cc: pcc, p }) => {
        if (p.valueBaseWei === null || !p.base) return undefined;
        const v = Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), v4BaseDecimals(pcc, p.base)));
        const px = pxOf.get(pcc.key) ?? null;
        return p.base === 'USDG' ? v : px !== null ? v * px : null;
      });
      const all = [...vals, ...v4Vals];
      lpFailed = all.filter((v) => v === undefined).length;
      const known = all.filter((v): v is number => typeof v === 'number');
      lpUsd = all.some((v) => v === null) && known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
    } catch {
      lpUsd = null;
    }
    // Total USD: null when the ETH price is unreadable (ETH dominates, so the total would not be sound).
    const stablesUsd = chains.reduce(
      (s, c) => s + (c.stables ?? []).reduce((t, x) => t + (x.usd ?? 0), 0),
      0,
    );
    const totalUsd = ethUsd === null ? null : chains.reduce((s, c) => s + (c.usd ?? 0), 0) + stablesUsd;

    const text = msg.msgStatus({
      dryRun: config.safety.dryRun,
      positions: store.active().length,
      chains,
      totalUsd,
      lpUsd,
      lpFailed,
    });
    const extra = {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Data', 'refresh:status')],
        [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
      ]),
    };
    await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
  } catch (err) {
    // "message is not modified" means a refresh with unchanged data — benign, ignore
    // it. Otherwise it is caught here and shown wrongly as ❌ ERROR · network.
    if (/not modified/i.test((err as Error).message)) return;
    await ctx.reply(msg.msgError('network', (err as Error).message), html);
  }
}

bot.command('portfolio', (ctx) => renderStatus(ctx, false));
// The old name stays alive so anyone used to typing /status does not hit a wall.
// It is not in the menu — only one name is advertised.
bot.command('status', (ctx) => renderStatus(ctx, false));

bot.action('refresh:status', async (ctx) => {
  await ctx.answerCbQuery('Refreshing…');
  try {
    await renderStatus(ctx, true);
  } catch (e) {
    // "message is not modified" means the data has not changed — not a real error.
    if (!/not modified/i.test((e as Error).message)) throw e;
  }
});

/** A base value (float) to USD. WETH: x ethUsd (may be null). USDG: 1:1 with the dollar. */
async function baseToUsd(baseKind: BaseKind, amountFloat: number, cc: ChainCtx): Promise<number | null> {
  if (isStableBase(baseKind)) return amountFloat; // USDG/USDT ≈ $1
  const eu = await getEthUsd(cc.wethAddress, cc);
  return eu !== null ? amountFloat * eu : null;
}

/** A position's PnL text, base-aware: WETH converts through ethUsd, USDG is 1:1. */
async function positionPnlText(
  rec: store.PosRecord | undefined,
  d: PositionDetail,
  cc: ChainCtx,
): Promise<string> {
  const dec = d.baseDecimals;
  if (rec?.imported) {
    // An imported position has no known cost basis, so show its current value rather than a fake PnL.
    const curVal = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
    const usdV = await baseToUsd(d.baseKind, curVal, cc);
    const valLabel = usdV !== null ? msg.usdPlain(usdV) : `${curVal.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`;
    return `value ${valLabel} · entry unknown`;
  }
  const initF = rec ? Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec)) : 0;
  const curF = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
  // LP Agent-style USD PnL: the cost basis is valued in USD at the base price AT
  // ENTRY, and the current value at the base price NOW. Movement in the base asset
  // (ETH) is therefore counted — unlike the old ETH view, which simply multiplied the
  // WETH difference by today's price.
  if (rec?.entryEthUsd && rec.entryEthUsd > 0) {
    const nowUsdPer = isStableBase(d.baseKind) ? 1 : await getEthUsd(cc.wethAddress, cc);
    if (nowUsdPer !== null) {
      const entryUsd = initF * rec.entryEthUsd;
      const curUsd = curF * nowUsdPer;
      const pnlUsd = curUsd - entryUsd;
      const pct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
      return `${msg.usdSigned(pnlUsd)} (${msg.fmtPct(pct)})`;
    }
  }
  // Fallback for older positions without entryEthUsd: the ETH-denominated view.
  const pnlF = curF - initF;
  const pct = initF > 0 ? (pnlF / initF) * 100 : 0;
  const usd = await baseToUsd(d.baseKind, pnlF, cc);
  return usd !== null
    ? `${msg.usdSigned(usd)} (${msg.fmtPct(pct)})`
    : `${pnlF >= 0 ? '+' : ''}${pnlF.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol} (${msg.fmtPct(pct)})`;
}

/** Build a position card's text and keyboard (uses RPC). Side effect: finalizeClose when the NFT is gone. */
async function buildPositionCard(
  rec: store.PosRecord,
): Promise<{ text: string; extra: Record<string, unknown> }> {
  let d: PositionDetail;
  try {
    d = await getPositionDetail(rec.tokenId, ctxOf(rec));
  } catch (e) {
    if (isGoneErr(e)) {
      finalizeClose(rec.tokenId, { reason: 'gone' });
      return {
        text: msg.msgPositionGone(rec.tokenId, rec.symbol, baseSymbolOf(rec.baseKind, ctxOf(rec))),
        extra: html,
      };
    }
    return { text: msg.msgPositionReadFail(rec.tokenId, (e as Error).message), extra: html };
  }
  const cc = ctxOf(rec);
  // Warm the ethUsd cache once per chain (getEthUsd already has a 60s TTL).
  if (d.baseKind === 'weth') await getEthUsd(cc.wethAddress, cc);
  const pnlText = await positionPnlText(rec, d, cc);
  // The distance from the CURRENT PRICE to each range edge — "how much further to
  // either end from here" — so it moves as the token falls. It used to be pinned to
  // entryPrice to keep the number still, which meant the card described the state when
  // the POSITION WAS OPENED rather than now: the token fell 26% and the line still read
  // -0.7% to -90.2%, when from today's price the edges were +34.7% to -86.8%. The
  // absolute bounds do stay still, and are shown by the mcap line below (pinned to
  // entry). Same as the v4 card.
  const range = (() => {
    const now = Number(d.currentPrice);
    if (now > 0) {
      const pf = (p: string) => (Number(p) / now - 1) * 100;
      const [a, b] = [pf(d.priceUpper), pf(d.priceLower)].sort((x, y) => y - x);
      return `${msg.fmtPct(a)} ⇄ ${msg.fmtPct(b)}`;
    }
    // The live price is unreadable, so use the tick (same source, different path).
    const sgn = d.baseIsToken0 ? -1 : 1;
    const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - d.currentTick)) - 1) * 100;
    const pcts = [pctOf(d.tickUpper), pctOf(d.tickLower)].sort((a, b) => b - a);
    return `${msg.fmtPct(pcts[0])} ⇄ ${msg.fmtPct(pcts[1])}`;
  })();
  // The same range read as market capitalisation. MC scales LINEARLY with price (supply
  // is fixed), so MC at an edge = MC now x (edge price / current price). That ratio is
  // unitless, so the prices can stay denominated in base.
  const mcRange = await (async () => {
    const [hi, lo] = Number(d.priceUpper) >= Number(d.priceLower)
      ? [d.priceUpper, d.priceLower]
      : [d.priceLower, d.priceUpper];
    // The mcap bounds are PINNED to ENTRY: mcEntry x (edge price / entry price). Both
    // are STORED values, so the bounds really do stay still. It used to use mcNow /
    // priceNow, mixing DexScreener's mcap with an on-chain price — two sources, out of
    // step — so the bounds wobbled on every refresh even though the position's ticks
    // had not moved.
    if (rec.entryMcap && rec.entryPrice && Number(rec.entryPrice) > 0) {
      const e = Number(rec.entryPrice);
      const at = (p: string) => explore.usdShort((rec.entryMcap! * Number(p)) / e);
      // "now" is DERIVED from the pool price just read, not pulled from DexScreener.
      // Mcap scales linearly with price, so mcEntry x (price now / price at entry) gives
      // a figure that moves IMMEDIATELY on each refresh — whereas DexScreener is cached
      // for 2 minutes and comes from a different source, so "now" could fall out of line
      // with the range bounds, the IN RANGE status and the PnL on the same card. This is
      // what the v4 card already does. Only when the pool price is unreadable does it
      // fall back to DexScreener.
      const nowPrice = Number(d.currentPrice);
      const derived = nowPrice > 0 ? (rec.entryMcap * nowPrice) / e : null;
      const shown = derived ?? (await explore.tokenMarketCap(cc, d.otherAddress).catch(() => null));
      const nowStr = shown !== null ? ` · now ${explore.usdShort(shown)}` : '';
      return `${at(hi)} ⇄ ${at(lo)}${nowStr}`;
    }
    const mcNow = await explore.tokenMarketCap(cc, d.otherAddress).catch(() => null);
    // Older positions without entryMcap fall back to the live calculation (it wobbles, but it is a reference).
    const now = Number(d.currentPrice);
    if (mcNow === null || !(now > 0)) return undefined;
    const at = (p: string) => explore.usdShort((mcNow * Number(p)) / now);
    return `${at(hi)} ⇄ ${at(lo)} · now ${explore.usdShort(mcNow)}`;
  })();
  const invest = rec.imported
    ? '—'
    : (rec.nominalEth ?? msg.cleanUnits(BigInt(rec.initialWethWei), baseDecimalsOf(rec.chain, rec.baseKind)));
  // Ladder: the WHOLE GROUP's capital (every leg summed) so a leg card does not look
  // like a small standalone position.
  const ladder = rec.groupId
    ? await (async () => {
        const legs = store.group(rec.groupId!);
        if (legs.length < 2) return undefined;
        const dec = baseDecimalsOf(rec.chain, rec.baseKind);
        const groupWei = legs.reduce((s, l) => s + BigInt(l.initialWethWei || '0'), 0n);
        // A summary of the WHOLE ladder. Without it the card puts the GROUP's capital
        // directly above a PnL belonging to ONE leg: "+4.5%" reads against 175 USDT
        // (~$7.9) when the actual gain is $0.22 — two adjacent lines with different
        // denominators. Now both scopes are stated outright.
        const seen = await mapLimit(legs, POS_CARD_CONCURRENCY, async (l) => {
          try {
            const dd = await getPositionDetail(l.tokenId, cc);
            return {
              inWei: BigInt(l.initialWethWei || '0'),
              valWei: dd.valueBaseWei + dd.feesBaseWei,
              feeWei: dd.feesBaseWei,
              lo: Math.min(Number(dd.priceLower), Number(dd.priceUpper)),
              hi: Math.max(Number(dd.priceLower), Number(dd.priceUpper)),
              inRange: dd.inRange,
              converted: !dd.inRange && (l.side === 'token' ? dd.side === 'above' : dd.side === 'below'),
            };
          } catch {
            return null;
          }
        });
        const ok = seen.filter((x): x is NonNullable<typeof x> => x !== null);
        let ladderPnl: string | undefined;
        if (ok.length === legs.length) {
          const inF = Number(ethers.formatUnits(ok.reduce((a, x) => a + x.inWei, 0n), dec));
          const valF = Number(ethers.formatUnits(ok.reduce((a, x) => a + x.valWei, 0n), dec));
          const usd = await baseToUsd(rec.baseKind ?? d.baseKind, valF - inF, cc);
          const pct = inF > 0 ? ((valF - inF) / inF) * 100 : 0;
          ladderPnl = `${usd !== null ? msg.usdSigned(usd) : `${valF - inF >= 0 ? '+' : ''}${(valF - inF).toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`} (${msg.fmtPct(pct)})`;
        }
        // The value and fees of the WHOLE ladder, plus an mcap range spanning the
        // outermost edges of every leg, so a leg card takes the same shape as a v4 card.
        const complete = ok.length === legs.length;
        const fmtBase = (n: number) => `${n.toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`;
        const ladderValue = complete
          ? fmtBase(Number(ethers.formatUnits(ok.reduce((a, x) => a + x.valWei, 0n), dec)))
          : undefined;
        const ladderFees = complete
          ? fmtBase(Number(ethers.formatUnits(ok.reduce((a, x) => a + x.feeWei, 0n), dec)))
          : undefined;
        let ladderMcRange: string | undefined;
        if (complete && rec.entryMcap && rec.entryPrice && Number(rec.entryPrice) > 0) {
          const e = Number(rec.entryPrice);
          const at = (price: number) => explore.usdShort((rec.entryMcap! * price) / e);
          const nowPrice = Number(d.currentPrice);
          const nowStr = nowPrice > 0 ? ` · now ${at(nowPrice)}` : '';
          ladderMcRange = `${at(Math.max(...ok.map((x) => x.hi)))} ⇄ ${at(Math.min(...ok.map((x) => x.lo)))}${nowStr}`;
        }
        const mineWei = BigInt(rec.initialWethWei || '0');
        return {
          legIndex: rec.legIndex ?? 0,
          legCount: rec.legCount ?? legs.length,
          shape: rec.shape ?? 'bidask',
          groupInvest: msg.cleanUnits(groupWei, dec),
          ladderValue,
          ladderFees,
          ladderMcRange,
          ladderPnl,
          sharePct: groupWei > 0n ? Number((mineWei * 10000n) / groupWei) / 100 : undefined,
          legValue: fmtBase(Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec))),
          legFees: d.feesBaseWei > 0n ? fmtBase(Number(ethers.formatUnits(d.feesBaseWei, dec))) : undefined,
          filled: ok.filter((x) => x.converted).length,
          active: ok.filter((x) => x.inRange).length,
          waiting: ok.filter((x) => !x.inRange && !x.converted).length,
          unread: legs.length - ok.length,
        };
      })()
    : undefined;
  // The pool's own numbers. The index is preferred (it carries volume and APR), and a
  // pool it has not picked up yet -- new pools take hours -- falls back to the reserve
  // held by the pool CONTRACT, which is always readable for v3.
  const poolRow = await (async () => {
    try {
      const hit = (await explore.poolsForToken(cc, rec.ca).catch(() => [])).find(
        (x) => x.protocol === 'v3' && x.fee === rec.fee && x.base === d.baseKind,
      );
      if (hit) {
        return {
          tvl: msg.usdCompact(hit.tvlUsd),
          vol: hit.vol24hUsd != null && hit.vol24hUsd > 0 ? msg.usdCompact(hit.vol24hUsd) : undefined,
          apr: hit.aprPct == null ? undefined : `~${hit.aprPct >= 100 ? Math.round(hit.aprPct) : hit.aprPct.toFixed(1)}%`,
        };
      }
      const onchain = (await discoverAllPools(rec.ca, cc).catch(() => [])).find(
        (p) => p.fee === rec.fee && p.base === d.baseKind,
      );
      if (!onchain) return undefined;
      const amt = Number(ethers.formatUnits(onchain.baseReserve, onchain.baseDecimals));
      const usdPer = isStableBase(onchain.base) ? 1 : await getEthUsd(cc.wethAddress, cc).catch(() => null);
      if (usdPer === null) return undefined;
      // Both sides are worth roughly the base side at the current price, so the pool holds
      // about twice what the base reserve alone shows.
      return { tvl: msg.usdCompact(amt * usdPer * 2), onchain: true };
    } catch {
      return undefined;
    }
  })();
  // The base the POOL contract actually holds. Always readable, index or no index -- and
  // it is the pool's liquidity, not this position's capital.
  const poolBaseWei = await (async () => {
    try {
      const hit = (await discoverAllPools(rec.ca, cc).catch(() => [])).find(
        (p) => p.fee === rec.fee && p.base === d.baseKind,
      );
      return hit ? hit.baseReserve : null;
    } catch {
      return null;
    }
  })();
  const text = msg.msgPositionCard({
    pool: poolRow,
    poolDepth: poolBaseWei === null ? undefined : `${msg.cleanUnits(poolBaseWei, d.baseDecimals)} ${d.baseSymbol}`,
    // In range = already filling, so 0%. Otherwise the distance to the NEARER end of the
    // range: how far the price still has to travel before this position does anything.
    // Same rule as the v4 card: a property of the POOL. v3 fee tiers map to fixed tick
    // spacings, so the fee is what sets how tightly a position can sit.
    fillsLabel: (() => {
      const spacing = rec.fee === 100 ? 1 : rec.fee === 500 ? 10 : rec.fee === 3000 ? 60 : 200;
      const t = (Math.pow(1.0001, spacing) - 1) * 100;
      return `\u2264${t < 1 ? t.toFixed(1) : Math.round(t)}%`;
    })(),
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    fee: rec.fee,
    invest,
    pnlText,
    range,
    mcRange,
    inRange: d.inRange,
    age: msg.fmtAge(Date.now() - rec.openedAt),
    dryRun: config.safety.dryRun,
    chain: cc.label,
    baseSymbol: d.baseSymbol,
    side: rec.side,
    converted: !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below'),
    feeIsTickSpacing: cc.slipstream,
    ladder,
  });
  const extra = {
    ...html,
    // The same four buttons as the v4 card: one position card, one set of actions,
    // whichever protocol it sits on. Fees are harvested from /claim_fees, which covers
    // both protocols on every chain.
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', `back:card:${rec.tokenId}`)],
      // Straight to the executor, no confirmation card -- the same shape as swap, bridge
      // and withdraw. `stop:` (which asks first) stays registered for older cards.
      [Markup.button.callback('⛔ Close Position', `close:${rec.tokenId}`)],
      [Markup.button.callback('⬅️ Positions', 'positions')],
    ]),
  };
  return { text, extra };
}

/** A compact card for one position, with Close and Detail buttons. */
async function renderPositionCard(ctx: any, rec: store.PosRecord, edit: boolean) {
  const { text, extra } = await buildPositionCard(rec);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

/**
 * The detail card for a NEWLY opened v4 position. The v3 path always sends two things
 * after success — "LP Created", then the position card — while v4 (single and ladder)
 * stopped at the first, so a new v4 position never immediately showed its range,
 * strategy or range status.
 *
 * The caller has already invalidated the v4 list cache, so the read here is fresh.
 * A failed read must not fail an open that ALREADY succeeded — the position is real
 * and this card is only a view: /positions will still show it.
 */
async function replyV4Card(ctx: any, cc: ChainCtx, tokenId: string | null | undefined): Promise<void> {
  if (!tokenId) return;
  try {
    const list = await listPositionsV4(cc);
    const p = list.find((x) => x.tokenId === tokenId);
    if (!p) return;
    const ethUsd = await getEthUsd(cc.wethAddress, cc).catch(() => null);
    const c = await buildV4Card(p, ethUsd, cc);
    await ctx.reply(c.text, c.extra);
  } catch (e) {
    console.error('[open v4] the detail card failed:', (e as Error).message.slice(0, 120));
  }
}

/** The detail view (composition, value, fees). */
async function renderPositionDetail(ctx: any, rec: store.PosRecord, edit: boolean) {
  const cc = ctxOf(rec);
  const d = await getPositionDetail(rec.tokenId, cc);
  const valF = Number(ethers.formatUnits(d.valueBaseWei, d.baseDecimals));
  const feeF = Number(ethers.formatUnits(d.feesBaseWei, d.baseDecimals));
  const valUsd = await baseToUsd(d.baseKind, valF, cc);
  const feeUsd = await baseToUsd(d.baseKind, feeF, cc);
  const value =
    `${msg.cleanUnits(d.valueBaseWei, d.baseDecimals)} ${d.baseSymbol}` +
    (valUsd !== null ? ` (${msg.usdPlain(valUsd)})` : '');
  const fees =
    `${msg.cleanUnits(d.feesBaseWei, d.baseDecimals)} ${d.baseSymbol}` +
    (feeUsd !== null ? ` (${msg.usdPlain(feeUsd)})` : '');
  const composition =
    `${msg.cleanUnits(d.baseAmountWei, d.baseDecimals)} ${d.baseSymbol} + ${msg.cleanUnits(d.otherAmountWei, d.otherDecimals)} ${d.otherSymbol}`;
  const text = msg.msgPositionDetail({
    tokenId: rec.tokenId,
    symbol: rec.symbol,
    fee: rec.fee,
    composition,
    value,
    fees,
    inRange: d.inRange,
    chain: cc.label,
    baseSymbol: d.baseSymbol,
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⬅️ Back', `back:card:${rec.tokenId}`),
        Markup.button.callback('🔄 Refresh', `detail:${rec.tokenId}`),
      ],
    ]),
  };
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

/**
 * Close a position: write its history to the JOURNAL (a separate file), then remove it
 * from the live store. The exception: when leftover tokens failed to swap (`keep`), the
 * record is held as STOPPED so the monitor's sweep can recover them. That keeps
 * /positions clean (live only) while the history lives in /history.
 */
function finalizeClose(
  tokenId: string,
  opts: { resultEthWei?: bigint; reason: journal.JournalEntry['reason']; keep?: boolean; leftoverWei?: bigint; groupId?: string },
) {
  // A position being closed through the manual path: only that path ('cashed') may
  // journal it, because it holds the result figure. A render or sync that happens to
  // see the NFT gone ('gone') must not get there first, or PnL is permanently 0.
  if (opts.reason !== 'cashed' && closingInFlight.has(tokenId)) return;
  const rec = store.get(tokenId);
  // A position cannot legitimately vanish seconds after it was minted, but the RPC
  // says it did: reading a brand-new tokenId from a node that has not caught up
  // reverts with "invalid token id" -- the exact revert isGoneErr treats as proof of
  // a burn. That killed #1092561 664ms after its mint; sync then re-imported it as a
  // stray with no entry price, so its PnL read "entry unknown" forever. Only 'gone'
  // is held back, and only briefly: a real burn is still caught by the next sweep.
  const GRACE_MS = 60_000;
  if (opts.reason === 'gone' && rec?.openedAt && Date.now() - rec.openedAt < GRACE_MS) {
    console.log(`[gone] #${tokenId} ignored: only ${Math.round((Date.now() - rec.openedAt) / 1000)}s old, the RPC is probably behind`);
    return;
  }
  // Journal exactly once, on the transition out of ACTIVE, to avoid a duplicate when
  // the close button is tapped again on an already-closed position.
  if (rec && rec.status === 'ACTIVE') journal.recordClose(rec, opts);
  if (opts.keep) {
    store.update(tokenId, {
      status: 'STOPPED',
      stoppedAt: Date.now(),
      ...(opts.resultEthWei !== undefined ? { resultEthWei: opts.resultEthWei.toString() } : {}),
      ...(opts.leftoverWei !== undefined ? { leftoverWei: opts.leftoverWei.toString() } : {}),
    });
  } else {
    store.remove(tokenId);
  }
}

/**
 * Ids of our v4 positions born since `from` — used to recover NFTs that did get minted
 * while the open flow failed part-way through. Returns the ids in order (mint order is
 * leg order).
 */
async function adoptStrayV4(
  cc: ReturnType<typeof getChain>,
  from: bigint | null,
  legs = 8,
): Promise<string[]> {
  // The id read is RETRIED: on 29 Aug 2026 an RPC answered 503 at the exact moment a
  // ladder was opening, so `from` could not be read AND the recovery gave up with it —
  // eight positions were born on chain with no record at all, then vanished from /positions.
  let to: bigint | null = null;
  for (let i = 0; i < 3 && to === null; i++) {
    to = await v4NextTokenId(cc).catch(() => null);
    if (to === null) await sleep(700);
  }
  if (to === null) return [];
  // Without `from` (the initial read failed), step back one window from the latest id.
  // Wider than the leg count, because other wallets share the same counter.
  const window = BigInt(legs * 4 + 32);
  const start = from ?? (to > window ? to - window : 0n);
  const ids = await v4OwnedIdsInRange(cc, start, to, 160).catch(() => []);
  // Anything ALREADY recorded is not a "stray" — recovering it again would drag another
  // group's positions into the new group.
  return ids.filter((id) => !v4store.getV4(id));
}

/** The detail card for one v4 position (value + range% + PnL when bot-managed), plus buttons. */
/**
 * The BaseKind for a v4 position on this chain. `'USDG'` inside the v4 module means
 * "this chain's stablecoin base", not the USDG token literally — on BSC it is USDT.
 * Mapping it rigidly to 'usdg' gets the decimals and symbol wrong the moment v4 is
 * enabled on another chain.
 */
/** The v4 base asset's address on this chain, used to quote the token side. */
function baseAddrOf(cc: ChainCtx, base: 'ETH' | 'USDG' | null): string | null {
  if (base === 'ETH') return cc.wethAddress;
  if (base !== 'USDG') return null;
  return cc.bases.find((b) => isStableBase(b.kind))?.address ?? null;
}

function v4Kind(cc: ChainCtx, base: 'ETH' | 'USDG' | null): store.PosRecord['baseKind'] {
  if (base !== 'USDG') return 'weth';
  return (cc.bases.find((b) => isStableBase(b.kind))?.kind ?? 'usdg') as store.PosRecord['baseKind'];
}

async function buildV4Card(p: V4Position, ethUsdV4: number | null, cc = getChain()): Promise<{ text: string; extra: Record<string, unknown> }> {
  const tracked0 = v4store.getV4(p.tokenId);
  const feeLabel = p.dynamicFee ? 'dynamic' : `${(p.fee / 10000).toFixed(p.fee % 100 ? 2 : 0)}%`;
  const dec = v4BaseDecimals(cc, p.base);
  let valueLabel = '—';
  let feesLabel: string | undefined;
  // Value = principal + fees. Without the breakdown the card can look like "only -3.6%"
  // when the principal is -19% and fees are covering the difference — split on purpose.
  if (p.feesBaseWei !== null && p.feesBaseWei > 0n && p.valueBaseWei !== null) {
    const fd = v4BaseDecimals(cc, p.base);
    const f = Number(ethers.formatUnits(p.feesBaseWei, fd));
    const ent = tracked0 ? Number(ethers.formatUnits(BigInt(tracked0.entryBaseWei), fd)) : 0;
    const pct = ent > 0 ? ` (+${((f / ent) * 100).toFixed(1)}% of capital)` : '';
    feesLabel = `${f.toFixed(fd >= 18 ? 5 : 2)} ${p.base ?? ''}${pct}`;
  }
  if (p.valueBaseWei !== null && p.base === 'ETH') {
    const eth = Number(ethers.formatEther(p.valueBaseWei + (p.feesBaseWei ?? 0n)));
    valueLabel = ethUsdV4 !== null ? `${msg.usdPlain(eth * ethUsdV4)}  (${eth.toFixed(5)} ETH)` : `${eth.toFixed(5)} ETH`;
  } else if (p.valueBaseWei !== null && p.base === 'USDG') {
    valueLabel = `${Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), 6)).toFixed(2)} USDG`;
  }
  const tracked = tracked0;
  // Range % is PINNED to the ENTRY tick when one is stored, so the number stays still
  // rather than wobbling on every refresh. It falls back to live (relative to the
  // current price) for positions without an entryTick. Both the range bounds AND the
  // current price are computed in ONE space: the pool tick, pinned to entryTick. "now"
  // used to come from DexScreener while the bounds came from the tick, so the card
  // could say IN RANGE while "now" appeared to sit outside them.
  const anchored = ((): { pcts: [number, number]; nowPct: number | null } | null => {
    if (tracked?.entryTick === undefined) return null;
    const sgn = tracked.baseIsCurrency0 ? -1 : 1;
    const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - tracked.entryTick!)) - 1) * 100;
    return {
      pcts: [pctOf(p.tickUpper), pctOf(p.tickLower)].sort((a, b) => b - a) as [number, number],
      nowPct: p.currentTick !== null ? pctOf(p.currentTick) : null,
    };
  })();
  const anchoredPcts = anchored?.pcts ?? null;
  // The range percentages are measured from the CURRENT price, so they move as the
  // token falls: "how much further to either end from here". The absolute bounds stay
  // still and are shown by the mcap line below (pinned to entry). These percentages
  // used to be pinned to entry too, which froze them and made the range look dead.
  const rangeLabel =
    p.rangePctHigh !== null && p.rangePctLow !== null
      ? `${msg.fmtPct(p.rangePctHigh)} / ${msg.fmtPct(p.rangePctLow)}`
      : anchoredPcts
        ? `${msg.fmtPct(anchoredPcts[0])} / ${msg.fmtPct(anchoredPcts[1])}`
        : '—';
  let pnlText: string | undefined;
  if (tracked && p.valueBaseWei !== null && p.base) {
    const curF = Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), dec));
    const entF = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
    // LP Agent-style USD PnL when entryEthUsd is stored (movement in the base price is counted).
    const nowUsdPer = p.base === 'USDG' ? 1 : ethUsdV4;
    if (tracked.entryEthUsd && tracked.entryEthUsd > 0 && nowUsdPer !== null) {
      const entryUsd = entF * tracked.entryEthUsd;
      const pnlUsd = curF * nowUsdPer - entryUsd;
      const pct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
      pnlText = `${msg.usdSigned(pnlUsd)} (${msg.fmtPct(pct)})`;
    } else {
      const pnlF = curF - entF;
      const pct = entF > 0 ? (pnlF / entF) * 100 : 0;
      pnlText =
        p.base === 'ETH' && ethUsdV4 !== null
          ? `${msg.usdSigned(pnlF * ethUsdV4)} (${msg.fmtPct(pct)})`
          : `${pnlF >= 0 ? '+' : ''}${pnlF.toFixed(dec >= 18 ? 5 : 2)} ${p.base} (${msg.fmtPct(pct)})`;
    }
  }
  // Dying-pool guard: compare the token price according to THIS pool's slot0 with the
  // MARKET price (DexScreener's deepest pool). A wide gap means a thin pool, and the
  // price and range on the card cannot be trusted (exactly the PEPE case in a $25 pool).
  let priceWarn: string | null = null;
  const baseSymbol = p.base ? v4BaseSymbol(cc, p.base) : undefined;
  const tokenSymbol = baseSymbol ? [p.sym0, p.sym1].find((s) => s !== baseSymbol) : undefined;
  // Market cap: the current capitalisation plus the value at each range bound (MC is
  // proportional to price, so MC@bound = MC_now x (1 + pct/100)). Matches the V3 card's
  // mcap sub-line.
  let mcRange: string | undefined;
  let mcPool: number | null = null;
  let mcMarket: number | null = null;
  {
    const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
    const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
    const tokenAddr = [p.poolKey.currency0, p.poolKey.currency1].find((a) => !isEth(a) && !isUsdg(a));
    const mcNow = tokenAddr ? await explore.tokenMarketCap(cc, tokenAddr).catch(() => null) : null;
    mcMarket = mcNow;
    // The mcap bounds are PINNED to entryMcap plus the range % from entry, so they stay
    // still. mcNow is shown as "now" (a live reference). Falls back to live when no
    // entry value is stored.
    if (anchoredPcts && tracked?.entryMcap) {
      const at = (pct: number) => explore.usdShort(tracked.entryMcap! * (1 + pct / 100));
      // "now" comes from the pool tick, keeping it in line with the range bounds, the IN RANGE status and PnL.
      mcPool = anchored?.nowPct != null ? tracked.entryMcap * (1 + anchored.nowPct / 100) : null;
      const shown = mcPool ?? mcNow;
      const nowStr = shown !== null ? ` · now ${explore.usdShort(shown)}` : '';
      mcRange = `${at(anchoredPcts[0])} ⇄ ${at(anchoredPcts[1])}${nowStr}`;
    } else if (mcNow !== null && p.rangePctHigh !== null && p.rangePctLow !== null) {
      const at = (pct: number) => explore.usdShort(mcNow * (1 + pct / 100));
      mcRange = `${at(p.rangePctHigh)} ⇄ ${at(p.rangePctLow)} · now ${explore.usdShort(mcNow)}`;
    }
  }
  // Dying-pool guard: compare the pool's mcap (the one the card uses) with the market's.
  // Replaces the old check, which only ran for ETH pairs — USDG pairs used to pass with
  // no inspection at all.
  if (mcPool !== null && mcMarket !== null && mcPool > 0 && mcMarket > 0) {
    const ratio = mcPool / mcMarket;
    if (ratio > 1.25 || ratio < 0.8) {
      const x = ratio >= 1 ? ratio : 1 / ratio;
      priceWarn = `this pool prices the token ${x.toFixed(1)}× the market (market ${explore.usdShort(mcMarket)}) — liquidity is thin, and the value and range above follow this pool, not the market.`;
    }
  }
  // A summary of the WHOLE ladder for a single leg's card. What the user deposited is a
  // ladder, not one rung, and without this block the leg card shows a value and PnL for
  // a fraction of the capital and reads misleadingly. The data comes from the already
  // cached v4 list (45s), so there is no per-leg read.
  const ladderSum = tracked?.groupId
    ? await (async () => {
        const legs = v4store.groupV4(tracked.groupId!);
        if (legs.length < 2) return undefined;
        const live = await listPositionsV4(cc).catch(() => [] as V4Position[]);
        const byId = new Map(live.map((x) => [x.tokenId, x]));
        let filled = 0;
        let active = 0;
        let valWei = 0n;
        let feeWei = 0n;
        let depWei = 0n;
        let lo: number | null = null;
        let hi: number | null = null;
        let seen = 0;
        let baseWei = 0n;
        let otherWei = 0n;
        let otherAddr: string | null = null;
        for (const l of legs) {
          depWei += BigInt(l.entryBaseWei || '0');
          const x = byId.get(l.tokenId);
          if (!x) continue;
          seen++;
          if (x.inRange) active++;
          else if (x.converted) filled++;
          if (x.valueBaseWei !== null) valWei += x.valueBaseWei;
          feeWei += x.feesBaseWei ?? 0n;
          baseWei += x.baseAmountWei ?? 0n;
          otherWei += x.otherAmountWei ?? 0n;
          otherAddr = otherAddr ?? x.otherAddress;
          lo = lo === null ? x.tickLower : Math.min(lo, x.tickLower);
          hi = hi === null ? x.tickUpper : Math.max(hi, x.tickUpper);
        }
        // THE VALUE YOU CAN ACTUALLY GET, not a notional market price.
        //
        // valueBaseWei marks the token side at the CURRENT pool price. For a position as
        // large as its pool is deep, that figure can never be realised: selling moves the
        // price. On 28 Aug 2026 the card read "+10.2%" and the close came out at -5.5% —
        // Relay refused the route with "swap impact 31.06%". So the token side is QUOTED
        // for real; if the quote fails it falls back to the pool price, but is flagged so
        // it is not read as a firm number.
        let quotedOtherWei: bigint | null = null;
        if (otherWei > 0n && otherAddr && baseAddrOf(cc, p.base)) {
          const q = await previewSwapOut(otherAddr, baseAddrOf(cc, p.base)!, otherWei, cc).catch(() => null);
          quotedOtherWei = q ? q.out : null;
        }
        const realWei = quotedOtherWei === null ? valWei : baseWei + quotedOtherWei;
        const markVal = Number(ethers.formatUnits(valWei + feeWei, dec));
        const val = Number(ethers.formatUnits(realWei + feeWei, dec));
        // A wide gap between the market price and the sale proceeds means a thin pool.
        const impactPct = markVal > 0 ? ((markVal - val) / markVal) * 100 : 0;
        const dep = Number(ethers.formatUnits(depWei, dec));
        const pnl = val - dep;
        const pct = dep > 0 ? (pnl / dep) * 100 : 0;
        const usdPer = p.base === 'USDG' ? 1 : ethUsdV4;
        // The ladder's range spans the outermost edges of every leg, pinned to the same
        // entry as the leg's mcap line so the two lines can be compared directly.
        let mcRangeLadder: string | undefined;
        if (lo !== null && hi !== null && tracked.entryMcap && tracked.entryTick !== undefined) {
          const sgn = tracked.baseIsCurrency0 ? -1 : 1;
          const mcOf = (tk: number) => tracked.entryMcap! * Math.pow(1.0001, sgn * (tk - tracked.entryTick!));
          // Sort by VALUE, not by tick order: with base = currency0 a rising tick means a
          // falling mcap, so the highest tick is actually the lower bound.
          const ends = [mcOf(lo), mcOf(hi)].sort((x, y) => y - x);
          const nowStr = p.currentTick !== null ? ` · now ${explore.usdShort(mcOf(p.currentTick))}` : '';
          mcRangeLadder = `${explore.usdShort(ends[0])} ⇄ ${explore.usdShort(ends[1])}${nowStr}`;
        }
        return {
          valueLabel: seen ? `${val.toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''}` : undefined,
          exitNote:
            quotedOtherWei === null && otherWei > 0n
              ? 'token side priced at pool rate, not a live quote'
              : impactPct >= 2
                ? `after ${msg.fmtPct(-impactPct)} price impact on the token side`
                : undefined,
          feesLabel: feeWei > 0n ? `${Number(ethers.formatUnits(feeWei, dec)).toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''}` : undefined,
          pnlText: seen
            ? usdPer !== null
              ? `${msg.usdSigned(pnl * usdPer)} (${msg.fmtPct(pct)})`
              : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''} (${msg.fmtPct(pct)})`
            : undefined,
          mcRange: mcRangeLadder,
          filled,
          active,
          waiting: legs.length - filled - active,
        };
      })()
    : undefined;
  // The pool this position sits in, matched out of the token's pools by fee. One
  // lookup per card open, and a failure just drops the line -- a position card must
  // still render when the pool index is down.
  const poolRow = await (async () => {
    if (!tokenSymbol) return undefined;
    const tokenAddr = [p.poolKey.currency0, p.poolKey.currency1].find(
      (a) => a !== ethers.ZeroAddress && a.toLowerCase() !== cc.wethAddress.toLowerCase() && !cc.bases.some((b) => b.address.toLowerCase() === a.toLowerCase()),
    );
    if (!tokenAddr) return undefined;
    // Matched on the POOL KEY, not the fee: these pools carry dynamic fees, so the fee
    // the gateway reports is the current effective one and drifts away from the fee
    // stored in the position (19990 against 20971 on the same pool).
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    const hit = (await explore.poolsForToken(cc, tokenAddr).catch(() => [])).find(
      (x) =>
        x.protocol === 'v4' &&
        x.poolKey &&
        same(x.poolKey.currency0, p.poolKey.currency0) &&
        same(x.poolKey.currency1, p.poolKey.currency1) &&
        Number(x.poolKey.tickSpacing) === Number(p.poolKey.tickSpacing) &&
        same(x.poolKey.hooks, p.poolKey.hooks),
    );
    if (!hit) {
      // The Uniswap index carries v4 on Robinhood only partially, so a live pool can be
      // missing from it entirely. DexScreener keys its v4 pairs by pool id, which is an
      // exact match -- without this the card read "TVL: —" on a pool holding real money.
      const dex = await explore.poolStatsV4Dex(cc, tokenAddr, poolIdV4(p.poolKey)).catch(() => null);
      if (!dex) return null; // known miss: neither source has this pool
      return {
        tvl: msg.usdCompact(dex.tvlUsd),
        vol: dex.vol24hUsd != null ? msg.usdCompact(dex.vol24hUsd) : undefined,
        // Fees over TVL, annualised, the same way the index computes it: 24h fees are
        // volume * fee. A dynamic fee makes this an estimate, hence '?' when unknown.
        apr: (() => {
          const feeFrac = Number(p.poolKey.fee) / 1e6;
          if (!dex.vol24hUsd || !dex.tvlUsd || !isFinite(feeFrac) || feeFrac <= 0) return '?';
          const a = ((dex.vol24hUsd * feeFrac) / dex.tvlUsd) * 365 * 100;
          return `~${a >= 100 ? Math.round(a) : a.toFixed(1)}%`;
        })(),
      };
    }
    return {
      tvl: msg.usdCompact(hit.tvlUsd),
      vol: hit.vol24hUsd != null && hit.vol24hUsd > 0 ? msg.usdCompact(hit.vol24hUsd) : undefined,
      apr: hit.aprPct == null ? '?' : `~${hit.aprPct >= 100 ? Math.round(hit.aprPct) : hit.aprPct.toFixed(1)}%`,
    };
  })();
  // The pool's own depth at the current price, in base units. Read from the chain, so it
  // is there even while the index has no entry for this pool.
  const depthWei = await poolDepthV4(cc, p.poolKey);
  const depthLabel = depthWei === null ? undefined : `${msg.cleanUnits(depthWei, dec)} ${p.base ?? ''}`.trim();
  const text = msg.msgV4Position({
    tokenId: p.tokenId,
    pair: `${p.sym0} / ${p.sym1}`,
    feeLabel,
    valueLabel,
    feesLabel,
    rangeLabel,
    inRange: p.inRange,
    pnlText,
    tracked: !!tracked,
    priceWarn,
    baseSymbol,
    tokenSymbol,
    age: tracked ? msg.fmtAge(Date.now() - tracked.openedAt) : undefined,
    pool: poolRow ?? undefined,
    poolUnindexed: poolRow === null,
    poolDepth: depthLabel,
    // A property of the POOL, not of this position: tick spacing sets how close to the
    // price a single-sided position can sit, and so how far price must move before one
    // starts filling. Measured from the position's own range instead, the same pool read
    // differently on two cards.
    fillsLabel: (() => {
      const t = (Math.pow(1.0001, Number(p.poolKey.tickSpacing) || 1) - 1) * 100;
      return `\u2264${t < 1 ? t.toFixed(1) : Math.round(t)}%`;
    })(),
    chain: cc.label,
    mcRange,
    converted: p.converted,
    ladder: tracked?.groupId
      ? (() => {
          const legs = v4store.groupV4(tracked.groupId!);
          const depWei = legs.reduce((s, l) => s + BigInt(l.entryBaseWei || '0'), 0n);
          // This leg's share of the whole ladder's capital, purely from stored data with
          // no extra RPC. Bid-ask puts the smallest weight on the top leg, so the leg that
          // fills first is usually the smallest one.
          const mine = BigInt(tracked.entryBaseWei || '0');
          return {
            sharePct: depWei > 0n ? Number((mine * 10000n) / depWei) / 100 : undefined,
            ...ladderSum,
            legIndex: tracked.legIndex ?? 0,
            legCount: tracked.legCount ?? legs.length,
            shape: tracked.shape ?? 'bidask',
            groupDeposit: legs.length > 1 ? msg.cleanUnits(depWei, dec) : undefined,
          };
        })()
      : undefined,
  });
  // The "➕ <size> ETH" button was removed: a money path with no screening, no preview
  // and no cap, using a default range of ~170% that was never shown. Add capital via /add.
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', `posv4:${p.tokenId}`)],
      // Straight to the executor, as on the v3 card. `closev4:` still asks, for older cards.
      [Markup.button.callback('⛔ Close Position', `closev4go:${p.tokenId}`)],
      [Markup.button.callback('⬅️ Positions', 'positions_refresh')],
    ]),
  };
  return { text, extra };
}

type PosRow = {
  id: string;
  pair: string;
  investLabel: string;
  age: string;
  pnlUsd: number | null;
  pnlPct: number | null;
  inRange: boolean;
  protocol?: string | null; // 'V3' | 'V4', printed in the row header
  chain?: string | null;    // the chain label, since a list can span chains
  wethEq: number; // the WETH equivalent for the invested total (USDG converts through ethUsd)
  strategy?: string | null;
  baseSymbol?: string | null; // the asset deposited; the side label follows it rather than a hard-coded 'ETH'
  rangeLabel?: string | null;
  feesLabel?: string | null;
  feesUsdLabel?: string | null;
  converted?: boolean;
  convertedInto?: string | null;
  feesBase?: number; // unclaimed fees in the base, for the footer total
  natSym?: string; // this position's chain native symbol; the total is only valid when they all match
  groupId?: string | null; // for a ladder, the leg rows are merged into one
  legShape?: string | null; // 'bidask' | 'spot'
};

/** Merge one ladder group's leg rows into a SINGLE aggregate row (mutates the array). */
function collapseLadderRows(rows: PosRow[]): void {
  const groups = new Map<string, PosRow[]>();
  for (const r of rows) if (r.groupId) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
  for (const [gid, legs] of groups) {
    if (legs.length < 2) continue;
    const base = legs[0];
    const unit = base.investLabel.replace(/^[\d.]+\s*/, '');
    const sumInvest = legs.reduce((s, r) => s + (parseFloat(r.investLabel) || 0), 0);
    const pnlVals = legs.map((r) => r.pnlUsd).filter((x): x is number => x !== null);
    const sumPnlUsd = pnlVals.length ? pnlVals.reduce((a, b) => a + b, 0) : null;
    const sumWethEq = legs.reduce((s, r) => s + r.wethEq, 0);
    const wsum = legs.reduce((s, r) => s + r.wethEq, 0) || 1;
    const pct = legs.reduce((s, r) => s + (r.pnlPct ?? 0) * r.wethEq, 0) / wsum;
    base.pair = `${base.pair}  ◣×${legs.length}`;
    base.investLabel = `${sumInvest.toFixed(sumInvest >= 1 ? 4 : 6)} ${unit}`.trim();
    base.pnlUsd = sumPnlUsd;
    base.pnlPct = pnlVals.length ? pct : null;
    base.wethEq = sumWethEq;
    base.inRange = legs.some((r) => r.inRange);
    base.rangeLabel = `${legs.length}-leg ${base.legShape ?? 'ladder'} · ${base.rangeLabel ?? ''}`;
    // Every leg but the first is DROPPED from the array below, so their fees have to move
    // onto the merged row first — otherwise an 8-leg ladder reports only leg 1's fees (and
    // the footer total loses the rest with it).
    const feeVals = legs.map((r) => r.feesBase).filter((v): v is number => typeof v === 'number');
    if (feeVals.length) {
      const sumFee = feeVals.reduce((a, b) => a + b, 0);
      base.feesBase = sumFee;
      base.feesLabel = `${sumFee.toFixed(sumFee >= 1 ? 4 : 6)} ${unit}`.trim();
      const usdVals = legs
        .map((r) => (r.feesUsdLabel ? Number(r.feesUsdLabel.replace(/[^0-9.-]/g, '')) : null))
        .filter((v): v is number => v !== null && Number.isFinite(v));
      base.feesUsdLabel = usdVals.length === feeVals.length ? `+${msg.usdPlain(usdVals.reduce((a, b) => a + b, 0))}` : null;
    }
    // Drop every leg but the first from the array.
    for (const r of legs.slice(1)) {
      const i = rows.indexOf(r);
      if (i >= 0) rows.splice(i, 1);
    }
  }
}

// /positions — ONE consolidated message: a summary plus a per-position tree (v3 + v4).
async function cmdPositions(ctx: any, edit = false) {
  const cc = getChain();
  // Pull in on-chain positions that are not yet recorded (opened since the last /start,
  // say) so /positions does not miss them. This function is fail-safe: a failed read
  // leaves the store untouched. Sync used to run only on /start, so a new position never
  // appeared.
  await syncOnChainPositions(cc).catch(() => {});
  const active = store.active();
  // v4 from EVERY chain that supports it, not just the active one.
  //
  // The v3 side has been cross-chain from the start (`store.active()` + `ctxOf(rec)`), but
  // v4 only ever read `cc` — the default chain. So three BSC v4 positions, recorded
  // perfectly well in v4store, never appeared in /positions while the active chain was
  // Robinhood: not lost, just never asked about.
  const v4 = (
    await Promise.all(
      Object.values(CHAINS)
        .filter((c) => v4Supported(c))
        .map(async (c) => (await listPositionsV4(c).catch(() => [])).map((p) => ({ cc: c, p }))),
    )
  ).flat();
  if (active.length === 0 && v4.length === 0) {
    const t = msg.msgNoPositions();
    return edit ? ctx.editMessageText(t, html).catch(() => {}) : ctx.reply(t, html);
  }
  const ethUsd = await getEthUsd(cc.wethAddress, cc).catch(() => null);

  // v3 (parallel RPC, stable order). A position that is gone (NFT burned) is finalised and dropped.
  const v3rows = await mapLimit(active, POS_CARD_CONCURRENCY, async (rec): Promise<PosRow | null> => {
    try {
      const rcc = ctxOf(rec); // the POSITION's chain, not the primary one
      const d = await getPositionDetail(rec.tokenId, rcc);
      const dec = d.baseDecimals;
      const curF = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, dec));
      const initF = rec.imported ? null : Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
      let pnlUsd: number | null = null;
      let pnlPct: number | null = null;
      if (initF !== null && initF > 0) {
        // LP Agent-style USD PnL when entryEthUsd is stored; otherwise the old ETH view.
        if (rec.entryEthUsd && rec.entryEthUsd > 0) {
          const nowUsdPer = isStableBase(d.baseKind) ? 1 : await getEthUsd(rcc.wethAddress, rcc).catch(() => null);
          if (nowUsdPer !== null) {
            const entryUsd = initF * rec.entryEthUsd;
            pnlUsd = curF * nowUsdPer - entryUsd;
            pnlPct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
          }
        } else {
          const pnlF = curF - initF;
          pnlPct = (pnlF / initF) * 100;
          pnlUsd = await baseToUsd(d.baseKind, pnlF, rcc);
        }
      }
      const investNum = initF ?? curF;
      const nativeUsd = await getEthUsd(rcc.wethAddress, rcc).catch(() => null);
      return {
        id: rec.tokenId,
        groupId: rec.groupId ?? null,
        legShape: rec.shape ?? null,
        pair: pairLabel(d.baseSymbol, rec.symbol),
        // rcc, not cc: this loop walks positions across EVERY chain, so the active
        // chain's label would be wrong for any position that is not on it.
        chain: rcc.label,
        protocol: 'V3',
        investLabel: `${investNum.toFixed(dec >= 18 ? 4 : 2)} ${d.baseSymbol}`,
        age: msg.fmtAge(Date.now() - rec.openedAt),
        pnlUsd,
        pnlPct,
        inRange: d.inRange,
        // Native equivalent for the TOTAL row: a stable is divided by THIS CHAIN's native
        // price (USDT on BSC by BNB), not the main chain's ETH price.
        wethEq: d.baseKind === 'weth' ? investNum : (nativeUsd ? investNum / nativeUsd : 0),
        natSym: rcc.nativeSymbol,
        // tickLower/Upper is in TICK terms; in TOKEN PRICE terms the order can be reversed
        // (depending which side the base sits on), so sort ascending first.
        // The card reads this back to decide the side, so use a stable marker
        // ('token'/'base') rather than a sentence that could change when text is reworded.
        strategy: rec.side === 'token' ? 'token' : 'base',
        baseSymbol: d.baseSymbol,
        // Fully converted means price has crossed the WHOLE range in its intended
        // direction: the base side waits for a FALL (done at 'below'), the token side
        // waits for a RISE (done at 'above').
        converted: !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below'),
        convertedInto: rec.side === 'token' ? d.baseSymbol : rec.symbol,
        rangeLabel: (() => {
          const a = Number(d.priceLower), b = Number(d.priceUpper);
          const [lo, hi] = a <= b ? [d.priceLower, d.priceUpper] : [d.priceUpper, d.priceLower];
          return `${lo} — ${hi} ${d.baseSymbol} per ${rec.symbol}`;
        })(),
        feesLabel: `${Number(ethers.formatUnits(d.feesBaseWei, dec)).toFixed(dec >= 18 ? 5 : 2)} ${d.baseSymbol}`,
        // Fees in USD (the design uses dollars). An unreadable price gives null and the
        // card falls back to base units; NEVER show a fake $0.00.
        feesUsdLabel: await baseToUsd(d.baseKind, Number(ethers.formatUnits(d.feesBaseWei, dec)), rcc)
          .then((v) => (v === null ? null : `+${msg.usdPlain(v)}`))
          .catch(() => null),
        feesBase: Number(ethers.formatUnits(d.feesBaseWei, dec)),
      };
    } catch (e) {
      if (isGoneErr(e)) {
        finalizeClose(rec.tokenId, { reason: 'gone' });
        return null;
      }
      return {
        id: rec.tokenId,
        pair: `#${rec.tokenId}`,
        protocol: 'V3',
        investLabel: 'read failed',
        age: '—',
        pnlUsd: null,
        pnlPct: null,
        inRange: false,
        wethEq: 0,
      };
    }
  });

  const rows: PosRow[] = v3rows.filter((r): r is PosRow => r !== null);

  // Each chain's native price, read once. Using the active chain's price for all of them
  // once inflated HyperEVM LP value 30-fold (see the same note in /pnl).
  const usdPerChain = new Map<string, number | null>();
  for (const { cc: pcc } of v4)
    if (!usdPerChain.has(pcc.key))
      usdPerChain.set(pcc.key, await getEthUsd(pcc.wethAddress, pcc).catch(() => null));

  // v4 (read-only, plus PnL when bot-managed).
  for (const { cc: pcc, p } of v4) {
    const ethUsd = usdPerChain.get(pcc.key) ?? null;
    const dec = v4BaseDecimals(pcc, p.base);
    const tracked = v4store.getV4(p.tokenId);
    const curF = p.valueBaseWei !== null ? Number(ethers.formatUnits(p.valueBaseWei + (p.feesBaseWei ?? 0n), dec)) : null;
    let investNum = curF ?? 0;
    let pnlUsd: number | null = null;
    let pnlPct: number | null = null;
    if (tracked) {
      const entF = Number(ethers.formatUnits(BigInt(tracked.entryBaseWei), dec));
      investNum = entF;
      if (curF !== null && entF > 0) {
        const nowUsdPer = p.base === 'USDG' ? 1 : ethUsd;
        if (tracked.entryEthUsd && tracked.entryEthUsd > 0 && nowUsdPer !== null) {
          const entryUsd = entF * tracked.entryEthUsd;
          pnlUsd = curF * nowUsdPer - entryUsd;
          pnlPct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
        } else {
          const pnlF = curF - entF;
          pnlPct = (pnlF / entF) * 100;
          pnlUsd = p.base === 'ETH' ? (ethUsd !== null ? pnlF * ethUsd : null) : pnlF; // USDG ≈ $1
        }
      }
    }
    const sym = v4BaseSymbol(pcc, p.base);
    rows.push({
      id: p.tokenId,
      groupId: tracked?.groupId ?? null,
      legShape: tracked?.shape ?? null,
      pair: `${p.sym0} / ${p.sym1}`,
      protocol: 'V4',
      chain: pcc.label,
      investLabel: `${investNum.toFixed(dec >= 18 ? 4 : 2)} ${sym}`,
      age: tracked ? msg.fmtAge(Date.now() - tracked.openedAt) : '—',
      pnlUsd,
      pnlPct,
      baseSymbol: sym,
      inRange: p.inRange ?? false, // null means unknown, and is treated as out of range, which is the conservative call
      wethEq: p.base === 'USDG' ? (ethUsd ? investNum / ethUsd : 0) : investNum,
      natSym: pcc.nativeSymbol,
      // v4 fees USED to be left out of the list row, so a v4 position that had been in
      // range for a long time still read "Uncollected Fees: —" as though it had harvested
      // nothing. The data was already in p.feesBaseWei — it just never got passed through.
      ...(p.feesBaseWei !== null && p.feesBaseWei !== undefined
        ? (() => {
            const f = Number(ethers.formatUnits(p.feesBaseWei, dec));
            const usdPer = p.base === 'USDG' ? 1 : ethUsd;
            return {
              feesLabel: `${f.toFixed(dec >= 18 ? 5 : 2)} ${sym}`,
              // An unreadable price gives null and the card falls back to base units. No fake $0.00.
              feesUsdLabel: usdPer !== null ? `+${msg.usdPlain(f * usdPer)}` : null,
              feesBase: f,
            };
          })()
        : {}),
    });
  }

  collapseLadderRows(rows);
  const totalWethEq = rows.reduce((s, r) => s + r.wethEq, 0);
  // Adding ETH to BNB and labelling it "WETH" produces a fictional number. The total is
  // only shown when EVERY position shares the same native denomination; when they are
  // mixed the total row is hidden (per-position figures stay correct).
  const units = new Set(rows.map((r) => r.natSym).filter(Boolean));
  const totalUnit = units.size === 1 ? [...units][0]! : null;
  const pnlVals = rows.map((r) => r.pnlUsd).filter((x): x is number => x !== null);
  const totalPnlUsd = pnlVals.length ? pnlVals.reduce((a, b) => a + b, 0) : null;
  const text = msg.msgPositionsList({
    dryRun: config.safety.dryRun,
    activeCount: rows.length,
    totalInvestLabel: totalUnit ? `≈ ${totalWethEq.toFixed(4)} ${totalUnit}` : null,
    totalPnlUsd,
    outOfRange: rows.filter((r) => !r.inRange).length,
    listDegraded: v4Supported(cc) && v4ListDegraded(),
    totalFeesLabel: (() => {
      // Fees can only be totalled when every position uses the same base. Today that is a
      // single base (WETH), but keep the guard anyway: skip when there is no data.
      if (!totalUnit) return null;
      const vals = rows.map((r) => r.feesBase).filter((v): v is number => typeof v === 'number');
      return vals.length ? `≈ ${vals.reduce((a, b) => a + b, 0).toFixed(5)} ${totalUnit}` : null;
    })(),
    rows,
  });

  // At most 6 buttons (a 7th position onward is still listed and reachable via /stop).
  // Each button repeats its block's header verbatim -- the same pair, id and protocol --
  // so there is nothing to match up by eye between the text and the row that opens it.
  // The id stays on the label because two positions can share a pool.
  const top = rows.slice(0, 6);
  const idBtns = top.map((r) =>
    Markup.button.callback(
      `$${msg.posPair(r.pair, r.baseSymbol)} | #${r.id}${r.protocol ? ` (${r.protocol})` : ''}`,
      `pos_detail_${r.id}`,
    ),
  );
  // One button per row, per the design.
  const kbRows: ReturnType<typeof Markup.button.callback>[][] = idBtns.map((b) => [b]);
  // Close All moves money and cannot be undone, so it sits alone rather than one slip
  // away from Refresh.
  kbRows.push([
    Markup.button.callback('🔄 Refresh', 'positions_refresh'),
  ]);
  kbRows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  kbRows.push([Markup.button.callback('⛔ Close All Positions', 'closeall_confirm')]);
  const extra = { ...html, ...Markup.inlineKeyboard(kbRows) };
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}
bot.command('positions', (ctx) => cmdPositions(ctx, false));

// Back from the position list to the menu card, EDITING the same message (no new bubble).
bot.action('positions_back', async (ctx) => {
  await ctx.answerCbQuery();
  const extra = { ...html, ...startKeyboard() };
  try {
    return await ctx.editMessageText(startCard(), extra);
  } catch {
    return ctx.reply(startCard(), extra); // the message is too old to edit
  }
});

// Refresh the position list (edits the same message).
bot.action('positions_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshing…');
  try {
    await cmdPositions(ctx, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // data sama — benign
    await ctx.reply(msg.msgError('positions', (e as Error).message), html);
  }
});

// One position's detail (from an #id button in the list) — the full v3 or v4 card.
bot.action(/^pos_detail_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery('Loading…');
  const rec = store.get(id);
  if (rec) {
    try {
      const c = await buildPositionCard(rec);
      return ctx.reply(c.text, c.extra);
    } catch (e) {
      return ctx.reply(msg.msgError('detail', (e as Error).message), html);
    }
  }
  try {
    // EVERY v4-capable chain, not just the default one. This looked only at getChain(),
    // so tapping Details on a BSC v4 position while pointed at Robinhood answered
    // "position not found" for a position sitting right there in the list above.
    let found: { cc: ReturnType<typeof getChain>; p: V4Position } | undefined;
    for (const c of Object.values(CHAINS).filter((x) => v4Supported(x))) {
      const hit = (await listPositionsV4(c).catch(() => [])).find((x) => x.tokenId === id);
      if (hit) { found = { cc: c, p: hit }; break; }
    }
    if (!found) return ctx.reply(msg.msgError('detail', 'position not found.'), html);
    const { cc, p } = found;
    const ethUsdV4 = p.base === 'ETH' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : null;
    const c = await buildV4Card(p, ethUsdV4, cc);
    return ctx.reply(c.text, c.extra);
  } catch (e) {
    return ctx.reply(msg.msgError('detail', (e as Error).message), html);
  }
});

// /history — closed trades, from the dedicated journal file (never shown in /positions).
// A pool button opens the full /add wizard (screening and preview still run).
bot.action(/^x:([a-z0-9_-]+):(0x[0-9a-fA-F]{40})$/i, async (ctx: any) => {
  await ctx.answerCbQuery();
  resetFlows(ctx.from!.id);
  return continueAddlp(ctx, ctx.match[2], ctx.match[1], null);
});
// The old chainless shape, for buttons in messages already sent.
bot.action(/^x:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  resetFlows(ctx.from!.id);
  return continueAddlp(ctx, ctx.match[1], getChain().key, null);
});

/** Step 1 of /add_lp with no CA: pairs from the top-APR pools, plus a search option. */
async function pairPicker(ctx: any) {
  const prog = await ctx.reply(msg.msgProgress('loading top pools…'), html);
  const pools = await explore.fetchTopPools(getChain(), 5).catch(() => []);
  const withCa = pools.filter((p) => p.otherAddr);
  const rows = withCa.map((p) => [
    Markup.button.callback(`${p.pair} · ${msg.feeLabel(p.feeTier)}`, `x:${p.otherAddr}`),
  ]);
  rows.push([Markup.button.callback('🔍 Search Your Own Pair', 'pair:custom')]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  await editProgress(ctx, prog, msg.msgPairPicker(withCa.length), { ...html, ...Markup.inlineKeyboard(rows) });
}

bot.action('pair:custom', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgPairCustom(), html);
});

// /pools is REMOVED for now (owner's request). The src/explore.ts module is STILL used
// by the /add_lp wizard (poolsForToken, fetchTopPools), so do not remove it too. To
// bring it back: restore cmdExplore + exploreKb + loadExplore, register
// bot.command('pools') and the 'explore'/'explore:refresh' actions, and the menu entry.

// Token security audit: paste a bare CA in the chat and it goes to startTokenHub. The
// /token_info command was removed — identical path, so it was only a second door to the
// same card.

bot.action(/^detail:(\d+)$/, async (ctx) => {
  const rec = store.get(ctx.match[1]);
  if (!rec) return ctx.answerCbQuery('Position not found.');
  await ctx.answerCbQuery('Loading…');
  try {
    await renderPositionDetail(ctx, rec, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // the data is unchanged, which is not an error
    await ctx.reply(msg.msgError('detail', (e as Error).message), html);
  }
});

bot.action(/^back:card:(\d+)$/, async (ctx) => {
  const rec = store.get(ctx.match[1]);
  if (!rec) return ctx.answerCbQuery('Position not found.');
  await ctx.answerCbQuery('Loading…');
  try {
    await renderPositionCard(ctx, rec, true);
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return; // the data is unchanged, which is not an error
    await ctx.reply(msg.msgError('card', (e as Error).message), html);
  }
});

// ---------- Phase 3: writes (the step-by-step /add wizard) ----------

/** Pool picker keyboard: pair (WETH/USDG) · fee · depth. The callback carries the base. */
const POOL_PICK_MAX = 3; // the top 3 by depth score (see poolSize); the rest are not offered

// A pool's tickSpacing: direct on v4; mapped from the standard fee tier on v3.
function poolSpacing(p: explore.TokenPool, cc: ChainCtx = getChain()): number {
  if (p.poolKey?.tickSpacing) return p.poolKey.tickSpacing;
  return cc.tickSpacing[p.fee] ?? 60;
}
// How close price has to move before a single-sided position STARTS filling. A range
// edge must be a multiple of tickSpacing, so worst case is about one spacing. Smaller
// spacing fills sooner.
function fillTightnessPct(p: explore.TokenPool): number {
  return (Math.pow(1.0001, poolSpacing(p)) - 1) * 100;
}
// A top pool can have coarse spacing (slower single-sided fill), which is why the
// 'fills<=x%' figure is printed on its card: the trade-off is visible before you tap.
//
// Depth threshold: a pool below this is not worth putting capital into, whatever its
// volume. Volume is NOT a substitute for depth — it is easy to fake.
export const MIN_POOL_TVL_USD = 1_000;
// Volume's weight in the ranking. TVL and volume are different units (a stock against a
// flow) and 24h volume routinely runs 10-30x TVL, so adding them raw makes the ranking
// effectively volume-only: it happened in production, where a $429k-TVL pool (with
// $12.8M volume) beat a $654k-TVL pool (with $6.7M). For an LP it is depth that sets
// execution risk and slippage, so TVL leads and volume only adds to the score rather
// than taking it over.
// Weighting alone is not enough: with volume routinely 30x TVL, even 0.25x still takes
// over the ranking. Volume's contribution is therefore CAPPED at the pool's own TVL —
// volume may double a score, never more. The effect: a deeper pool can never lose to one
// more than 2x shallower, however busy its (easily faked) volume.
const VOL_WEIGHT = 0.25;
// Pool ranking = depth plus a capped fee-activity bonus. Ties go to finer spacing.
const poolSize = (p: explore.TokenPool): number => {
  const tvl = p.tvlUsd;
  return tvl + Math.min(VOL_WEIGHT * (p.vol24hUsd ?? 0), tvl);
};
function rankPoolsForFill(pools: explore.TokenPool[]): explore.TokenPool[] {
  return [...pools].sort((a, b) => poolSize(b) - poolSize(a) || poolSpacing(a) - poolSpacing(b));
}

const tightLabel = (p: explore.TokenPool): string => {
  const t = fillTightnessPct(p);
  return `${t < 1 ? t.toFixed(1) : Math.round(t)}%`;
};

/** Pool summaries for the step-1 card (at most POOL_PICK_MAX, ordered by TVL). */
/**
 * A v4 pool whose fee lives in its HOOK, not in the pool.
 *
 * `fee = 0` here does not mean trading is free — the hook charges instead, and
 * printing "0.00% Fee" invites exactly the wrong conclusion about the best pool
 * on the card. The same reasoning applies to its APR: the pool fee is not the
 * fee, so the usual formula has nothing true to say.
 */
const hookFee = (p: explore.TokenPool): boolean =>
  p.protocol === 'v4' && p.fee === 0 && !!p.poolKey?.hooks && p.poolKey.hooks !== ethers.ZeroAddress;

/** Volume that proves a pool HAS traded, so a zero fee-growth reading means the
 *  fee went somewhere other than the LPs rather than that nothing happened yet. */
const NO_FEE_VOL_USD = 5_000;

const poolSummaries = (pools: explore.TokenPool[]) =>
  pools.slice(0, POOL_PICK_MAX).map((p) => ({
    pair: `${p.otherSymbol} / ${p.baseSymbol}`,
    ver: p.protocol.toUpperCase(),
    feeLabel: hookFee(p) ? 'dynamic' : msg.feeLabel(p.fee),
    tvl: msg.usdCompact(p.tvlUsd),
    vol: p.vol24hUsd != null && p.vol24hUsd > 0 ? msg.usdCompact(p.vol24hUsd) : '?',
    // A null APR means volume could not be read. '~0.0%' would invent a dead pool.
    // 'hook fee' says WHY it is absent, which '?' cannot.
    apr: hookFee(p) ? 'hook fee' : p.aprPct == null ? '?' : `~${p.aprPct >= 100 ? Math.round(p.aprPct) : p.aprPct.toFixed(1)}%`,
    tight: tightLabel(p),
  }));

function poolKeyboard(pools: explore.TokenPool[]) {
  return Markup.inlineKeyboard([
    ...pools.slice(0, POOL_PICK_MAX).map((p, i) => [
      Markup.button.callback(`${i + 1}. ${p.otherSymbol} / ${p.baseSymbol} (${hookFee(p) ? 'dynamic' : msg.feeLabel(p.fee)})`, `pick:${i}`),
    ]),
    // Refresh re-runs discovery: TVL, volume and APR here are read once and go stale
    // fast on a young token, and picking a pool off a five-minute-old APR is the whole
    // decision this card exists for.
    [Markup.button.callback('🔄 Refresh', 'pool:refresh')],
    // Back returns to the token's own card, which is where this step was entered from.
    [Markup.button.callback('⬅️ Back', 'hub:back'), Markup.button.callback('❌ Cancel', 'cancel')],
  ]);
}

/**
 * Discovery fallback: when the Uniswap gateway is down, use the on-chain v3 factory
 * (safe, and positions can still be opened). Maps a v3 PoolOption to a TokenPool
 * (TVL is approximated by baseReserve in USD).
 */
async function discoverAllPoolsFallback(token: string, cc: ChainCtx): Promise<explore.TokenPool[]> {
  const [raw, eu, otherSymbol] = await Promise.all([
    discoverAllPools(token, cc).then((ps) => ps.filter((p) => p.baseReserve > 0n)),
    getEthUsd(cc.wethAddress, cc).catch(() => null),
    new ethers.Contract(token, ERC20_ABI, cc.provider).symbol().catch(() => '?') as Promise<string>,
  ]);
  const mapped: explore.TokenPool[] = raw.map((p) => {
    const amt = Number(ethers.formatUnits(p.baseReserve, p.baseDecimals));
    const tvlUsd = p.base === 'usdg' ? amt : eu !== null ? amt * eu : amt;
    return { protocol: 'v3', base: p.base, baseSymbol: p.baseSymbol, otherSymbol, fee: p.fee, tvlUsd };
  });
  mapped.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return mapped;
}

/** Step 1/4 — pick a pool (pair plus fee tier). */
async function renderPoolStep(ctx: any, flow: AddFlow, edit: boolean) {
  const text = msg.msgPoolStep(
    `$${flow.pools[0]?.otherSymbol ?? '?'} (${getChain(flow.chain).label})`,
    poolSummaries(flow.pools),
  );
  const extra = { ...html, ...poolKeyboard(flow.pools) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Step 2/5 — pick the deposit side (the strategy). */
async function renderStrategyStep(ctx: any, flow: AddFlow, edit: boolean) {
  const sel = flow.selected;
  const base = wizardBase(flow);
  // The SAME summary row the pool picker showed, for the pool actually chosen -- built
  // from one formatter so the two screens cannot disagree about a pool's numbers.
  const selSummary = sel ? poolSummaries([sel])[0] : undefined;
  const text = msg.msgStrategyStep(
    sel ? `$${sel.otherSymbol}/${sel.baseSymbol}` : '?',
    base.symbol,
    sel?.otherSymbol ?? 'token',
    flow.plan?.currentPrice ? String(flow.plan.currentPrice) : null,
    selSummary,
  );
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`🟢 ${base.symbol} Side (Buy ${sel?.otherSymbol ?? 'Token'})`, 'strat:base')],
      [Markup.button.callback(`🔵 Token Side (Sell ${sel?.otherSymbol ?? 'Token'})`, 'strat:token')],
      [Markup.button.callback('⬅️ Back', 'back:pool'), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Step 4/5 — pick the range width (%). */
async function renderRangeStep(ctx: any, flow: AddFlow, edit: boolean) {
  const up = flow.strategy === 'token';
  const rows = RANGE_OPTIONS.map((o) => [
    Markup.button.callback(`${up ? '📈 +' : '📉 -'}${o.pct}% ${o.label}`, `rng:${o.pct}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'back:strategy'), Markup.button.callback('❌ Cancel', 'cancel')]);
  rows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  const text = msg.msgRangeStep(flow.strategy === 'token');
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Step 3/4 — pick the ETH amount. */
/** The base asset chosen in the wizard (weth/usdg/usdt). */
const wizardBase = (flow: AddFlow): BaseAsset => baseOf(getChain(flow.chain), flow.base ?? 'weth');
/** The wizard's ctx is the CHOSEN pool's chain and venue (Uniswap v3 on BSC has its own factory). */
const wizardCtx = (flow: AddFlow): ChainCtx => venueCtx(getChain(flow.chain), flow.selected?.venue);

/** Base-aware amount context: presets (from per-asset /size), symbol, limits, examples. */
function amountCtx(flow: AddFlow) {
  const base = wizardBase(flow);
  const stable = isStableBase(base.kind);
  // Token side: the unit is the token itself, so a fixed figure would be meaningless —
  // MAX_ETH_PER_TX does not apply here. But a limit STILL EXISTS: the token balance
  // actually held, read when the amount is typed (see the enforcement below).
  if (flow.strategy === 'token') {
    return {
      symbol: flow.selected?.otherSymbol ?? 'TOKEN',
      cap: Infinity, // replaced with the real balance before it is enforced
      capLabel: 'your full balance',
      example: '1000',
    };
  }
  // Each denomination has its own limit: ETH/BNB use MAX_ETH_PER_TX, USDT/USDG use
  // MAX_STABLE_PER_TX (a dollar figure, and not interchangeable).
  const cap = stable ? maxStable : maxEth;
  return {
    symbol: base.symbol,
    cap,
    capLabel: capLabelFor(cap, base.symbol),
    example: stable ? '50' : '0.02',
  };
}

async function renderAmountStep(ctx: any, flow: AddFlow, edit: boolean) {
  // The amount can be typed OR picked as a percentage of the balance. The percentage is
  // computed from the USABLE balance, not the raw one — see usableFor().
  flow.awaitingAmount = true;
  const a = amountCtx(flow);
  const rows: any[] = [];
  rows.push(...pctPresets.chunkButtons(pctPresets.get('add').map((p) => Markup.button.callback(`${p}%`, `amt:${p}`))));
  // Back goes to whichever step really precedes the amount now: the leg picker on a
  // ladder, the range picker otherwise.
  rows.push(
    [Markup.button.callback('⬅️ Back', flow.shape === 'bidask' && (flow.legs ?? 1) > 1 ? 'back:legs' : 'back:range')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  );
  // Balance (1 RPC; on failure '?' — never block this step).
  const dec = flow.strategy === 'token' ? (flow.tokenDec ?? 18) : wizardBase(flow).decimals;
  const raw = await rawBalanceFor(flow).catch(() => null);
  const balLabel = raw === null ? '?' : `${msg.cleanUnits(raw, dec)} ${a.symbol}`;
  const text = msg.msgAmountStep(a.symbol, a.capLabel, balLabel, a.example);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Balance percentages offered at the amount step. */

/** The raw balance of whichever side is being chosen (token / native / stablecoin). */
async function rawBalanceFor(flow: AddFlow): Promise<bigint> {
  const cc = wizardCtx(flow);
  if (flow.strategy === 'token') {
    return new ethers.Contract(flow.token, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
  }
  const base = wizardBase(flow);
  return base.wrappable
    ? cc.provider.getBalance(cc.wallet.address)
    : new ethers.Contract(base.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
}

/**
 * The balance that can ACTUALLY be deposited. For a native asset, gas is deducted
 * first: 90% of the raw balance would consume the gas, the wrap would succeed, the mint
 * would fail, and the money would be trapped as WETH. The token and stablecoin sides do
 * not pay gas out of themselves, so they are used in full.
 */
async function usableFor(flow: AddFlow): Promise<bigint> {
  const raw = await rawBalanceFor(flow);
  if (flow.strategy === 'token' || !wizardBase(flow).wrappable) return raw;
  const buf = await gasBuffer(wizardCtx(flow));
  return raw > buf ? raw - buf : 0n;
}

bot.action(/^amt:(\d{1,3})$/, async (ctx: any) => {
  await ctx.answerCbQuery();
  const flow = getFlow(ctx);
  if (!flow?.awaitingAmount) return;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  const pct = Number(ctx.match[1]);
  if (!pctPresets.get('add').includes(pct)) return;

  const dec = flow.strategy === 'token' ? (flow.tokenDec ?? 18) : wizardBase(flow).decimals;
  const usable = await usableFor(flow).catch(() => null);
  if (usable === null) return ctx.reply(msg.msgError('amount', 'Balance read failed — type the amount instead.'), html);
  if (usable <= 0n) {
    return ctx.reply(
      msg.msgError('amount', 'Nothing available to deposit on this side after the gas reserve.'),
      html,
    );
  }

  let wei = (usable * BigInt(pct)) / 100n;

  // The per-tx limit still applies to the buttons, exactly as it does to a typed amount.
  const a = amountCtx(flow);
  const capWei = a.cap === Infinity ? null : ethers.parseUnits(String(a.cap), dec);
  if (capWei !== null && wei > capWei) wei = capWei;
  if (wei <= 0n) return ctx.reply(msg.msgError('amount', 'That percentage rounds to zero.'), html);

  flow.awaitingAmount = false;
  flow.ethAmount = ethers.formatUnits(wei, dec);
  await planThenOpen(ctx, flow);
});


/**
 * The deposit amount is the LAST question, so setting it opens the position.
 *
 * The plan is still computed and shown -- it carries the range, the legs and the cost --
 * but as the card the progress then overwrites, not as a screen waiting for a second tap.
 * Every guard the Confirm button used to sit in front of still runs inside execAdd.
 */
async function planThenOpen(ctx: any, flow: AddFlow) {
  // No confirmation card: the amount IS the confirmation. One progress bubble is sent,
  // and every card execAdd writes from here on lands in it.
  const prog = await ctx.reply(msg.msgProgress('preparing the position…'), html);
  const point: any = Object.create(ctx);
  point.answerCbQuery = async () => {};
  point.editMessageText = async (text: string, extra?: any) =>
    ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, text, extra).catch(() => {});
  point.editMessageReplyMarkup = async (markup?: any) =>
    ctx.telegram.editMessageReplyMarkup(ctx.chat.id, prog.message_id, undefined, markup).catch(() => {});
  try {
    // Silent: the plan is still computed and stored on the flow -- execAdd needs the
    // range, the legs and the v4 leg list -- it is simply not shown as a card to tap.
    await renderPlanStep(point, flow, false, true);
  } catch (err) {
    return void (await point.editMessageText(msg.msgError('plan', (err as Error).message), html));
  }
  if (config.safety.dryRun) return void (await point.editMessageText(msg.msgDryRunAddDone(), html));
  return execAdd(point);
}

/** Step 4/4 — compute and show the plan, then confirm. */
async function renderPlanStep(ctx: any, flow: AddFlow, edit: boolean, silent = false) {
  if (flow.selected?.protocol === 'v4') return renderPlanStepV4(ctx, flow, edit, silent);
  const cc = wizardCtx(flow);
  const base = baseOf(cc, flow.base ?? 'weth');
  const isLadder = flow.strategy === 'base' && flow.shape === 'bidask' && (flow.legs ?? 1) > 1;
  // The plan and the cost estimate run in parallel (they are independent).
  const tokenSide = flow.strategy === 'token';
  const [planSettled, costSettled] = await Promise.allSettled([
    tokenSide
      ? planAddTokenSide(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc)
      : isLadder
        ? planLadderSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, flow.legs!, 'bidask', base, cc).then((legs) => legs[0])
        : planAddSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, base, cc),
    // The token side deposits no base, so only gas needs checking, not the base balance.
    estimateAddCost(cc, base, tokenSide ? '0' : flow.ethAmount!),
  ]);
  if (planSettled.status === 'rejected') throw planSettled.reason;
  const plan = planSettled.value;
  flow.plan = plan;
  // Ladder: compute EVERY leg for the preview and keep them for the confirm. pctHigh is
  // the nearest leg, pctLow the furthest, so the preview shows the combined range.
  let ladderNote: string | undefined;
  if (isLadder) {
    const legPlans = await planLadderSingleSided(flow.token, flow.fee!, flow.ethAmount!, flow.rangePct!, flow.legs!, 'bidask', base, cc);
    flow.ladderPlans = legPlans;
    const w = ladderWeights(legPlans.length, 'bidask');
    plan.pctHigh = legPlans[0].pctHigh;
    plan.pctLow = legPlans[legPlans.length - 1].pctLow;
    plan.priceLower = legPlans[legPlans.length - 1].priceLower;
    plan.priceUpper = legPlans[0].priceUpper;
    ladderNote =
      `\n\n◣ <b>BID-ASK ladder · ${legPlans.length} leg</b>\n` +
      legPlans
        .map((lp, i) => `  ${i + 1}. ${msg.fmtPct(lp.pctHigh)}…${msg.fmtPct(lp.pctLow)} · ${(w[i] * 100).toFixed(0)}% of capital`)
        .join('\n') +
      `\n<i>Bigger size the lower the price — that is the buy-the-dip shape.</i>`;
  } else {
    flow.ladderPlans = undefined;
  }
  let cost: Awaited<ReturnType<typeof estimateAddCost>> | null = null;
  if (costSettled.status === 'fulfilled') cost = costSettled.value;
  else console.log('[estimateAddCost] failed:', String(costSettled.reason).slice(0, 120));
  const depositUsd = tokenSide ? undefined : (await baseToUsd(base.kind, Number(flow.ethAmount!), cc)) ?? undefined;
  const text = msg.msgPlanStep({
    side: plan.side,
    depositSymbol: tokenSide ? plan.otherSymbol : plan.baseSymbol,
    screenDanger: flow.screenBahaya,
    screenFailed: flow.screenFailed,
    baseSymbol: plan.baseSymbol,
    symbol: plan.otherSymbol,
    fee: flow.fee!,
    depositAmount: flow.ethAmount!,
    depositUsd,
    pctHigh: plan.pctHigh,
    pctLow: plan.pctLow,
    currentPrice: String(plan.currentPrice),
    gasEth: cost?.gasEth ?? '?',
    needLabel: cost?.needLabel ?? '?',
    balanceLabel: cost?.balanceLabel ?? '?',
    shortLabel: cost?.shortLabel ?? null,
    costFailed: cost === null,
    priceLower: plan.priceLower,
    priceUpper: plan.priceUpper,
    dryRun: config.safety.dryRun,
  });
  const fullText = ladderNote ? text + ladderNote : text;
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Sign', 'addok')],
      [Markup.button.callback('⬅️ Back', isLadder ? 'back:legs' : 'back:range'), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  if (silent) return; // the plan is computed and stored; the caller shows its own card
  await (edit ? ctx.editMessageText(fullText, extra) : ctx.reply(fullText, extra));
}

// Map a range width (a percentage FALL in token price) to a number of tick spacings for
// a single-sided v4 position. The far edge is exactly X% down, so the factor is 1-X/100
// and widthTicks = |ln(1-X/100)|/ln(1.0001) — the same as v3's widthInTicks, for
// consistency. Rounded OUTWARD (ceil) so the range covers at least the X% requested.
function rangePctToSpacings(pct: number, tickSpacing: number): number {
  const frac = Math.min(Math.max(pct, 0.1), 95) / 100;
  const widthTicks = Math.abs(Math.log(1 - frac)) / Math.log(1.0001);
  return Math.max(1, Math.ceil(widthTicks / tickSpacing));
}

/** A v4 base amount in wei, at the base's own decimals (ETH 18, USDG 6). */
const v4AmountWei = (flow: AddFlow): bigint =>
  ethers.parseUnits(flow.ethAmount!, wizardBase(flow).decimals);

/** Step 4/4, the v4 version — a dry-run staticCall to validate, plus a range preview. */
async function renderPlanStepV4(ctx: any, flow: AddFlow, edit: boolean, silent = false) {
  const cc = getChain(flow.chain);
  const pool = flow.selected!;
  const pk = pool.poolKey!;
  const amountWei = v4AmountWei(flow);
  const isLadder = flow.shape === 'bidask' && (flow.legs ?? 1) > 1;
  let rangePctHigh: number;
  let rangePctLow: number;
  let ladderNote: string | undefined;
  if (isLadder) {
    // A v4 ladder: compute the legs (a batched modifyLiquidities) for the preview and keep them.
    const legs = await planLadderV4(cc, pk, pool.baseIsCurrency0!, amountWei, flow.rangePct!, flow.legs!, 'bidask');
    flow.v4LadderLegs = legs;
    const total = legs.reduce((s, l) => s + l.baseAmountWei, 0n);
    rangePctHigh = legs[0].pctHigh;
    rangePctLow = legs[legs.length - 1].pctLow;
    ladderNote =
      `\n\n◣ <b>BID-ASK ladder v4 · ${legs.length} leg · 1 tx atomik</b>\n` +
      legs
        .map((l, i) => `  ${i + 1}. ${msg.fmtPct(l.pctHigh)}…${msg.fmtPct(l.pctLow)} · ${((Number(l.baseAmountWei) / Number(total)) * 100).toFixed(0)}% of capital`)
        .join('\n') +
      `\n<i>Bigger size the lower the price — that is the buy-the-dip shape.</i>`;
  } else {
    flow.v4LadderLegs = undefined;
    const widthSpacings = rangePctToSpacings(flow.rangePct!, pk.tickSpacing);
    const sim = await openPositionV4(cc, pk, pool.baseIsCurrency0!, amountWei, { widthSpacings, dryRun: true });
    const val = await valuePositionV4(cc, pk, sim.tickLower, sim.tickUpper, sim.liquidity);
    rangePctHigh = val.rangePctHigh;
    rangePctLow = val.rangePctLow;
  }
  const depositUsd = (await baseToUsd(wizardBase(flow).kind, Number(flow.ethAmount!), cc)) ?? undefined;
  const text0 = msg.msgPlanStepV4({
    screenDanger: flow.screenBahaya,
    screenFailed: flow.screenFailed,
    baseSymbol: pool.baseSymbol,
    symbol: pool.otherSymbol,
    fee: pool.fee,
    tvlUsd: pool.tvlUsd,
    depositAmount: flow.ethAmount!,
    depositUsd,
    rangePctHigh,
    rangePctLow,
    dryRun: config.safety.dryRun,
  });
  const text = ladderNote ? text0 + ladderNote : text0;
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Sign', 'addok')],
      [Markup.button.callback('⬅️ Back', isLadder ? 'back:legs' : 'back:range'), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  if (silent) return; // the plan is computed and stored; the caller shows its own card
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/**
 * The rest of /add once the chain is known: screening -> pool -> wizard.
 * `prog` is the progress bubble being edited, to keep chat spam down.
 */
async function continueAddlp(
  ctx: any,
  token: string,
  chainKey: string,
  prog?: { message_id: number } | null,
  pre?: { bahaya: boolean; failed: boolean; reasons?: string[] }, // the hub already screened it, so do not repeat the work
) {
  const cc = getChain(chainKey);

  // 1+2) Screening and pool discovery are independent, so they run in PARALLEL (they
  // used to be serial: 4 HTTP calls plus ~18 RPCs, then GraphQL — worst case ~30s before
  // card 1/4 appeared). The display order is preserved: the SCREEN card first, then 1/4.
  prog = await editProgress(
    ctx,
    prog,
    msg.msgProgress(pre ? 'finding pools…' : `auditing token & finding pools on ${cc.label}…`),
  );
  const [screened, found, krystalFound, onchainFound] = await Promise.allSettled([
    pre ? Promise.resolve(null) : screenToken(token, cc),
    explore.poolsForToken(cc, token),
    krystal.krystalPools(cc, token),
    // Third source, read from the chain itself. Both indexers can be blind at the
    // same time — $RSTR was live with $86k of liquidity while each returned zero —
    // and from the outside that gap is indistinguishable from a token having no
    // pools at all.
    onchainV4Pools(cc, token),
  ]);

  let screenBahaya = pre?.bahaya ?? false;
  let screenFailed = pre?.failed ?? false;
  let bahayaReasons: string[] = pre?.reasons ?? [];
  if (!pre) {
    if (screened.status === 'fulfilled' && screened.value) {
      screenBahaya = screened.value.verdict === 'BAHAYA';
      bahayaReasons = screened.value.flags.filter((f) => f.level === 'BAHAYA').map((f) => f.msg);
      await ctx.reply(formatScreen(screened.value, { ca: token, chainLabel: cc.label }), html); // the screening card is its own message
    } else {
      screenFailed = true; // verification failed, so the warning travels on to the plan preview
      await ctx.reply(msg.msgScreeningFailed(), html);
    }
  }

  // Item 20 — a token judged DANGEROUS: LP is blocked, not merely flagged. A warning at
  // step 4 is one tap away from being ignored; here the flow stops.
  if (screenBahaya) {
    await editProgress(ctx, prog, msg.msgHighRiskBlocked(bahayaReasons));
    return;
  }

  let gwPools: explore.TokenPool[];
  if (found.status === 'fulfilled') {
    gwPools = found.value;
  } else {
    console.log('[poolsForToken] the gateway failed, falling back to on-chain v3:', String(found.reason).slice(0, 120));
    gwPools = await discoverAllPoolsFallback(token, cc).catch(() => []);
  }
  // Krystal is the complete pool source (the gateway often misses large-TVL ETH/token
  // pools and reports nonsense TVL). Its poolKey is already VERIFIED on-chain (the
  // Initialize event), so no re-resolution is needed and its fee is the real poolKey's.
  const kPools = krystalFound.status === 'fulfilled' ? krystalFound.value : [];
  if (krystalFound.status === 'rejected')
    console.log('[krystal] failed:', String(krystalFound.reason).slice(0, 120));
  const oPools = onchainFound.status === 'fulfilled' ? onchainFound.value : [];
  if (onchainFound.status === 'rejected')
    console.log('[onchain] failed:', String(onchainFound.reason).slice(0, 120));
  const poolIdOf = (p: explore.TokenPool): string | null =>
    p.poolKey
      ? ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['tuple(address,address,uint24,int24,address)'],
            [[p.poolKey.currency0, p.poolKey.currency1, p.poolKey.fee, p.poolKey.tickSpacing, p.poolKey.hooks]],
          ),
        )
      : null;
  const kIds = new Set(kPools.map(poolIdOf).filter(Boolean) as string[]);
  // v3 has no poolId, so it is deduplicated per (venue+base+fee) — one token+DEX+base+fee
  // is one v3 pool. The venue MUST be part of it: Uniswap v3 and PancakeSwap v3 on BSC can
  // share a base and fee yet be two different pools in two different factories.
  const v3Key = (p: explore.TokenPool) => `v3:${p.venue ?? ''}:${p.base}:${p.fee}`;
  const kV3 = new Set(kPools.filter((p) => p.protocol === 'v3').map(v3Key));

  // Gateway: v3 is still filtered to standard fee tiers, while a v4 poolKey is validated
  // and resolved on-chain (currency order and native-ETH handling are often wrong). Pools
  // already present from Krystal (by poolId) are dropped here to avoid duplicates. There
  // is NO fee cap any more: genuine Robinhood pools tend to carry high fees (5%+), and
  // what separates a real pool from a trap is TVL and liquidity, not the fee.
  const gwFixed = (
    await Promise.all(
      gwPools
        // feeTiers is tested against THAT pool's VENUE (Uniswap 3000 against PancakeSwap 2500).
        .filter((p) => (p.protocol === 'v4' ? true : venueCtx(cc, p.venue).feeTiers.includes(p.fee)))
        .map(async (p) => {
          if (p.protocol !== 'v4' || !p.poolKey) {
            return kV3.has(v3Key(p)) ? null : p; // this v3 pool is already in the Krystal list, so skip it
          }
          const fixed = await resolvePoolKeyV4(cc, p.poolKey, p.baseIsCurrency0!).catch(() => null);
          if (!fixed) return null;
          const merged = { ...p, poolKey: fixed.poolKey, baseIsCurrency0: fixed.baseIsCurrency0 };
          const id = poolIdOf(merged);
          return id && kIds.has(id) ? null : merged; // a Krystal version already exists, so skip it
        }),
    )
  ).filter((p): p is explore.TokenPool => p !== null);

  // On-chain last: it only contributes pools the two indexers never named. Its
  // poolKey is already re-hashed against the poolId it came from, so it needs no
  // further resolution — the same guarantee Krystal's path carries.
  const adaIds = new Set([...kIds, ...(gwFixed.map(poolIdOf).filter(Boolean) as string[])]);
  const oFixed = oPools.filter((p) => {
    const id = poolIdOf(p);
    return id !== null && !adaIds.has(id);
  });

  // Krystal first (correct TVL and a verified poolKey), then the gateway, then chain.
  let pools = [...kPools, ...gwFixed, ...oFixed];
  // Drop DYING v4 ETH pools: the gateway's TVL is often zero or wrong for v4, and a pool
  // with ~$0 liquidity has a price stuck far from the market, so a deposit vanishes
  // straight into a fake price (exactly the PEPE case in a $25 pool). Filter on on-chain
  // active liquidity plus the price gap against the market (DexScreener).
  {
    const tokMkt = await getTokenEthPrice(token, cc).catch(() => null);
    pools = (
      await Promise.all(
        pools.map(async (p) => {
          if (p.protocol !== 'v4' || !p.poolKey) return p;
          const h = await poolHealthV4(cc, p.poolKey).catch(() => null);
          // Zero ACTIVE liquidity means a dead pool (the gateway's TVL often lies: BULL
          // at fee 30000 read "TVL $173" with activeLiq 0). Minting there gives
          // 'liquidity 0' or traps the funds. Drop it whatever the base (ETH and USDG alike).
          if (!h || h.liquidity === 0n) return null;
          // A pool that has never accrued fee growth DESPITE real volume pays its
          // LPs nothing: the hook takes the swap fee and routes it away. Providing
          // liquidity there carries the full impermanent-loss risk for zero income,
          // which is strictly worse than not opening at all — so it is dropped, not
          // merely flagged. The volume test matters: a brand-new pool also reads
          // zero, and that means "has not traded yet", not "will never pay".
          if (!h.paysLps && (p.vol24hUsd ?? 0) >= NO_FEE_VOL_USD) {
            console.log(`[pools] ${p.baseSymbol}/${p.otherSymbol} fee=${p.fee} dropped: LPs earn no fee here (vol $${Math.round(p.vol24hUsd ?? 0).toLocaleString()}, feeGrowth 0)`);
            return null;
          }
          // For ETH pairs there is a market reference, so also drop anything off by >25%.
          if (p.base === 'weth' && tokMkt && h.impliedTokenEthPrice) {
            const r = h.impliedTokenEthPrice / tokMkt;
            if (r > 1.25 || r < 0.8) return null;
          }
          return p;
        }),
      )
    ).filter((p): p is explore.TokenPool => p !== null);
  }
  // SINGLE-SIDE guarantee: only pools whose base this chain genuinely supports (ETH/USDG
  // on Robinhood, BNB/USDT on BSC). The base arrives from three different sources, so this
  // is the last guard ensuring every pool offered can actually be opened one-sided.
  const okBase = new Set(cc.bases.map((b) => b.kind));
  pools = pools.filter((p) => okBase.has(p.base));
  // The threshold is tested against TVL ALONE, not TVL+volume. With a combined threshold,
  // fake volume lets an empty pool through: on 20 Aug 2026 the `USDT/牛来 fee100` pool with
  // $2 TVL (and $83k volume) really did appear in the top 3. Better to offer fewer real pools.
  const sized = pools.filter((p) => p.tvlUsd >= MIN_POOL_TVL_USD);
  // The threshold may be relaxed when nothing passes (gateway TVL is often zero for a new
  // pool that is genuinely alive) — BUT a pool with no TVL *and* no volume has not one sign
  // of life. On 30 Aug 2026 three v3 `富贵` pools on BSC ($0 and no volume) were still
  // offered, because that relaxation cancelled its own filter. v4 is saved by the on-chain
  // liquidity check above; v3 has none, so only v3 can slip through at $0 — and a deposit
  // there gets stuck at a fake price.
  pools = sized.length > 0 ? sized : pools.filter((p) => p.tvlUsd > 0 || (p.vol24hUsd ?? 0) > 0);
  if (pools.length === 0) {
    await editProgress(ctx, prog, msg.msgNoPools(cc.bases.map((b) => b.symbol).join('/')));
    return;
  }
  // The TOP 3 by TVL+volume (rankPoolsForFill) is enough, across every source on this chain.
  pools = rankPoolsForFill(pools).slice(0, POOL_PICK_MAX);
  console.log(
    `[add] ${token} ${cc.key}: krystal=${kPools.length} gateway=${gwPools.length} onchain=${oFixed.length} → top${pools.length}` +
      ` | ${pools.map((p) => `${p.baseSymbol}/${p.otherSymbol} ${p.protocol} fee${p.fee} $${Math.round(p.tvlUsd)}+v${Math.round(p.vol24hUsd ?? 0)}`).join(' , ')}`,
  );

  // 3) Start the wizard, reusing the progress bubble as the pool-picker step.
  const flow: AddFlow = { token, chain: chainKey, screenBahaya, screenFailed, pools, startedAt: Date.now() };
  flows.set(ctx.from.id, flow);
  await editProgress(ctx, prog, msg.msgPoolStep(`$${pools[0]?.otherSymbol ?? '?'} (${cc.label})`, poolSummaries(pools)), {
    ...html,
    ...poolKeyboard(pools),
  });
}

// Store the token that is waiting on a chain choice.

bot.command('add_lp', async (ctx: any) => {
  resetFlows(ctx.from!.id); // a new flow discards whatever the old one left behind, so nothing hijacks the next message
  const [, token] = ctx.message.text.trim().split(/\s+/);
  // With no CA, go to the briefed step 1: pick a pair from the top pools, or search.
  if (!token) return pairPicker(ctx);
  if (!ethers.isAddress(token)) return ctx.reply(msg.msgInvalidAddress(), html);

  // 0) Detect the chain — one progress bubble, edited at the next step.
  const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
  const found = await detectChains(token);
  if (found.length === 0) {
    return editProgress(
      ctx,
      prog,
      msg.msgError(
        'chain',
        `Token not found on any chain (${Object.values(CHAINS)
          .map((c) => c.label)
          .join('/')}).`,
      ),
    );
  }
  if (found.length === 1) return continueAddlp(ctx, token, found[0].key, prog);

  // The token exists on several chains, so turn the progress message into a chain picker.
  // The token rides IN the callback (not in a global Map): `/add A` followed by `/add B`
  // used to leave card A's buttons processing token B.
  await editProgress(ctx, prog, msg.msgChainPick(), {
    ...html,
    ...Markup.inlineKeyboard([
      ...found.map((c) => [Markup.button.callback(c.label, `chn:${c.key}:${token}`)]),
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

bot.action(/^chn:(\w+):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const token = ctx.match[2];
  await ctx.answerCbQuery();
  // Continue to screening, reusing the chain-picker message as the progress bubble.
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  await continueAddlp(ctx, token, ctx.match[1], prog);
});

// --- Wizard navigation (forward and back) ---
const getFlow = (ctx: any): AddFlow | undefined => flows.get(ctx.from!.id);

bot.action(/^pick:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  const sel = flow.pools[Number(ctx.match[1])];
  if (!sel) return ctx.answerCbQuery('Invalid choice — start again with /add_lp.');
  // v4: supports a native-ETH base and USDG. Wrapped WETH (not native) is skipped — the
  // wallet holds native ETH rather than WETH, so it could not fund it.
  if (sel.protocol === 'v4') {
    const pk = sel.poolKey!;
    const baseCur = sel.baseIsCurrency0 ? pk.currency0 : pk.currency1;
    if (sel.base === 'weth' && baseCur !== ethers.ZeroAddress) {
      await ctx.answerCbQuery();
      return ctx.reply(msg.msgV4BaseUnsupported(), html);
    }
  }
  flow.selected = sel;
  flow.base = sel.base;
  flow.fee = sel.fee;
  flow.plan = undefined;
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
  await ctx.answerCbQuery();
  flow.strategy = undefined;
  // The briefed order: pair -> strategy -> amount -> range -> confirm.
  await renderStrategyStep(ctx, flow, true);
});

bot.action(/^strat:(base|token)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  if (flow.selected?.protocol === 'v4' && ctx.match[1] === 'token') {
    return ctx.answerCbQuery('Token side is not supported on v4 pools — pick a v3 pool.');
  }
  flow.strategy = ctx.match[1] as 'base' | 'token';
  if (flow.strategy === 'token' && flow.tokenDec === undefined) {
    const cc = getChain(flow.chain);
    flow.tokenDec = Number(
      await new ethers.Contract(flow.token, ERC20_ABI, cc.provider).decimals().catch(() => 18),
    );
  }
  await ctx.answerCbQuery();
  // Range first, amount last: the amount is what fires the deposit now, so it has to be
  // the final question rather than one asked three screens before anything happens.
  await renderRangeStep(ctx, flow, true);
});

bot.action('back:strategy', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.strategy = undefined;
  flow.ethAmount = undefined;
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderStrategyStep(ctx, flow, true);
});

bot.action(/^rng:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.rangePct = Number(ctx.match[1]);
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  // A Bid-Ask ladder on the BASE side (buy-the-dip) — v3 (multicall) and v4 (batched
  // modifyLiquidities). The token side previews a single SPOT position (the old behaviour).
  // The shape is a SETTING now (/settings -> LP shape), not a question asked on every
  // deposit. Only the base side can ladder; the token side has always been a single spot.
  if (flow.strategy === 'base' && pctPresets.shape() === 'bidask') {
    flow.shape = 'bidask';
    await ctx.answerCbQuery();
    return renderLegStep(ctx, flow, true);
  }
  flow.shape = 'spot';
  flow.legs = 1;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});


/** Choose the leg count for a Bid-Ask ladder (auto-capped to the pool's spacing when planned). */
async function renderLegStep(ctx: any, flow: AddFlow, edit: boolean) {
  const text = msg.msgLegStep(flow.selected?.otherSymbol ?? 'token', flow.rangePct ?? 0);
  // The leg choices come from settings (/settings -> Ladder legs), not a hardcoded list.
  const opts = pctPresets.get('legs').map((n) =>
    Markup.button.callback(n >= 15 ? `${n} legs · 💸 paid RPC` : `${n} legs`, `leg:${n}`),
  );
  // The options needing a paid RPC get their own row, so they are not tapped by accident.
  const cheap = opts.filter((_, i) => pctPresets.get('legs')[i] < 15);
  const pricey = opts.filter((_, i) => pctPresets.get('legs')[i] >= 15);
  const rows = [
    ...pctPresets.chunkButtons(cheap),
    ...pctPresets.chunkButtons(pricey),
    // Back goes to the range step: the shape question moved to /settings, so there is no
    // shape screen behind this one any more.
    [Markup.button.callback('⬅️ Back', 'back:range'), Markup.button.callback('❌ Cancel', 'cancel')],
  ];
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

bot.action(/^shape:(spot|bidask)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.shape = ctx.match[1] as 'spot' | 'bidask';
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  if (flow.shape === 'bidask') {
    await ctx.answerCbQuery();
    return renderLegStep(ctx, flow, true);
  }
  flow.legs = 1;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

bot.action(/^leg:(\d+)$/, async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.shape = 'bidask';
  flow.legs = Math.max(2, Math.min(69, Number(ctx.match[1])));
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

// Re-read the pools for the token this flow is on, into the same bubble.

bot.action('pool:refresh', async (ctx: any) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — paste the CA again.');
  await ctx.answerCbQuery('Re-reading pools…');
  return continueAddlp(ctx, flow.token, flow.chain ?? getChain().key, {
    message_id: ctx.callbackQuery.message.message_id,
  });
});

bot.action('back:pool', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.selected = undefined;
  flow.base = undefined;
  flow.fee = undefined;
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderPoolStep(ctx, flow, true);
});

bot.action('back:range', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.fee === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.rangePct = undefined;
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderRangeStep(ctx, flow, true);
});

// Buttons on cards sent before the shape step was removed still land somewhere sensible.
bot.action('back:shape', async (ctx: any) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow) return ctx.answerCbQuery('Expired — start again by pasting the CA.');
  await ctx.answerCbQuery();
  return renderRangeStep(ctx, flow, true);
});

bot.action('back:legs', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.plan = undefined;
  flow.ladderPlans = undefined;
  await ctx.answerCbQuery();
  await renderLegStep(ctx, flow, true);
});

bot.action('back:amount', async (ctx) => {
  const flow = getFlow(ctx);
  if (!flow || flow.strategy === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
  flow.ethAmount = undefined;
  // The range is picked BEFORE the amount now, so stepping back here must leave it alone;
  // clearing it would drop the user into a flow with no range and no way to see that.
  flow.plan = undefined;
  await ctx.answerCbQuery();
  await renderAmountStep(ctx, flow, true);
});

/**
 * Open the position the flow describes. Registered as the Confirm button, and called
 * straight after the deposit amount is set -- one implementation, so the confirmed path
 * and the direct one cannot drift apart.
 */
async function execAdd(ctx: any) {
  const flow = getFlow(ctx);
  // --- v4 LADDER path (batched modifyLiquidities: N legs in 1 atomic tx) ---
  if (flow?.selected?.protocol === 'v4' && flow.shape === 'bidask' && (flow.legs ?? 1) > 1) {
    if (!flow.ethAmount || flow.rangePct === undefined || !flow.v4LadderLegs?.length)
      return ctx.answerCbQuery('Expired — start again with /add_lp.');
    const { selected, ethAmount, chain } = flow;
    flows.delete(ctx.from!.id);
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    const groupId = `V${Date.now()}`;
    try {
      const cc = getChain(chain);
      const pk = selected.poolKey!;
      const base = baseOf(cc, selected.base);
      // Re-plan fresh before sending, so the ticks are not stale.
      const legs = await planLadderV4(cc, pk, selected.baseIsCurrency0!, ethers.parseUnits(ethAmount, base.decimals), flow.rangePct, flow.legs!, 'bidask');
      await ensureGasForLegs(cc, legs.length, base.wrappable ? legs.reduce((s, l) => s + l.baseAmountWei, 0n) : 0n);
      await ctx.editMessageText(msg.msgProgress(`opening ${legs.length}-leg v4 ladder (1 atomic tx)…`), html);
      // isStableBase, NOT `=== 'usdg'`: on BSC the stable base is USDT, so the old test
      // stamped a stablecoin position with the NATIVE price. The card then valued 300
      // USDT of capital at 300 x $775 and reported -99.9% on an untouched position.
      const entryEthUsd = isStableBase(selected.base) ? 1 : ((await getEthUsd(cc.wethAddress, cc).catch(() => null)) ?? undefined);
      const tokenAddr = selected.baseIsCurrency0! ? pk.currency1 : pk.currency0;
      const [entryTick, entryMcap] = await Promise.all([
        currentTickV4(cc, pk).catch(() => undefined),
        explore.tokenMarketCap(cc, tokenAddr).catch(() => null),
      ]);
      // Bracket the id range BEFORE sending. If this flow fails after the tx lands (a wait
      // timeout, unreadable logs, a revert on a later attempt), the NFTs exist but are not
      // recorded — which is exactly how a position "disappears" from /positions. This range
      // is what makes them recoverable.
      const idBefore = await v4NextTokenId(cc).catch(() => null);
      let ids: string[];
      try {
        ids = (await openLadderV4(cc, pk, selected.baseIsCurrency0!, legs, { dryRun: false })).tokenIds;
      } catch (e) {
        // A failure is not the same as nothing happening. Recover whatever was minted first, then rethrow.
        const stray = await adoptStrayV4(cc, idBefore, legs.length);
        if (stray.length === 0) throw e;
        ids = stray;
        await ctx.reply(
          msg.msgError('add v4 ladder', `${(e as Error).message.slice(0, 160)}\n\n${stray.length} leg(s) had already been minted, and are now tracked by the bot.`),
          html,
        );
      }
      // Succeeded but short: recover the remainder through the same path.
      if (ids.length < legs.length) {
        const stray = await adoptStrayV4(cc, idBefore, legs.length);
        if (stray.length > ids.length) ids = stray;
      }
      const r = { tokenIds: ids };
      for (let i = 0; i < r.tokenIds.length; i++) {
        v4store.trackV4({
          tokenId: r.tokenIds[i],
          chain: cc.key,
          currency0: pk.currency0,
          currency1: pk.currency1,
          fee: pk.fee,
          tickSpacing: pk.tickSpacing,
          hooks: pk.hooks,
          base: isStableBase(selected.base) ? 'USDG' : 'ETH', // 'USDG' means "this chain's stable base"
          baseIsCurrency0: selected.baseIsCurrency0!,
          entryBaseWei: legs[i].baseAmountWei.toString(),
          entryEthUsd,
          entryTick,
          entryMcap: entryMcap ?? undefined,
          groupId,
          legIndex: i,
          legCount: r.tokenIds.length,
          shape: 'bidask',
        });
      }
      invalidateV4ListCache(); // a new position means /positions has to be fresh
      await ctx.editMessageText(msg.msgLadderOpened(r.tokenIds.length, legs.length, `$${msg.posPair(`${selected.baseSymbol} / ${selected.otherSymbol}`, selected.baseSymbol)}`, ethAmount), html);
      // The first leg's card already summarises the WHOLE ladder (see ladderSum in
      // buildV4Card), so one card is enough — same as the v3 ladder path.
      await replyV4Card(ctx, cc, r.tokenIds[0]);
    } catch (err) {
      console.error('[open v4 ladder] failed:', (err as Error).message.slice(0, 200));
      await recoverStrayWeth(getChain(chain), 'add v4 ladder').catch(() => {});
      await ctx.reply(msg.msgError('add v4 ladder', (err as Error).message), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  // --- v4 path (open a single-sided ETH position in a v4 pool) ---
  if (flow?.selected?.protocol === 'v4') {
    if (!flow.ethAmount || flow.rangePct === undefined) return ctx.answerCbQuery('Expired — start again with /add_lp.');
    const { selected, ethAmount, chain, rangePct } = flow;
    flows.delete(ctx.from!.id); // idempotency: a double-tap must not open twice
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    try {
      await ctx.editMessageText(msg.msgOpeningLp(), html);
      const cc = getChain(chain);
      const pk = selected.poolKey!;
      const base = baseOf(cc, selected.base); // 'weth'→ETH-native / 'usdg'→USDG
      const amountWei = ethers.parseUnits(ethAmount, base.decimals);
      const widthSpacings = rangePctToSpacings(rangePct, pk.tickSpacing);
      // The probe is the v4 position NFT count (see retryOnce): a landed mint means no retry.
      const r = await retryOnce(
        'add v4',
        () => v4PositionCount(cc),
        () => openPositionV4(cc, pk, selected.baseIsCurrency0!, amountWei, { widthSpacings, dryRun: false }),
        { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
      );
      if (r.tokenId) {
        const tokenAddr = r.baseIsCurrency0 ? pk.currency1 : pk.currency0;
        const [entryTick, entryMcap] = await Promise.all([
          currentTickV4(cc, pk).catch(() => undefined),
          explore.tokenMarketCap(cc, tokenAddr).catch(() => null),
        ]);
        v4store.trackV4({
          tokenId: r.tokenId,
          chain: cc.key,
          currency0: pk.currency0,
          currency1: pk.currency1,
          fee: pk.fee,
          tickSpacing: pk.tickSpacing,
          hooks: pk.hooks,
          base: isStableBase(selected.base) ? 'USDG' : 'ETH', // 'USDG' means "this chain's stable base"
          baseIsCurrency0: r.baseIsCurrency0,
          entryBaseWei: amountWei.toString(),
          entryEthUsd: isStableBase(selected.base)
            ? 1
            : (await getEthUsd(cc.wethAddress, cc).catch(() => null)) ?? undefined,
          entryTick,
          entryMcap: entryMcap ?? undefined,
        });
      }
      invalidateV4ListCache();
      await ctx.editMessageText(
        msg.msgV4Added({
          tokenId: r.tokenId,
          sizeEth: `${ethAmount} ${base.symbol}`,
          rangeLabel: `single-sided ${base.symbol} · range ~${rangePct}%`,
          txHash: r.txHash,
          pair: `$${msg.posPair(`${base.symbol} / ${selected.otherSymbol}`, base.symbol)}`,
          dryRun: false,
        }),
        html,
      );
      await replyV4Card(ctx, cc, r.tokenId);
    } catch (err) {
      await recoverStrayWeth(getChain(chain), 'add v4').catch(() => {});
      await ctx.reply(msg.msgError('add v4', err), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  // --- Bid-Ask LADDER path (v3, base side): mint N legs sharing a groupId ---
  if (flow?.shape === 'bidask' && (flow.legs ?? 1) > 1 && flow.strategy === 'base') {
    if (flow.fee === undefined || !flow.ethAmount || flow.rangePct === undefined)
      return ctx.answerCbQuery('Expired — start again with /add_lp.');
    flows.delete(ctx.from!.id);
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunAddDone(), html));
    store.beginMoneyOp();
    const groupId = `L${Date.now()}`;
    const opened: string[] = [];
    try {
      const ccAdd = wizardCtx(flow);
      const base = baseOf(ccAdd, flow.base ?? 'weth');
      // Plan fresh right before minting (ticks must not be stale). Entry metadata is computed once.
      const legPlans = await planLadderSingleSided(flow.token, flow.fee, flow.ethAmount, flow.rangePct, flow.legs!, 'bidask', base, ccAdd);
      const entryMcap = (await explore.tokenMarketCap(ccAdd, flow.token).catch(() => null)) ?? undefined;
      const entryEthUsd = isStableBase(base.kind) ? 1 : ((await getEthUsd(ccAdd.wethAddress, ccAdd).catch(() => null)) ?? undefined);
      const usable = legPlans.filter((lp) => lp.baseAmountWei > 0n); // drop dust legs left by rounding
      // A wrappable WETH base is funded from native, so native must cover deposit plus gas;
      // a stable base needs native for gas only. ensureBaseReady inside executeAddBatch
      // handles the wrap, but check first so a failure is friendly ("top up ETH") rather
      // than a raw revert.
      await ensureGasForLegs(ccAdd, usable.length, base.wrappable ? usable.reduce((s, lp) => s + lp.baseAmountWei, 0n) : 0n);
      await ctx.editMessageText(msg.msgProgress(`opening ${usable.length}-leg ladder (batched)…`), html);
      // BATCH multicall: every leg in ~1 atomic tx per chunk (closing the N-tx weakness).
      const { tokenIds } = await executeAddBatch(usable, flow.token, flow.fee, ccAdd);
      for (let i = 0; i < tokenIds.length; i++) {
        const lp = usable[i];
        store.add({
          tokenId: tokenIds[i],
          chain: flow.chain,
          venue: flow.selected?.venue,
          ca: flow.token,
          fee: flow.fee,
          symbol: lp.otherSymbol,
          baseKind: lp.baseKind,
          initialWethWei: lp.baseAmountWei.toString(),
          side: 'base',
          rangeLowPct: lp.pctLow,
          rangeHighPct: lp.pctHigh,
          entryPrice: lp.currentPrice,
          entryMcap,
          entryEthUsd,
          groupId,
          legIndex: i,
          legCount: tokenIds.length,
          shape: 'bidask',
          openedAt: Date.now(),
          status: 'ACTIVE',
          lastInRange: false,
        });
        opened.push(tokenIds[i]);
      }
      await ctx.editMessageText(msg.msgLadderOpened(opened.length, usable.length, `$${msg.posPair(`${legPlans[0].baseSymbol} / ${legPlans[0].otherSymbol}`, legPlans[0].baseSymbol)}`, flow.ethAmount), html);
      const first = opened[0] ? store.get(opened[0]) : undefined;
      if (first) await renderPositionCard(ctx, first, false).catch(() => {});
    } catch (err) {
      console.error('[open ladder] failed:', (err as Error).message.slice(0, 200));
      await recoverStrayWeth(getChain(flow.chain), 'add ladder').catch(() => {});
      const note = opened.length ? ` (${opened.length} leg(s) already opened and saved)` : '';
      await ctx.reply(msg.msgError('add ladder', (err as Error).message + note), html);
    } finally {
      store.endMoneyOp();
    }
    return;
  }
  if (!flow?.plan || flow.fee === undefined || !flow.ethAmount || flow.rangePct === undefined)
    return ctx.answerCbQuery('Expired — start again with /add_lp.');
  // Idempotency: the flow is deleted BEFORE execution (synchronously, before the first
  // await), so double-tapping Confirm cannot open two positions (and spend twice the ETH).
  // If the open fails the flow is already gone and the user simply runs /add again — safe.
  flows.delete(ctx.from!.id);
  await ctx.answerCbQuery('Processing…');
  if (config.safety.dryRun) {
    await ctx.editMessageText(msg.msgDryRunAddDone(), html);
    return;
  }
  store.beginMoneyOp();
  try {
    await ctx.editMessageText(msg.msgOpeningLp(), html);
    // The plan on the PREVIEW card was computed when the card was rendered. If the button
    // is tapped much later, the ticks and price are stale, so the mint either reverts
    // (burning gas) or lands in an irrelevant range. Recompute right before sending the tx.
    // (The v4 path already did this; this brings v3 into line.)
    // A pool can come from a non-default DEX on the chain (Uniswap v3 on BSC, say), so the
    // contracts used MUST belong to its venue rather than the chain's cc.factory.
    const ccAdd = wizardCtx(flow);
    // The deposit side MUST match what was chosen at the strategy step. Always calling
    // planAddSingleSided here turned a "token side" choice into a base deposit on confirm —
    // the token amount was read as an ETH amount.
    const args = [flow.token, flow.fee, flow.ethAmount, flow.rangePct, baseOf(ccAdd, flow.base ?? 'weth'), ccAdd] as const;
    // The probe is the position NFT count. A mint that already landed raises it, so do NOT
    // retry (a duplicate position means duplicate capital). An ETH->WETH wrap does not raise
    // it, so a failure after the wrap can still be retried — and the second attempt uses the
    // WETH that already exists, with no manual unwrap first.
    const { tokenId, notes, plan } = await retryOnce(
      'add',
      () => ccAdd.positionManager.balanceOf(ccAdd.wallet.address) as Promise<bigint>,
      async () => {
        // Re-plan on every attempt: ticks and price are recomputed, never reused stale.
        const p2 = await (flow.strategy === 'token'
          ? planAddTokenSide(...args)
          : planAddSingleSided(...args));
        return { ...(await executeAdd(p2, flow.token!, flow.fee!, ccAdd)), plan: p2 };
      },
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    store.add({
      tokenId,
      chain: flow.chain,
      venue: flow.selected?.venue,
      ca: flow.token,
      fee: flow.fee,
      symbol: plan.otherSymbol,
      baseKind: plan.baseKind,
      // The token side deposits no base at all (baseAmountWei = 0). Its cost basis is
      // recorded as the BASE EQUIVALENT at the price when it opened — without that, PnL has
      // no zero point and the position reads "—" forever.
      initialWethWei: (plan.side === 'token'
        ? ethers.parseUnits(
            (Number(flow.ethAmount) * Number(plan.currentPrice)).toFixed(plan.baseDecimals),
            plan.baseDecimals,
          )
        : plan.baseAmountWei
      ).toString(),
      nominalEth: plan.side === 'token' ? undefined : flow.ethAmount,
      nominalToken: plan.side === 'token' ? flow.ethAmount : undefined,
      side: plan.side,
      rangeLowPct: plan.pctLow,
      rangeHighPct: plan.pctHigh,
      entryPrice: plan.currentPrice, // the token price at open, which the drop alert measures against
      // The market cap at open. The card's mcap bounds are pinned to this so they stay still
      // (rather than wobbling because DexScreener's mcNow and the on-chain price come from
      // different sources).
      entryMcap: (await explore.tokenMarketCap(ccAdd, flow.token!).catch(() => null)) ?? undefined,
      // The base price (USD) at open, which LP Agent-style USD PnL is pinned to. A stable is 1.
      entryEthUsd: isStableBase(plan.baseKind)
        ? 1
        : (await getEthUsd(ccAdd.wethAddress, ccAdd).catch(() => null)) ?? undefined,
      openedAt: Date.now(),
      status: 'ACTIVE',
      lastInRange: false,
    });
    console.log(`[open] #${tokenId}:`, notes.join(' | ')); // the counterpart to [cashout]; without it an open leaves no trace
    // A short OPENED summary in the same bubble, then the live position card.
    // priceLower/Upper follow TICK order; in price terms that can be reversed, and a range
    // printed backwards makes this card look like it miscalculated.
    const [pLo, pHi] =
      Number(plan.priceLower) <= Number(plan.priceUpper)
        ? [plan.priceLower, plan.priceUpper]
        : [plan.priceUpper, plan.priceLower];
    await ctx.editMessageText(
      msg.msgLpOpened(tokenId, notes, `$${msg.posPair(`${plan.baseSymbol} / ${plan.otherSymbol}`, plan.baseSymbol)}`, `${pLo} — ${pHi}`),
      html,
    );
    const rec = store.get(tokenId);
    if (rec) {
      try {
        await renderPositionCard(ctx, rec, false);
      } catch (e) {
        await ctx.reply(msg.msgPositionReadFail(tokenId, (e as Error).message), html);
      }
    }
  } catch (err) {
    // An add that failed after wrapping leaves WETH behind; it is tidied up here so no
    // manual /unwrap is needed before trying /add_lp again.
    console.error('[open] failed:', (err as Error).message.slice(0, 200));
    await recoverStrayWeth(getChain(flow.chain), 'add').catch(() => {});
    await ctx.reply(msg.msgError('add', err), html);
  } finally {
    store.endMoneyOp();
  }
}

bot.action('addok', async (ctx: any) => {
  await ctx.answerCbQuery();
  return execAdd(ctx);
});

/** The close-position confirmation card. Execution: remove + collect + cash out to ETH via Relay. */
async function renderStopConfirm(ctx: any, tokenId: string, edit: boolean) {
  const rec = store.get(tokenId);
  const cc = rec ? ctxOf(rec) : getChain();
  const d = await getPositionDetail(tokenId, cc);
  const pnlText = await positionPnlText(rec, d, cc);
  const feeF = Number(ethers.formatUnits(d.feesBaseWei, d.baseDecimals));
  const feeUsd = await baseToUsd(d.baseKind, feeF, cc);
  const feeText =
    feeUsd !== null ? msg.usdPlain(feeUsd) : `${msg.cleanUnits(d.feesBaseWei, d.baseDecimals)} ${d.baseSymbol}`;
  const age = rec ? msg.fmtAge(Date.now() - rec.openedAt) : '—';
  const text = msg.msgStopConfirm({
    tokenId,
    symbol: d.otherSymbol,
    fee: d.fee,
    age,
    pnlText,
    feeText,
    baseAmt: msg.cleanUnits(d.baseAmountWei, d.baseDecimals),
    baseSymbol: d.baseSymbol,
    otherAmt: msg.cleanUnits(d.otherAmountWei, d.otherDecimals),
  });
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      // The money button names the position it burns, on its own row.
      [Markup.button.callback(`⛔ Close #${tokenId} for good`, `close:${tokenId}`)],
      [Markup.button.callback('⬅️ Back', `back:card:${tokenId}`)],
      [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
    ]),
  };
  await (edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra));
}

/** Send the active position cards, built in parallel and sent in order, with an optional header. */
async function replyActiveCards(ctx: any, header: string | null) {
  const active = store.active();
  if (active.length === 0) return ctx.reply(msg.msgNoActiveToStop(), html);
  if (header) await ctx.reply(header, html);
  // Streamed sending: card #1 goes out as soon as it is ready while the rest are still
  // built in the background. Waiting for the WHOLE build first left the screen still for
  // ~3s on 12 positions.
  const cards = mapLimitStream(active, POS_CARD_CONCURRENCY, async (rec) => {
    try {
      return await buildPositionCard(rec);
    } catch (e) {
      return {
        text: msg.msgPositionReadFail(rec.tokenId, (e as Error).message),
        extra: html as Record<string, unknown>,
      };
    }
  });
  for (const p of cards) {
    const c = await p;
    await ctx.reply(c.text, c.extra);
  }
}

// /stop closes positions: one card per position, v3 and v4, each with its own confirmation.
// This used to be separate from /closeall; both did the same thing, the only difference
// being that /closeall also showed v4 positions — so the complete version is what remains.
async function cmdCloseAll(ctx: any) {
  // The /positions card shows v4 positions, so a "Close All" button listing only v3 would
  // leave the user believing everything was closed while v4 stayed open.
  const cc = getChain();
  const v4 = v4Supported(cc) ? await listPositionsV4(cc).catch(() => []) : [];
  const v3 = store.active();
  if (v3.length + v4.length === 0) return ctx.reply(msg.msgNoActiveToStop(), html);
  if (v3.length) await replyActiveCards(ctx, msg.msgCloseAllPick(v3.length, v4.length));
  else await ctx.reply(msg.msgCloseAllPick(0, v4.length), html);
  const ethUsd = v4.length ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : null;
  // v4 cards used to be built INSIDE the send loop, alternating build and send, making it
  // the slowest of all the card paths. Now they build in parallel, order preserved.
  for (const p of mapLimitStream(v4, POS_CARD_CONCURRENCY, (x) => buildV4Card(x, ethUsd, cc))) {
    const c = await p;
    await ctx.reply(c.text, c.extra);
  }
}
bot.command('stop', cmdCloseAll);

type TSwapFlow = {
  chainKey: string;
  buy: boolean;
  base?: BaseAsset;
  token?: string;
  tokenSym?: string;
  tokenDec?: number;
  awaitingToken?: boolean;
  awaitingAmount?: boolean;
  awaitingCA?: boolean;          // /buy: menunggu user tempel CA
  chainOptions?: string[];       // /buy: the candidate chains, when a token exists on more than one supported chain
  screenText?: string;           // /buy: the Detail+Safety card, cached so Back does not rescan
  screenBahaya?: boolean;        // /buy: verdict screening = BAHAYA
  previewBack?: string;          // the Back button's action on the Preview and Confirm cards
  sellList?: SellHolding[];      // /sell: the tokens held, indexed by button
  sellMultiChain?: boolean;      // /sell: the holdings span more than one chain, so each row names its chain
  fromHub?: boolean;             // entered from the CA hub card, so Back returns to the hub
  tokenBalWei?: bigint;          // /sell: the chosen token's raw balance, for the percentage maths
  tokenBalNum?: number;          // /sell: the chosen token's balance as a number, for the label
  holdingLine?: string;          // /sell: the holding line exactly as its button shows it
  amountWei?: bigint;
  amountInLabel?: string;
  outLabel?: string;
  route?: string;
  quotedAt?: number;      // when the Preview card's numbers were computed, for the confirmation TTL
  quotedOutWei?: bigint;  // the amount the user SAW, which becomes the minOut floor at execution
  startedAt: number;
};
const tswapFlows = new Map<number, TSwapFlow>();
const tswapInFlight = new Set<number>();

/** Chains that support token swaps (they have a router and quoter) — currently Robinhood only. */
const swapTokenChains = (): ChainCtx[] =>
  Object.values(CHAINS);

// /buy is the CA-first flow; /sell is the holdings-first flow (below).
// The quote backend (tswapQuoteConfirm) and executor (tswapok) are shared by both.

// ── /buy = the CA-first flow ────────────────────────────────────────────────
// /buy <CA>: detect the chain, Detail+Safety, pick the asset, pick the size,
//   preview the order, confirm, result. The quote and execution backend is shared with /sell.
function buyAskCA(ctx: any, edit: boolean) {
  // A shortcut for the stablecoin base on EVERY active chain: we already know its address,
  // so making the user paste it adds a step and a chance to paste the wrong thing.
  const quick: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const c of Object.values(CHAINS)) {
    for (const b of basesFor(c)) {
      if (!isStableBase(b.kind)) continue;
      quick.push([Markup.button.callback(`💵 Buy ${b.symbol} · ${c.label}`, `bca:${b.address}`)]);
    }
  }
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([...quick, [Markup.button.callback('❌ Cancel', 'cancel')]]),
  };
  const text = msg.msgBuyAskCA(
    config.safety.dryRun,
    Object.values(CHAINS).flatMap((c) =>
      basesFor(c)
        .filter((b) => isStableBase(b.kind))
        .map((b) => ({ symbol: b.symbol, chain: c.label, ca: b.address })),
    ),
  );
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Shortcut: the CA rides IN the callback (not in state), so older buttons stay correct.
bot.action(/^bca:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  return buyStartFromCA(ctx, ctx.match[1], prog);
});

// The candidate chains are where the token EXISTS, intersected with the chains swap supports.
async function buyDetectChains(ca: string): Promise<ChainCtx[]> {
  const swapKeys = new Set(swapTokenChains().map((c) => c.key));
  return (await detectChains(ca)).filter((c) => swapKeys.has(c.key));
}

// Step 1: pick a chain (only when the token exists on more than one supported chain).
function buyChainStep(ctx: any, flow: TSwapFlow, keys: string[], edit: boolean) {
  flow.chainOptions = keys;
  const rows = keys.map((k) => [Markup.button.callback(CHAINS[k]!.label, `buychain:${k}`)]);
  rows.push([Markup.button.callback('⬅️ Back', 'buyback:ca'), Markup.button.callback('❌ Cancel', 'cancel')]);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgChainPick();
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Step 2: Detail plus Safety. Screening is cached in the flow, so Back does not re-scan.
async function buySafetyStep(ctx: any, flow: TSwapFlow, prog: { message_id: number } | null, edit: boolean) {
  const cc = CHAINS[flow.chainKey]!;
  if (flow.tokenDec === undefined) {
    // symbol and decimals are MANDATORY (used by the estimate and by execution). Guessing
    // 18 can be wrong by 10^9 for a 9-decimal token — and that number underpins the buy
    // decision. A failure aborts.
    try {
      const t = new ethers.Contract(flow.token!, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], cc.provider);
      const [sym, dec] = await Promise.all([t.symbol().catch(() => flow.tokenSym ?? '?'), t.decimals()]);
      flow.tokenSym = String(sym);
      flow.tokenDec = Number(dec);
    } catch {
      tswapFlows.delete(ctx.from.id);
      return editProgress(ctx, prog, msg.msgError('buy', 'Could not read token decimals — aborted (amounts could be off by 10^12).'));
    }
  }
  if (flow.screenText === undefined) {
    prog = await editProgress(ctx, prog, msg.msgProgress(`auditing token on ${cc.label}…`));
    try {
      const s = await screenToken(flow.token!, cc);
      flow.token = ethers.getAddress(flow.token!);
      flow.tokenSym = s.symbol && s.symbol !== '???' ? s.symbol : flow.tokenSym;
      flow.screenBahaya = s.verdict === 'BAHAYA';
      flow.screenText = formatScreen(s, { ca: flow.token!, chainLabel: cc.label });
    } catch {
      flow.screenBahaya = false;
      flow.screenText = msg.msgScreeningFailed();
    }
  }
  const back = (flow.chainOptions?.length ?? 0) > 1 ? 'buyback:chain' : 'buyback:ca';
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🟢 Continue', 'buy:go')],
      [Markup.button.callback('⬅️ Back', back), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  };
  const text = `${flow.screenText}\n\n${msg.msgBuySafetyHint(flow.tokenSym ?? '?')}`;
  if (prog) return editProgress(ctx, prog, text, extra);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Step 3: pick the paying asset (ETH/USDG). On a stable chain it auto-selects USDT and
// goes straight to size.
function buyBaseStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  const cc = CHAINS[flow.chainKey]!;
  // Buying USDT with USDT is not a choice, so drop it from the paying-asset list.
  const bases = basesFor(cc).filter((b) => b.address.toLowerCase() !== (flow.token ?? '').toLowerCase());
  if (bases.length <= 1) {
    flow.base = bases[0];
    return buySizeStep(ctx, flow, edit);
  }
  const row = bases.map((b) => Markup.button.callback(b.symbol, `buybase:${b.kind}`));
  const back = flow.fromHub ? 'hub:back' : 'buyback:safety';
  const extra = {
    ...html,
    ...Markup.inlineKeyboard([row, [Markup.button.callback('⬅️ Back', back), Markup.button.callback('❌ Cancel', 'cancel')]]),
  };
  const text = msg.msgTSwapBase(cc.label, true);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Step 4: pick a size (the chosen asset's /size presets, or type an amount). Back from
// the preview returns here.
/**
 * The base balance that can ACTUALLY be spent in /buy.
 *
 * A wrappable base is funded from native, and native also pays the gas — so 100% of the
 * raw balance would leave nothing for the transaction itself.
 * The gas reserve is deducted first, exactly as it is for the percentage buttons in the
 * /add wizard.
 */
async function buyUsableWei(flow: TSwapFlow): Promise<bigint> {
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  if (!base.wrappable) {
    return (await new ethers.Contract(base.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address)) as bigint;
  }
  const [bal, buf] = await Promise.all([cc.provider.getBalance(cc.wallet.address), gasBuffer(cc)]);
  return bal > buf ? bal - buf : 0n;
}

async function buySizeStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  flow.awaitingAmount = true;
  flow.previewBack = 'buyback:size'; // Back from the preview returns to the size step
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  let balLine = '';
  try {
    if (base.wrappable) {
      // What funds it is THAT chain's NATIVE asset (the bot wraps it itself). The symbol
      // MUST follow the chain: writing 'ETH' while on BSC names an asset that is never
      // held, and makes the figure read as the wrong chain's balance.
      const b = await cc.provider.getBalance(cc.wallet.address);
      balLine = msg.note(`balance: ${Number(ethers.formatEther(b)).toFixed(5)} ${cc.nativeSymbol}`);
    } else {
      const bc = new ethers.Contract(base.address, ERC20_ABI, cc.provider);
      const b: bigint = await bc.balanceOf(cc.wallet.address);
      balLine = msg.note(`balance: ${Number(ethers.formatUnits(b, base.decimals)).toFixed(2)} ${base.symbol}`);
    }
  } catch {
    /* the balance is optional */
  }
  // The amount can be typed in chat (flow.awaitingAmount) OR picked as a percentage.
  // Percentages of the balance, in line with /sell and the /add wizard, which already have
  // percentage buttons. "Custom %" covers anything outside the presets.
  const rows: any[] = [];
  rows.push(...pctPresets.chunkButtons(pctPresets.get('buy').map((p) => Markup.button.callback(`${p}%`, `buypct:${p}`))));
  const multiBase = basesFor(cc).length > 1;
  const backSize = multiBase ? 'buyback:base' : flow.fromHub ? 'hub:back' : 'buyback:safety';
  rows.push([Markup.button.callback('⬅️ Back', backSize), Markup.button.callback('❌ Cancel', 'cancel')]);
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgTSwapAmountPrompt(true, base.wrappable ? cc.nativeSymbol : base.symbol, balLine);
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

// Start the buy flow from a CA: detect the chain, pick one if there are several, then safety.
/** Live LP positions (v3 + v4) for a CA on a given chain. */
async function lpForToken(ca: string, cc: ChainCtx): Promise<{ v3: store.PosRecord[]; v4: string[] }> {
  const low = ca.toLowerCase();
  const v3 = store.active().filter((r) => (r.chain ?? 'robinhood') === cc.key && r.ca?.toLowerCase() === low);
  // v4store keeps currency0/currency1, NOT the ca, so match against both.
  const v4 = v4store
    .allV4()
    .filter(
      (r) =>
        r.chain === cc.key && (r.currency0.toLowerCase() === low || r.currency1.toLowerCase() === low),
    )
    .map((r) => r.tokenId);
  return { v3, v4 };
}

/**
 * Render the TOKEN HUB. One screening plus one balance read serves all four actions.
 * The exit buttons (Close LP / Sell) are only rendered when there is something to
 * exit — a dead button is a wasted tap and a false affordance.
 */
async function renderTokenHub(
  ctx: any,
  ca: string,
  chainKey: string,
  prog: { message_id: number } | null,
) {
  const cc = getChain(chainKey);
  prog = await editProgress(ctx, prog, msg.msgProgress(`auditing token on ${cc.label}…`));

  // Token identity: symbol and decimals are MANDATORY (every downstream flow uses them).
  // A failure aborts; do not guess 18 (PRD §8.9).
  let sym = '?';
  let dec = 18;
  try {
    const t = new ethers.Contract(ca, ERC20_ABI, cc.provider);
    const [sm, dc] = await Promise.all([t.symbol().catch(() => '?'), t.decimals()]);
    sym = String(sm);
    dec = Number(dc);
  } catch {
    return editProgress(ctx, prog, msg.msgError('token', 'Could not read token decimals — aborted (amounts could be off by 10^12).'));
  }

  const [screened, balRes] = await Promise.allSettled([
    screenToken(ca, cc),
    new ethers.Contract(ca, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address) as Promise<bigint>,
  ]);
  const sc = screened.status === 'fulfilled' ? screened.value : null;
  if (sc?.symbol && sc.symbol !== '???') sym = sc.symbol;
  const bal = balRes.status === 'fulfilled' ? balRes.value : 0n;
  const balNum = Number(ethers.formatUnits(bal, dec));
  const { v3, v4 } = await lpForToken(ca, cc);

  const priceUsd = sc?.priceUsd ?? null;
  const note =
    sc && sc.liquidityUsd != null
      ? `liquidity ${msg.usdCompact(sc.liquidityUsd)}${sc.pairAgeHours != null ? ` · pool ${Math.round(sc.pairAgeHours)}h old` : ''}`
      : undefined;
  // The card SHOWN is the screening TOKEN DETAIL card (no longer msgTokenHub): one card,
  // rather than two with overlapping contents.
  const text = sc
    ? formatScreen(sc, {
        ca,
        chainLabel: cc.label,
        heldLabel: bal > 0n ? `${msg.cleanUnits(bal, dec)} ${sym}` : null,
        lpCount: v3.length + v4.length,
      })
    : msg.msgScreeningFailed();

  // EXIT buttons appear only when there is something to exit: Close LP when a position
  // exists, Sell Token when the balance is above zero. With neither, only the entry paths
  // show. Buy/Sell Token also require a chain with a swap route.
  const swappable = swapTokenChains().some((c) => c.key === cc.key);
  const hasLp = v3.length + v4.length > 0;

  const rowLp = [Markup.button.callback('💧 Add LP', `ca:add:${ca}`)];
  if (hasLp) rowLp.push(Markup.button.callback('📤 Close LP', `ca:close:${ca}`));

  const rowTok: ReturnType<typeof Markup.button.callback>[] = [];
  if (swappable) {
    rowTok.push(Markup.button.callback('💱 Buy Token', `ca:buy:${ca}`));
    if (bal > 0n) rowTok.push(Markup.button.callback('📉 Sell Token', `ca:sell:${ca}`));
  }

  const kb = Markup.inlineKeyboard([
    rowLp,
    ...(rowTok.length ? [rowTok] : []),
    // This card is static: its prices are frozen at the second you pasted the CA. For a
    // newly born token a minute is already a long time, so offer a way to refresh in place.
    [Markup.button.callback('🔄 Refresh', `ca:refresh:${ca}`), Markup.button.callback('❌ Cancel', 'cancel')],
    [Markup.button.callback('⬅️ Back to Menu', 'positions_back')],
  ]);

  hubs.set(ctx.from.id, {
    ca,
    chainKey: cc.key,
    text,
    kb,
    sym,
    dec,
    screenText: text,
    bahaya: sc?.verdict === 'BAHAYA',
    reasons: (sc?.flags ?? []).filter((f) => f.level === 'BAHAYA').map((f) => f.msg),
    failed: !sc,
  });
  return editProgress(ctx, prog, text, { ...html, ...kb });
}

/**
 * A 4-button router from the hub into flows that ALREADY EXIST. No new money path:
 * screening is handed over (never re-scanned), and every confirmation and guard still
 * belongs to the original flow.
 */
bot.action(/^ca:refresh:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const ca = ethers.getAddress(ctx.match[1]);
  const h = hubs.get(ctx.from!.id);
  if (!h || h.ca.toLowerCase() !== ca.toLowerCase()) return ctx.answerCbQuery('Expired — paste the CA again.');
  await ctx.answerCbQuery('Refreshing…');
  // The 60-second cache is dropped first; otherwise this button just redraws the same
  // numbers and feels like it did nothing.
  bustScreenCache(ca);
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  return renderTokenHub(ctx, ca, h.chainKey, prog);
});

bot.action(/^ca:(add|buy|close|sell):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const [, what, ca] = ctx.match as unknown as [string, 'add' | 'buy' | 'close' | 'sell', string];
  const h = hubs.get(ctx.from!.id);
  if (!h || h.ca.toLowerCase() !== ca.toLowerCase()) return ctx.answerCbQuery('Expired — paste the CA again.');
  const cc = getChain(h.chainKey);
  await ctx.answerCbQuery();
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;

  if (what === 'add') {
    // The full /add wizard; screening is passed from the hub so the SCREEN card is not sent twice.
    return continueAddlp(ctx, ca, h.chainKey, prog, { bahaya: h.bahaya, failed: h.failed, reasons: h.reasons });
  }

  // The guard stays even though the button is conditional: the hub is kept in memory, so a
  // button on an older card can still be tapped after the state has changed.
  if ((what === 'buy' || what === 'sell') && !swapTokenChains().some((c) => c.key === h.chainKey)) {
    return ctx.editMessageText(
      msg.msgError(what === 'buy' ? 'buy' : 'sell', `${cc.label} has no bot swap route — only Add LP / Close LP are available there.`),
      html,
    );
  }

  if (what === 'buy') {
    // The SAFETY card is skipped (the verdict is already on the hub), going straight to base and amount.
    tswapFlows.set(ctx.from!.id, {
      chainKey: h.chainKey,
      buy: true,
      token: ethers.getAddress(ca),
      tokenSym: h.sym,
      tokenDec: h.dec,
      screenText: h.screenText,
      screenBahaya: h.bahaya,
      fromHub: true,
      startedAt: Date.now(),
    });
    return buyBaseStep(ctx, tswapFlows.get(ctx.from!.id)!, true);
  }

  if (what === 'sell') {
    const bal: bigint = await new ethers.Contract(ca, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .catch(() => 0n);
    if (bal <= 0n) return ctx.editMessageText(msg.msgError('sell', 'Balance is 0 — nothing to sell.'), html);
    const flow: TSwapFlow = {
      chainKey: h.chainKey,
      buy: false,
      token: ethers.getAddress(ca),
      tokenSym: h.sym,
      tokenDec: h.dec,
      tokenBalWei: bal,
      tokenBalNum: Number(ethers.formatUnits(bal, h.dec)),
      screenText: h.screenText,
      screenBahaya: h.bahaya,
      fromHub: true,
      startedAt: Date.now(),
    };
    tswapFlows.set(ctx.from!.id, flow);
    return sellAmountStep(ctx, flow, true);
  }

  // For a close: one position confirms straight away; more than one gets a card each to choose from.
  const { v3, v4 } = await lpForToken(ca, cc);
  if (v3.length === 1 && v4.length === 0) return renderStopConfirm(ctx, v3[0].tokenId, true);
  if (v3.length === 0 && v4.length === 1) {
    return ctx.editMessageText(msg.msgV4CloseConfirm(v4[0]), {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⛔ Close v4 Position', `closev4go:${v4[0]}`)],
        [Markup.button.callback('⬅️ Back', 'hub:back'), Markup.button.callback('❌ Cancel', 'cancel')],
      ]),
    });
  }
  if (v3.length + v4.length === 0) {
    return ctx.editMessageText(msg.msgError('close', 'No active LP position for this token.'), html);
  }
  await ctx.editMessageText(msg.msgCloseAllPick(v3.length, v4.length), html);
  for (const rec of v3) {
    const c = await buildPositionCard(rec).catch(() => null);
    if (c) await ctx.reply(c.text, c.extra);
  }
  if (v4.length) {
    const [list, ethUsd] = await Promise.all([
      listPositionsV4(cc).catch(() => [] as V4Position[]),
      getEthUsd(cc.wethAddress, cc).catch(() => null),
    ]);
    const found = v4.map((id) => list.find((x) => x.tokenId === id)).filter((p): p is V4Position => !!p);
    for (const q of mapLimitStream(found, POS_CARD_CONCURRENCY, (p) => buildV4Card(p, ethUsd, cc))) {
      const c = await q;
      await ctx.reply(c.text, c.extra);
    }
  }
});

/** Hub entry from a bare CA: detect the chain first (with a picker when there is more than one). */
async function startTokenHub(ctx: any, ca: string) {
  resetFlows(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
  const found = await detectChains(ca);
  if (found.length === 0) {
    return editProgress(
      ctx,
      prog,
      msg.msgError('token', `Token not found on any chain (${Object.values(CHAINS).map((c) => c.label).join('/')}).`),
    );
  }
  if (found.length === 1) return renderTokenHub(ctx, ca, found[0].key, { message_id: prog.message_id });
  return editProgress(ctx, prog, msg.msgChainPick(), {
    ...html,
    ...Markup.inlineKeyboard([
      ...found.map((c) => [Markup.button.callback(c.label, `hubchn:${c.key}:${ca}`)]),
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
}

bot.action(/^hubchn:(\w+):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const prog = ctx.callbackQuery?.message
    ? { message_id: (ctx.callbackQuery.message as { message_id: number }).message_id }
    : null;
  await renderTokenHub(ctx, ctx.match[2], ctx.match[1], prog);
});

/** Back to the hub from any flow — re-rendered from memory (zero RPC). */
bot.action('hub:back', async (ctx) => {
  const h = hubs.get(ctx.from!.id);
  if (!h) return ctx.answerCbQuery('Expired — paste the CA again.');
  flows.delete(ctx.from!.id);
  tswapFlows.delete(ctx.from!.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText(h.text, { ...html, ...h.kb }).catch(() => {});
});

async function buyStartFromCA(ctx: any, ca: string, prog: { message_id: number } | null) {
  flows.delete(ctx.from.id); // whatever the /add wizard left behind must not swallow the buy amount
  if (!ethers.isAddress(ca)) {
    if (prog) return editProgress(ctx, prog, msg.msgInvalidAddress());
    return ctx.reply(msg.msgInvalidAddress(), html);
  }
  prog = await editProgress(ctx, prog, msg.msgProgress('detecting chain…'));
  const found = await buyDetectChains(ca);
  if (found.length === 0) {
    return editProgress(ctx, prog, msg.msgError('buy', 'Token not found on any chain supported by /buy.'));
  }
  const flow: TSwapFlow = { chainKey: found[0].key, buy: true, token: ethers.getAddress(ca), startedAt: Date.now() };
  tswapFlows.set(ctx.from.id, flow);
  if (found.length > 1) {
    flow.chainOptions = found.map((c) => c.key);
    return buyChainStep(ctx, flow, flow.chainOptions, true);
  }
  return buySafetyStep(ctx, flow, prog, true);
}

async function cmdBuy(ctx: any) {
  resetFlows(ctx.from.id);
  const ca = ((ctx.message?.text as string) || '').trim().split(/\s+/)[1];
  if (!ca) {
    tswapFlows.set(ctx.from.id, { chainKey: 'robinhood', buy: true, awaitingCA: true, startedAt: Date.now() });
    return buyAskCA(ctx, false);
  }
  const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
  return buyStartFromCA(ctx, ca, { message_id: prog.message_id });
}
bot.command('buy', cmdBuy);

bot.action(/^buychain:(\w+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  if (!CHAINS[ctx.match[1]]) return ctx.answerCbQuery('Chain unavailable.');
  flow.chainKey = ctx.match[1];
  flow.screenText = undefined; // ganti chain → screening ulang
  await ctx.answerCbQuery();
  await buySafetyStep(ctx, flow, null, true);
});

bot.action('buy:go', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buyBaseStep(ctx, flow, true);
});

bot.action(/^buybase:(weth|usdg|usdt)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  flow.base = baseOf(CHAINS[flow.chainKey]!, ctx.match[1] as BaseKind);
  await ctx.answerCbQuery();
  await buySizeStep(ctx, flow, true);
});

// The /buy Back button.
bot.action('buyback:ca', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow) return ctx.answerCbQuery('Expired — start again with /buy.');
  flow.awaitingCA = true;
  flow.screenText = undefined;
  await ctx.answerCbQuery();
  await buyAskCA(ctx, true);
});
bot.action('buyback:chain', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.chainOptions?.length) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buyChainStep(ctx, flow, flow.chainOptions, true);
});
bot.action('buyback:safety', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buySafetyStep(ctx, flow, null, true);
});
bot.action('buyback:base', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buyBaseStep(ctx, flow, true);
});
/** A percentage of the balance to a buy amount. The source is the USABLE balance (gas already set aside). */
bot.action(/^buypct:(\d+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.base || !flow.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  const sym = base.wrappable ? cc.nativeSymbol : base.symbol;
  void sym;
  await ctx.answerCbQuery();
  return buyFromPct(ctx, flow, Number(ctx.match[1]));
});

/** Shared by the preset buttons and "Custom %" in /buy. */
async function buyFromPct(ctx: any, flow: TSwapFlow, pct: number): Promise<unknown> {
  const cc = CHAINS[flow.chainKey]!;
  const base = flow.base!;
  const sym = base.wrappable ? cc.nativeSymbol : base.symbol;
  const usable = await buyUsableWei(flow).catch(() => 0n);
  const amountWei = pct >= 100 ? usable : (usable * BigInt(pct)) / 100n;
  if (amountWei <= 0n) {
    return ctx.reply(msg.msgError('buy', `No spendable ${sym} left after the gas reserve.`), html);
  }
  const label = `${Number(ethers.formatUnits(amountWei, base.decimals)).toLocaleString('id-ID', { maximumFractionDigits: base.decimals >= 18 ? 6 : 2 })} ${sym} (${pct}%)`;
  return tswapQuoteConfirm(ctx, flow, cc, base.address, flow.token!, amountWei, label);
}

bot.action('buyback:size', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.base || !flow.token) return ctx.answerCbQuery('Expired — start again with /buy.');
  await ctx.answerCbQuery();
  await buySizeStep(ctx, flow, true);
});

// The token-address prompt. Back goes to the base picker on a multi-base chain, or to the
// chain picker when there is only one base.
// ── /sell = the holdings-first flow ──────────────────────────────────────────
// /sell: list the tokens held, pick one, pick a percentage or amount, preview, confirm,
//   result. The receiving base is chosen AUTOMATICALLY, by best USD value: ETH vs USDG/USDT.
type SellHolding = {
  ca: string;
  symbol: string;
  dec: number;
  balWei: bigint;
  amountNum: number;
  usd: number | null;
  chainKey?: string; // the chain the token is held on, used by the sell execution path
};

async function bsFetch(url: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { headers: EXPLORER_HEADERS, signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// ERC20 tokens (not bases) with a balance above zero. Blockscout first, on-chain fallback.
async function sellHoldings(cc: ChainCtx): Promise<SellHolding[]> {
  // Only wrapped-native is skipped (that is /unwrap's job, not a swap).
  // The stablecoin bases (USDT/USDG) are DELIBERATELY included: turning them back into
  // native is a reasonable thing to ask, and without it USDT on BSC has no way out.
  const skip = new Set<string>([cc.wethAddress.toLowerCase()]);
  // Tokens we have TOUCHED before (bought or LP'd) count as legitimate even without a market price.
  const known = new Set<string>();
  for (const t of journal.recentTokens(80)) if (t.ca) known.add(t.ca.toLowerCase());
  for (const p of store.active()) if (p.ca) known.add(p.ca.toLowerCase());
  const out: SellHolding[] = [];
  if (cc.blockscout) {
    const data = await bsFetch(`${cc.blockscout}/addresses/${cc.wallet.address}/token-balances`);
    for (const it of Array.isArray(data) ? data : []) {
      const tk = it?.token;
      const ca = tk?.address_hash || tk?.address;
      if (!tk || !ca || (tk.type && tk.type !== 'ERC-20')) continue;
      const cal = String(ca).toLowerCase();
      if (skip.has(cal)) continue;
      let balWei: bigint;
      try { balWei = BigInt(it.value ?? '0'); } catch { continue; }
      if (balWei <= 0n) continue;
      const rate = Number(tk.exchange_rate ?? 0);
      // Airdrop spam guard: only tokens with VALUE (an exchange_rate) or ones we have traded.
      if (!(rate > 0) && !known.has(cal)) continue;
      // Blockscout sometimes leaves decimals empty, and guessing 18 gets the sell amount wrong.
      let dec: number;
      if (tk.decimals != null) dec = Number(tk.decimals);
      else {
        const d = await new ethers.Contract(ca, ERC20_ABI, cc.provider)
          .decimals()
          .catch(() => null);
        if (d === null) continue; // it cannot be confirmed, so do not offer it for sale
        dec = Number(d);
      }
      const amountNum = Number(ethers.formatUnits(balWei, dec));
      out.push({ ca: ethers.getAddress(ca), symbol: String(tk.symbol || '?'), dec, balWei, amountNum, usd: rate ? amountNum * rate : null });
    }
    await addStableBases(cc, out);
    await addNativeHolding(cc, out);
    out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    return out.slice(0, SELL_HOLDINGS_CAP);
  }
  // Fallback for a chain without Blockscout (Stable, say): candidates from the journal plus live positions.
  const cand = new Map<string, string>();
  for (const t of journal.recentTokens(40)) if (t.ca) cand.set(t.ca.toLowerCase(), t.symbol);
  for (const p of store.active()) if (p.ca) cand.set(p.ca.toLowerCase(), p.symbol);
  for (const [ca, sym] of [...cand].slice(0, HOLDINGS_CAND_MAX)) {
    if (skip.has(ca)) continue;
    try {
      const erc = new ethers.Contract(ca, ERC20_ABI, cc.provider);
      const balWei: bigint = await erc.balanceOf(cc.wallet.address);
      if (balWei <= 0n) continue;
      const dec = Number(await erc.decimals().catch(() => 18));
      out.push({ ca: ethers.getAddress(ca), symbol: sym, dec, balWei, amountNum: Number(ethers.formatUnits(balWei, dec)), usd: null });
    } catch {
      /* skip a token that cannot be read */
    }
  }
  await addStableBases(cc, out);
  await addNativeHolding(cc, out);
  return out.slice(0, SELL_HOLDINGS_CAP);
}

/** Native that MUST be left behind for gas — selling every last bit fails the tx itself. */
const NATIVE_SELL_RESERVE = ethers.parseEther('0.0005');

/**
 * The NATIVE balance (ETH/BNB) as a sell candidate into a stablecoin. It is recorded
 * under the wrapped-native address: the execution path wraps as needed before swapping,
 * and the receiving side falls to the stablecoin automatically (the same base the sold
 * token is dropped for).
 */
async function addNativeHolding(cc: ChainCtx, out: SellHolding[]): Promise<void> {
  if (!cc.hasWethBase) return;
  if (!basesFor(cc).some((b) => isStableBase(b.kind))) return; // there is nothing to sell into
  try {
    const raw: bigint = await cc.provider.getBalance(cc.wallet.address);
    const sellable = raw > NATIVE_SELL_RESERVE ? raw - NATIVE_SELL_RESERVE : 0n;
    if (sellable <= 0n) return;
    const amountNum = Number(ethers.formatEther(sellable));
    const px = await getEthUsd(cc.wethAddress, cc).catch(() => null);
    out.push({
      ca: ethers.getAddress(cc.wethAddress),
      symbol: cc.nativeSymbol,
      dec: 18,
      balWei: sellable,
      amountNum,
      usd: px !== null ? amountNum * px : null,
    });
  } catch {
    /* an unreadable native balance is skipped */
  }
}

/** This chain's stablecoin base balance (USDT/USDG) as a sell candidate. */
async function addStableBases(cc: ChainCtx, out: SellHolding[]): Promise<void> {
  // It needs a native counterpart: without one there is no sensible swap destination.
  if (!cc.hasWethBase) return;
  for (const b of basesFor(cc)) {
    if (!isStableBase(b.kind)) continue;
    if (out.some((h) => h.ca.toLowerCase() === b.address.toLowerCase())) continue;
    try {
      const erc = new ethers.Contract(b.address, ERC20_ABI, cc.provider);
      const balWei: bigint = await erc.balanceOf(cc.wallet.address);
      if (balWei <= 0n) continue;
      const amountNum = Number(ethers.formatUnits(balWei, b.decimals));
      out.push({ ca: ethers.getAddress(b.address), symbol: b.symbol, dec: b.decimals, balWei, amountNum, usd: amountNum });
    } catch {
      /* skip when unreadable */
    }
  }
}

const fmt4 = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });
/** "Chain: amount SYMBOL / $value" -- the one label for a holding, everywhere. */
function holdingLabel(h: SellHolding): string {
  const chain = CHAINS[h.chainKey ?? getChain().key]?.label ?? h.chainKey ?? getChain().label;
  // A missing price drops the dollar half rather than printing $0, which would read as
  // a worthless token instead of an unread one.
  const usd = h.usd === null || h.usd === undefined ? '' : ` / $${h.usd.toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
  return `${chain}: ${fmt4(h.amountNum)} ${h.symbol}${usd}`;
}

function sellListKb(list: SellHolding[], _showChain = false) {
  // "Chain: amount SYMBOL / $value". The chain leads because it decides where the swap
  // executes, and the dollar figure is what makes two holdings comparable at a glance.
  // A missing price drops the dollar half rather than printing $0, which would read as
  // a worthless token instead of an unread one.
  const rows = list.map((h, i) => [Markup.button.callback(holdingLabel(h), `sellpick:${i}`)]);
  rows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  return Markup.inlineKeyboard(rows);
}

// Step 2: pick a percentage or an amount.
function sellAmountStep(ctx: any, flow: TSwapFlow, edit: boolean) {
  flow.awaitingAmount = true;
  flow.previewBack = 'sellback:amount'; // Back from the preview returns to the percentage/amount step
  // Arriving from the hub means there is no holdings list to return to; go back to the token card.
  const back = flow.sellList ? 'sellback:list' : flow.fromHub ? 'hub:back' : 'cancel';
  const rows = [
    ...pctPresets.chunkButtons(pctPresets.get('sell').map((p) => Markup.button.callback(`${p}%`, `sellpct:${p}`))),
    [Markup.button.callback('Type an amount', 'sellpct:custom')],
    [Markup.button.callback('⬅️ Back', back), Markup.button.callback('❌ Cancel', 'cancel')],
  ];
  const extra = { ...html, ...Markup.inlineKeyboard(rows) };
  const text = msg.msgSellAmount(
    flow.holdingLine ??
      `${CHAINS[flow.chainKey ?? getChain().key]?.label ?? getChain().label}: ${fmt4(flow.tokenBalNum!)} ${flow.tokenSym}`,
  );
  return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
}

/**
 * The sell preview card. The payout is ALWAYS ETH, at the owner's request on 2 Aug 2026.
 *
 * There used to be automatic base selection here: ETH/USDG/USDT were compared by USD
 * value and the highest won. That made /sell sometimes land in a stablecoin unasked, and
 * mixed PnL across two denominations. Now there is no choice at all.
 *
 * A token whose liquidity is only in a USDG pool is still served: swapTokenToEthRobust
 * carries a 2-hop token->USDG->ETH route internally. So "always ETH" does not narrow what
 * can be sold, it only fixes where it ends up.
 */
async function sellPreview(ctx: any, flow: TSwapFlow, amountWei: bigint, amtLabel: string) {
  const cc = CHAINS[flow.chainKey]!;
  const prog = await ctx.reply(msg.msgProgress('finding the best sell route…'), html);
  // The NATIVE balance is in the sell list too, recorded under the wrapped-native address.
  // If the destination were also native, from would equal to — a swap into itself, which
  // always comes straight back. So selling native goes to the STABLECOIN instead; that is
  // also what addNativeHolding means by "no sell destination" when a chain has no
  // stablecoin base.
  const sellingNative = flow.token!.toLowerCase() === cc.wethAddress.toLowerCase();
  const dest = sellingNative
    ? basesFor(cc).find((b) => isStableBase(b.kind))
    : basesFor(cc).find((b) => b.wrappable);
  if (!dest) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(
      ctx,
      prog,
      msg.msgError('sell', sellingNative
        ? `${cc.label} has no stablecoin to sell ${cc.nativeSymbol} into.`
        : `${cc.label} has no native base to sell into.`),
    );
  }
  flow.base = dest;
  await tswapQuoteConfirm(ctx, flow, cc, flow.token!, dest.address, amountWei, amtLabel, { message_id: prog.message_id });
}

async function cmdSell(ctx: any) {
  resetFlows(ctx.from.id);
  const prog = await ctx.reply(msg.msgProgress('reading your holdings…'), html);
  // /buy accepts several chains, so /sell has to look at all of them — otherwise a token
  // bought on the Stable chain has no way out through the bot.
  const chains = swapTokenChains();
  const lists = await Promise.all(
    chains.map(async (c) => (await sellHoldings(c).catch(() => [])).map((h) => ({ ...h, chainKey: c.key }))),
  );
  const list = lists
    .flat()
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, SELL_HOLDINGS_CAP);
  if (list.length === 0) return editProgress(ctx, prog, msg.msgSellNoHoldings());
  const multiChain = new Set(list.map((h) => h.chainKey)).size > 1;
  const flow: TSwapFlow = { chainKey: list[0].chainKey!, buy: false, sellList: list, startedAt: Date.now(), sellMultiChain: multiChain };
  tswapFlows.set(ctx.from.id, flow);
  return editProgress(ctx, prog, msg.msgSellList(list.length), { ...html, ...sellListKb(list, multiChain) });
}
// /swap is the name on the menu; /sell stays alive as a hidden alias so older
// muscle memory and any pinned message still work.
bot.command('swap', cmdSell);
bot.command('sell', cmdSell);
// The "💱 Quick Sell" button on the /status card.
bot.action('sell:start', async (ctx) => {
  await ctx.answerCbQuery();
  return cmdSell(ctx);
});

bot.action(/^sellpick:(\d+)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.sellList) return ctx.answerCbQuery('Expired — start again with /sell.');
  const h = flow.sellList[Number(ctx.match[1])];
  if (h?.chainKey) flow.chainKey = h.chainKey; // execution MUST happen on that token's chain
  if (!h) return ctx.answerCbQuery('Invalid choice.');
  flow.token = h.ca;
  flow.tokenSym = h.symbol;
  flow.tokenDec = h.dec;
  flow.tokenBalWei = h.balWei;
  flow.tokenBalNum = h.amountNum;
  flow.holdingLine = holdingLabel(h);
  await ctx.answerCbQuery();
  await sellAmountStep(ctx, flow, true);
});

bot.action(/^sellpct:(\d+|custom)$/, async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token || flow.tokenBalWei === undefined) return ctx.answerCbQuery('Expired — start again with /sell.');
  if (ctx.match[1] === 'custom') {
    await ctx.answerCbQuery();
    // The holding line stays: without it the prompt asks "how much" with the balance
    // it refers to scrolled off the screen.
    return ctx.editMessageText(msg.msgSellTypeAmount(flow.holdingLine ?? '', flow.tokenSym!), {
      ...html,
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'sellback:amount')]]),
    });
  }
  const pct = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  const amountWei = pct >= 100 ? flow.tokenBalWei : (flow.tokenBalWei * BigInt(pct)) / 100n;
  const amtLabel = `${fmt4((flow.tokenBalNum! * pct) / 100)} ${flow.tokenSym} (${pct}%)`;
  await sellPreview(ctx, flow, amountWei, amtLabel);
});

// The /sell Back button.
bot.action('sellback:list', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.sellList) return ctx.answerCbQuery('Expired — start again with /sell.');
  flow.awaitingAmount = false;
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgSellList(flow.sellList.length), {
    ...html,
    ...sellListKb(flow.sellList, !!flow.sellMultiChain),
  });
});
bot.action('sellback:amount', async (ctx) => {
  const flow = tswapFlows.get(ctx.from!.id);
  if (!flow?.token) return ctx.answerCbQuery('Expired — start again with /sell.');
  await ctx.answerCbQuery();
  await sellAmountStep(ctx, flow, true);
});

/** Quote the best route and build the confirmation card. Shared by the typed and preset paths. */
async function tswapQuoteConfirm(
  ctx: any,
  tflow: TSwapFlow,
  cc: ChainCtx,
  fromAddr: string,
  toAddr: string,
  amountWei: bigint,
  amountInLabel: string,
  prog0?: { message_id: number },
) {
  const base = tflow.base!;
  const prog = prog0 ?? (await ctx.reply(msg.msgProgress('requesting the best-route quote…'), html));
  // The per-tx limit used to be enforced only in the /add wizard, so presets and typed
  // amounts elsewhere went unchecked. Each denomination carries its own limit (consistent
  // with amountCtx).
  {
    const stable = isStableBase(base.kind);
    const cap = stable ? maxStable : maxEth;
    const spend = Number(ethers.formatUnits(amountWei, base.decimals));
    if (spend > cap) {
      tswapFlows.delete(ctx.from!.id);
      return editProgress(
        ctx,
        prog,
        msg.msgError('swap', `Above the ${capLabelFor(cap, base.symbol)}/tx limit — lower the amount.`),
      );
    }
  }
  const q = await previewSwapOut(fromAddr, toAddr, amountWei, cc);
  if (!q) {
    tswapFlows.delete(ctx.from!.id);
    return editProgress(ctx, prog, msg.msgError('swap', 'No route (thin pool/liquidity). Try a different amount or token.'));
  }
  const outDec = tflow.buy ? tflow.tokenDec! : base.decimals;
  const outSym = tflow.buy ? tflow.tokenSym! : base.symbol;
  const estOutLabel = `${Number(ethers.formatUnits(q.out, outDec)).toLocaleString('id-ID', { maximumFractionDigits: outDec >= 18 ? 6 : 2 })} ${outSym}`;
  tflow.amountWei = amountWei;
  tflow.amountInLabel = amountInLabel;
  tflow.outLabel = estOutLabel;
  tflow.route = q.route;
  tflow.quotedAt = Date.now();
  tflow.quotedOutWei = q.out;
  tflow.awaitingAmount = false;

  // The balance AT STAKE goes on the card. For a buy with a wrappable base, what funds it
  // is native ETH (the execution path wraps), not the WETH balance.
  // using the WETH balance here would produce a false green.
  let balanceLabel: string | undefined;
  let shortLabel: string | null = null;
  try {
    if (tflow.buy) {
      const bal: bigint = base.wrappable
        ? await cc.provider.getBalance(cc.wallet.address)
        : await new ethers.Contract(base.address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address);
      const sym = base.wrappable ? cc.nativeSymbol : base.symbol;
      balanceLabel = `${msg.cleanUnits(bal, base.decimals)} ${sym}`;
      if (bal < amountWei) shortLabel = `${msg.cleanUnits(amountWei - bal, base.decimals)} ${sym}`;
    } else {
      balanceLabel = `${msg.cleanUnits(tflow.tokenBalWei ?? 0n, tflow.tokenDec ?? 18)} ${tflow.tokenSym}`;
    }
  } catch {
    /* an unreadable balance hides the balance line rather than blocking */
  }
  // A SWAP executes as soon as the amount is set: the owner asked for no confirm step on
  // this side. The protections the Confirm button used to carry are all still on:
  // quotedOutWei becomes the floor execTSwap holds the fill to, the per-tx limit was
  // checked above, and a shortfall still stops here with a card instead of a send.
  if (!tflow.buy && !shortLabel && !config.safety.dryRun) {
    await editProgress(ctx, prog, msg.msgProgress(`swapping ${amountInLabel} → ${estOutLabel}…`));
    // execTSwap is written for a button press: give it the two callback-only methods,
    // pointed at the progress bubble, rather than duplicating the money path for this
    // one entry point.
    const auto: any = Object.create(ctx);
    auto.answerCbQuery = async () => {};
    auto.editMessageText = (text: string, extra?: any) =>
      ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, text, extra).catch(() => {});
    return execTSwap(auto);
  }

  const kb = shortLabel
    ? [[Markup.button.callback('⬅️ Back', tflow.previewBack ?? 'buyback:size'), Markup.button.callback('❌ Cancel', 'cancel')]]
    : [
        [Markup.button.callback(`🟢 Confirm · ${amountInLabel}`, 'tswapok')],
        [Markup.button.callback('⬅️ Back', tflow.previewBack ?? 'buyback:size'), Markup.button.callback('❌ Cancel', 'cancel')],
      ];
  return editProgress(
    ctx,
    prog,
    msg.msgTSwapConfirm({
      buy: tflow.buy,
      chainLabel: cc.label,
      tokenSym: tflow.tokenSym!,
      amountInLabel,
      estOutLabel,
      route: q.route,
      dryRun: config.safety.dryRun,
      danger: tflow.screenBahaya,
      screenFailed: !tflow.screenBahaya && /FAILED/.test(tflow.screenText ?? ''),
      balanceLabel,
      shortLabel,
    }),
    { ...html, ...Markup.inlineKeyboard(kb) },
  );
}

/**
 * What the swap really cost: gas in dollars, and the gap between the quote and the fill.
 *
 * Both are read from what happened, never from the quote's own estimate. A receipt that
 * cannot be fetched drops that line rather than reporting zero -- "$0 fee" is a claim,
 * "no figure" is the truth.
 */
async function swapCost(
  cc: ChainCtx,
  txHashes: string[],
  quotedOutWei: bigint | undefined,
  outWei: bigint,
): Promise<{ feeUsd: number | null; slipPct: number | null }> {
  let feeUsd: number | null = null;
  try {
    const rcs = await Promise.all(txHashes.map((h) => cc.provider.getTransactionReceipt(h)));
    let gasWei = 0n;
    for (const rc of rcs) if (rc) gasWei += rc.gasUsed * (rc.gasPrice ?? 0n);
    const px = gasWei > 0n ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : null;
    if (px) feeUsd = Number(ethers.formatEther(gasWei)) * px;
  } catch {
    /* no receipt, no fee line */
  }
  // Positive = filled BELOW the quote, which is the direction that costs money. A fill
  // above the quote is reported as 0, not as a negative "gain" the user cannot bank on.
  const slipPct =
    quotedOutWei && quotedOutWei > 0n
      ? Math.max(0, (Number(quotedOutWei - outWei) / Number(quotedOutWei)) * 100)
      : null;
  return { feeUsd, slipPct };
}

/**
 * Wrap native into wrapped, BUT leave enough for gas.
 *
 * Without this reserve: type an amount right up against the balance and the deposit
 * succeeds, then approve and swap fail with "insufficient funds for gas". The money is
 * now WETH, and even /unwrap needs the gas that is already gone — stuck until the wallet
 * is topped up. Better to refuse here.
 */
/** How long the figures on a /buy or /sell Preview card stay valid (same as /bridge). */
/**
 * Unwrap stray WETH back to native. Called after an add or close fails part-way, so no
 * manual /unwrap is needed and there is no waiting for the monitor's sweep (a 1-minute
 * cycle). Safe to repeat: a zero balance sends no transaction at all.
 */
async function recoverStrayWeth(cc: ChainCtx, why: string): Promise<void> {
  if (config.safety.dryRun || !cc.hasWethBase) return;
  const bal: bigint = await cc.weth.balanceOf(cc.wallet.address);
  if (bal === 0n) return;
  const tx = await cc.weth.withdraw(bal);
  await tx.wait();
  console.log(`[recover:${why}] unwrap ${ethers.formatEther(bal)} → ${cc.nativeSymbol} (${cc.key}) tx ${tx.hash}`);
}

const TSWAP_QUOTE_TTL_MS = 120_000;
/** Maximum slippage for /buy and /sell. Now simply the bot-wide ceiling: close and
 *  sweep are held to the same 1-3% band, so this is no longer a stricter special case. */
const MAX_SLIP_PCT = SLIP_MAX_PCT;

async function wrapWithGasReserve(cc: ChainCtx, wrapWei: bigint): Promise<void> {
  const [nativeBal, buffer] = await Promise.all([
    cc.provider.getBalance(cc.wallet.address),
    gasBuffer(cc),
  ]);
  if (nativeBal < wrapWei + buffer) {
    throw new Error(
      `Not enough ${cc.nativeSymbol} for the swap plus gas: need ~${ethers.formatEther(wrapWei + buffer)}, ` +
        `available ${ethers.formatEther(nativeBal)}. Lower the amount or top up.`,
    );
  }
  const wtx = await cc.weth.deposit({ value: wrapWei });
  await wtx.wait();
}

/**
 * Execute the swap the flow describes. Registered as the Confirm button, and called
 * directly when a typed amount executes straight away -- one implementation, so the
 * auto path cannot drift from the confirmed one.
 */
async function execTSwap(ctx: any) {
  const uid = ctx.from!.id;
  const flow = tswapFlows.get(uid);
  if (!flow || flow.amountWei === undefined || !flow.base || !flow.token) {
    return ctx.answerCbQuery('Expired — start again with /buy or /sell.');
  }
  // The numbers on a Preview card have a shelf life. Without this limit, a confirm tapped
  // an hour later executes at that moment's price — the user agreed to different figures.
  if (Date.now() - (flow.quotedAt ?? 0) > TSWAP_QUOTE_TTL_MS) {
    tswapFlows.delete(uid);
    await ctx.answerCbQuery('Quote expired.');
    return ctx.reply(
      msg.msgError('swap', 'The quote is older than 2 minutes — run /buy or /sell again for fresh numbers.'),
      html,
    );
  }
  if (tswapInFlight.has(uid)) return ctx.answerCbQuery('Processing…');
  tswapInFlight.add(uid);
  store.beginMoneyOp();
  const { chainKey, buy, base, token, tokenSym, tokenDec, amountWei, amountInLabel } = flow;
  tswapFlows.delete(uid); // idempotency: clear it BEFORE executing, so a double-tap cannot swap twice
  const cc = CHAINS[chainKey]!;
  await ctx.answerCbQuery('Processing…');
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(
        msg.msgTSwapDone({ buy, tokenSym: tokenSym!, amountInLabel: amountInLabel!, outLabel: flow.outLabel ?? '(estimated)', dryRun: true }),
        html,
      );
      return;
    }
    await ctx.editMessageText(msg.msgProgress('swapping via the best route…'), html);
    // The price floor is the number the user ACTUALLY saw on the Preview card, minus 3%.
    // The execution route re-quotes itself and steps 1% -> 2% -> 3%, never beyond;
    // without this comparison nothing ties the executed result back to the figure shown.
    // agreed to. The check runs BEFORE the first tx, so aborting here costs 1 RPC.
    if (flow.quotedOutWei && flow.quotedOutWei > 0n) {
      const [qFrom, qTo] = buy ? [base!.address, token!] : [token!, base!.address];
      const fresh = await previewSwapOut(qFrom, qTo, amountWei, cc).catch(() => null);
      const floor = (flow.quotedOutWei * 97n) / 100n;
      if (fresh && fresh.out < floor) {
        throw new Error(
          `Price moved against you since the preview (quoted ${flow.outLabel}, now ~${Number(
            ethers.formatUnits(fresh.out, buy ? tokenDec! : base!.decimals),
          ).toFixed(6)}). Nothing was swapped — run /${buy ? 'buy' : 'sell'} again.`,
        );
      }
    }
    const attempt = async (): Promise<{ outLabel: string; route: string; outWei: bigint; txHashes: string[] }> => {
      if (buy) {
        // base -> token. With an ETH base: wrap what is needed first (Uniswap wants WETH).
        if (base!.wrappable) {
          const have: bigint = await cc.weth.balanceOf(cc.wallet.address);
          if (have < amountWei) await wrapWithGasReserve(cc, amountWei - have);
        }
        const r = await swapExactInBest(base!.address, token!, amountWei, cc, MAX_SLIP_PCT, MAX_SLIP_PCT);
        return {
          outLabel: `${Number(ethers.formatUnits(r.outWei, tokenDec!)).toLocaleString('id-ID', { maximumFractionDigits: 6 })} ${tokenSym}`,
          route: r.route,
          outWei: r.outWei,
          txHashes: r.txHashes,
        };
      }
      // Selling the NATIVE balance: the sell list records it under the wrapped-native address,
      // but the money is still native and has never been wrapped. Without this step every
      // route tries to pull WBNB with a zero balance ("STF", "did not reduce the token
      // balance"). Selling native goes to the stablecoin, not to native: native into native
      // is a swap into itself.
      if (token!.toLowerCase() === cc.wethAddress.toLowerCase()) {
        const have: bigint = await cc.weth.balanceOf(cc.wallet.address);
        if (have < amountWei) await wrapWithGasReserve(cc, amountWei - have);
        const r = await swapTokenToUsdgRobust(token!, amountWei, base!.address, cc, MAX_SLIP_PCT);
        return {
          outLabel: `${Number(ethers.formatUnits(r.outWei, base!.decimals)).toFixed(2)} ${base!.symbol}`,
          route: r.route,
          outWei: r.outWei,
          txHashes: r.txHashes,
        };
      }
      // Selling an ordinary token ends in native ETH (owner's request, 2 Aug 2026).
      // A token with only a USDG pool is still served, through the internal 2-hop route.
      // swapTokenToEthRobust (token→USDG→ETH).
      const r = await swapTokenToEthRobust(token!, amountWei, cc, MAX_SLIP_PCT);
      return {
        outLabel: `${Number(ethers.formatEther(r.outEthWei)).toFixed(6)} ${cc.nativeSymbol}`,
        route: r.route,
        outWei: r.outEthWei,
        txHashes: r.txHashes,
      };
    };

    // The probe is the input asset's balance. A drop means the swap already ran (at least
    // partly), so do not retry. When selling native, it is NATIVE that drops. Using the
    // WBNB balance here would instead RISE from 0 after the wrap, so an attempt that had
    // landed would read as "not started" and be retried — wrapping twice.
    const sellNative = !buy && token!.toLowerCase() === cc.wethAddress.toLowerCase();
    const inC = new ethers.Contract(buy ? base!.address : token!, ERC20_ABI, cc.provider);
    const probe = sellNative
      ? () => cc.provider.getBalance(cc.wallet.address)
      : () => inC.balanceOf(cc.wallet.address) as Promise<bigint>;
    const { outLabel, route, outWei, txHashes } = await retryOnce(
      'swap',
      probe,
      attempt,
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    // Gas actually burned, and how far the fill landed from the quote. Both are
    // measured after the fact -- the quote's own fee estimate is a guess, and slippage
    // that is not compared against a real fill is just the slippage cap restated.
    const { feeUsd, slipPct } = await swapCost(cc, txHashes, flow.quotedOutWei, outWei);
    await ctx.editMessageText(
      msg.msgTSwapDone({ buy, tokenSym: tokenSym!, amountInLabel: amountInLabel!, outLabel, route, feeUsd, slipPct, dryRun: false }),
      html,
    );
  } catch (e) {
    await ctx.reply(msg.msgError('swap', e), html);
  } finally {
    tswapInFlight.delete(uid);
    store.endMoneyOp();
  }
}

bot.action('tswapok', execTSwap);

bot.action(/^stop:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await renderStopConfirm(ctx, ctx.match[1], true);
  } catch (e) {
    if (isGoneErr(e)) {
      finalizeClose(ctx.match[1], { reason: 'gone' });
      await ctx.editMessageText(msg.msgAlreadyClosed(ctx.match[1]), html);
    } else {
      // Failing to READ the details (an RPC timeout, a quoter revert) does not mean the
      // position cannot be closed — executeRemove needs none of those numbers. Keep the exit open.
      await ctx.reply(msg.msgError('stop', (e as Error).message), {
        ...html,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⛔ Force Close', `close:${ctx.match[1]}`)],
          [Markup.button.callback('❌ Cancel', 'cancel')],
        ]),
      });
    }
  }
});

// tokenIds currently closing — this prevents a double-tap on "Close Position" (the second
// tx reverts and burns gas). Held in the store so the monitor sees it too (never journal
// something mid-close). The value is the start epoch: the lock expires after 10 minutes so
// a hung tx cannot lock a position forever (the only way out used to be a restart).
const closingInFlight = store.closing;
const CLOSING_LOCK_MS = 10 * 60_000;
const closeLocked = (tokenId: string): boolean => {
  const t = closingInFlight.get(tokenId);
  return t !== undefined && Date.now() - t < CLOSING_LOCK_MS;
};

/** Send the profit card PNG, the key moment. Pure presentation, wrapped completely,
 *  a render or send failure must NOT disturb a close that already succeeded. */
async function sendProfitCard(
  ctx: any,
  tokenId: string,
  rec: store.PosRecord | undefined,
  baseOutWei: bigint,
  feesBaseWei?: bigint,
  shape?: 'spot' | 'bidask',
): Promise<void> {
  if (!rec) return;
  const dec = baseDecimalsOf(rec.chain, rec.baseKind);
  const baseSym = baseSymbolOf(rec.baseKind, ctxOf(rec));
  const baseIn = Number(ethers.formatUnits(BigInt(rec.initialWethWei), dec));
  const baseOut = Number(ethers.formatUnits(baseOutWei, dec));
  // Both sides priced in dollars, each at its OWN moment: the deposit at the rate stored
  // when the position opened, the proceeds at the rate now. That is what the money did.
  //
  // The figure therefore INCLUDES any move in the base asset itself -- deposit 1 ETH, get
  // 1 ETH back while ETH fell, and this reads negative. For a stablecoin base the two
  // rates are both 1, so nothing is folded in at all.
  const nowUsd = isStableBase(rec.baseKind ?? 'weth') ? 1 : await getEthUsd(ctxOf(rec).wethAddress, ctxOf(rec)).catch(() => null);
  const entryUsd = rec.entryEthUsd ?? nowUsd;
  const usdKnown = nowUsd !== null && entryUsd !== null && entryUsd > 0;
  const pnl = usdKnown ? baseOut * nowUsd! - baseIn * entryUsd! : baseOut - baseIn;
  const pnlPct = usdKnown
    ? baseIn * entryUsd! > 0
      ? (pnl / (baseIn * entryUsd!)) * 100
      : 0
    : baseIn > 0
      ? ((baseOut - baseIn) / baseIn) * 100
      : 0;
  const positive = pnl >= 0;
  const fmt = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: dec >= 18 ? 5 : 2 });
  // Dollars when both rates are known; otherwise the base asset, because an unpriced
  // close must not invent a dollar figure.
  const usd2 = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnlBig = usdKnown
    ? `${positive ? '+' : '-'}$${usd2(Math.abs(pnl))}`
    : `${positive ? '+' : ''}${fmt(pnl)} ${baseSym}`;
  const buf = await renderProfitCard({
    pair: pairLabel(baseSym, rec.symbol),
    positive,
    pnlBig,
    pnlPct: msg.fmtPct(pnlPct),
    stats: [
      { label: 'deposit', value: usdKnown ? `$${usd2(baseIn * entryUsd!)}` : `${fmt(baseIn)} ${baseSym}` },
      { label: 'received', value: usdKnown ? `$${usd2(baseOut * nowUsd!)}` : `${fmt(baseOut)} ${baseSym}` },
      { label: 'held', value: msg.fmtAge(Date.now() - rec.openedAt) },
      // Fees are read BEFORE the burn (see the caller). Unreadable leaves the fourth box
      // empty rather than showing a 0, which reads as "earned no fees at all".
      ...(feesBaseWei !== undefined && feesBaseWei > 0n
        ? [
            {
              label: 'fees',
              value: usdKnown
                ? `$${usd2(Number(ethers.formatUnits(feesBaseWei, dec)) * nowUsd!)}`
                : `${fmt(Number(ethers.formatUnits(feesBaseWei, dec)))} ${baseSym}`,
            },
          ]
        : []),
    ],
    // nowWib() carries the date now; the ISO prefix printed it twice.
    footerLeft: `#${tokenId} · ${msg.nowWib()}`,
    // The position's shape follows its record; an older position with no marker is treated
    // as SPOT (which is exactly how things behaved before ladders existed).
    shape: shape ?? rec.shape ?? 'spot',
  });
  // sendDocument, NOT sendPhoto: Telegram re-encodes photos as JPEG (measured at 1130 KB
  // -> 185 KB) and the artefacts show worst on crisp text over a dark background, which is
  // exactly this card. As a document the PNG arrives intact.
  await ctx.replyWithDocument(Input.fromBuffer(buf, `philips-${tokenId}.png`));
}

/**
 * Close every leg of a ladder group as a BATCH: remove+collect+burn all legs through
 * multicall (~1 tx per chunk), then ONE aggregate token->base swap. Proceeds are split
 * proportionally to each leg (by capital) so the per-leg PnL journal stays correct.
 */
async function closeGroup(ctx: any, groupId: string, legs: store.PosRecord[]) {
  await ctx.answerCbQuery('Closing ladder…');
  if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunClose(groupId), html));
  const cc = ctxOf(legs[0]);
  const tokenIds = legs.map((l) => l.tokenId);
  for (const l of legs) closingInFlight.set(l.tokenId, Date.now());
  store.beginMoneyOp();
  try {
    // Every leg shares a pool, so base and token are the same. Read from the first leg that
    // STILL exists (leg 0 may already be burned, making positions() throw; do not fail the close).
    let p: { token0: string; token1: string } | null = null;
    for (const id of tokenIds) {
      try {
        const q = await cc.positionManager.positions(id);
        p = { token0: q.token0, token1: q.token1 };
        break;
      } catch {
        /* this leg is gone, try the next one */
      }
    }
    if (!p) throw new Error('All ladder legs already closed on-chain.');
    const base = detectBase(cc, p.token0, p.token1);
    if (!base) throw new Error('This pool is not paired with WETH/USDG/USDT — close manually at app.uniswap.org.');
    const otherAddr = base.address.toLowerCase() === p.token0.toLowerCase() ? p.token1 : p.token0;
    const otherC = new ethers.Contract(otherAddr, ERC20_ABI, cc.wallet);
    const baseC = base.wrappable ? cc.weth : new ethers.Contract(base.address, ERC20_ABI, cc.wallet);
    const baseBefore: bigint = await baseC.balanceOf(cc.wallet.address);
    const otherBefore: bigint = await otherC.balanceOf(cc.wallet.address).catch(() => 0n);

    await ctx.editMessageText(msg.msgProgress(`closing ${legs.length}-leg ladder (batched)…`), html);
    const notes: string[] = [];
    // Fees are read BEFORE the burn: afterwards they have merged into the cash-out proceeds.
    const feesWei = (
      await Promise.all(
        tokenIds.map((id) => getPositionDetail(id, cc).then((dd) => dd.feesBaseWei).catch(() => 0n)),
      )
    ).reduce((a, b) => a + b, 0n);
    notes.push(...(await executeRemoveBatch(tokenIds, cc)).notes);
    // No withdrawal tx sent means nothing was closed. Carrying on to finalisation would
    // mark LIVE positions as closed and then delete their records — exactly what happened
    // on 28 Aug 2026.
    if (!notes.some((n) => n.startsWith('Batch close ') && n.includes('tx '))) {
      throw new Error(
        'No withdrawal transaction was sent, so nothing was closed. Your positions are untouched — try again.',
      );
    }
    await sleep(1500);
    const sw = await sweepTokenToBase(otherAddr, otherC, base, cc, notes, otherBefore).catch(() => ({
      baseOut: 0n,
      txHashes: [] as string[],
      leftover: true,
      leftoverWei: 0n,
    }));

    let totalOut: bigint;
    if (base.wrappable) {
      // WETH: principal and swap proceeds all land as WETH, so measure the rise then unwrap.
      const wethBal: bigint = await cc.weth.balanceOf(cc.wallet.address).catch(() => 0n);
      totalOut = wethBal > baseBefore ? wethBal - baseBefore : sw.baseOut;
      if (wethBal > 0n) {
        try {
          await (await cc.weth.withdraw(wethBal)).wait();
        } catch (e) {
          console.error(`[unwrap] failed to close ladder ${groupId}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    } else {
      const baseAfter: bigint = await baseC.balanceOf(cc.wallet.address);
      totalOut = baseAfter > baseBefore ? baseAfter - baseBefore : sw.baseOut;
    }

    // Split the proceeds proportionally to each leg's capital, so the per-leg PnL journal
    // still makes sense.
    const totalInit = legs.reduce((s, l) => s + BigInt(l.initialWethWei || '0'), 0n);
    let attributed = 0n;
    legs.forEach((l, i) => {
      const share = i === legs.length - 1 ? totalOut - attributed : totalInit > 0n ? (totalOut * BigInt(l.initialWethWei || '0')) / totalInit : 0n;
      attributed += share;
      finalizeClose(l.tokenId, {
        // Stamp the ladder: these 8 legs are ONE position. Without the stamp /pnl counts
        // them as 8 trades and splits the PnL into eighths — small enough to be treated as
        // dust and vanish from W/L. See `groupOf` in journal.ts.
        groupId,
        ...(share > 0n ? { resultEthWei: share } : {}),
        reason: 'cashed',
        keep: i === 0 && sw.leftover,
        leftoverWei: i === 0 ? sw.leftoverWei : 0n,
      });
    });

    const baseSym = base.wrappable ? cc.nativeSymbol : base.symbol;
    const outLabel = base.wrappable ? `${msg.fmtEth(totalOut)} ${baseSym}` : `${msg.cleanUnits(totalOut, base.decimals)} ${baseSym}`;
    // The SAME card as a single-position close: steps, hashes and closing sentence. A
    // ladder used to get one line with no transaction trail — and this is precisely where
    // there are the most transactions.
    await ctx.reply(
      msg.msgCashOut({
        tokenId: legs[0].tokenId,
        legs: legs.length,
        pair: `$${msg.posPair(`${baseSym} / ${legs[0].symbol}`, baseSym)}`,
        protocol: 'V3',
        notes,
        ethOut: outLabel,
        txHashes: sw.txHashes ?? [],
        baseSymbol: baseSym,
        native: base.wrappable,
        leftover: sw.leftover,
      }),
      { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Other Positions', 'positions')]]) },
    );
    // A PnL card for the WHOLE ladder (see the matching note on the v4 path). A result of 0
    // means the balance delta could not be measured, NOT a total loss: the card would print
    // -100% while the money is intact. Better no card than a lying one.
    if (totalOut > 0n) {
      await sendProfitCard(
      ctx,
      `${legs[0].tokenId} +${legs.length - 1}`,
      { ...legs[0], initialWethWei: totalInit.toString(), openedAt: Math.min(...legs.map((l) => l.openedAt)) },
      totalOut,
      feesWei,
        legs[0].shape ?? 'bidask',
      ).catch((e) => console.log('[profit-card] the ladder card failed:', (e as Error).message.slice(0, 120)));
    } else {
      await ctx.reply(msg.note('Result could not be measured, so no PnL card for this close.'), html);
    }
  } catch (err) {
    await recoverStrayWeth(cc, 'close ladder').catch(() => {});
    await ctx.reply(msg.msgError('close ladder', (err as Error).message), html);
  } finally {
    for (const l of legs) closingInFlight.delete(l.tokenId);
    store.endMoneyOp();
  }
}

/** Close a v4 ladder group in one batch (BURN x N + TAKE_PAIR in a single tx) plus an aggregate swap, journalled per leg. */
async function closeGroupV4(ctx: any, groupId: string, legs: import('./v4store.js').V4Record[]) {
  await ctx.answerCbQuery('Closing v4 ladder…');
  if (config.safety.dryRun) return void (await ctx.editMessageText(msg.msgDryRunClose(groupId), html));
  const cc = getChain(legs[0].chain);
  const tokenIds = legs.map((l) => l.tokenId);
  for (const l of legs) closingInFlight.set(`v4:${l.tokenId}`, Date.now());
  store.beginMoneyOp();
  try {
    await ctx.editMessageText(msg.msgProgress(`closing ${legs.length}-leg v4 ladder (batched)…`), html);
    // Fees are read BEFORE the burn: afterwards they have merged into the cash-out proceeds
    // and cannot be separated again. A failed read is not a failed close — the card simply
    // loses one box.
    const feesWei = (
      await Promise.all(
        tokenIds.map((id) => checkV4Status(cc, id).then((st) => st.val?.feesBaseWei ?? 0n).catch(() => 0n)),
      )
    ).reduce((a, b) => a + b, 0n);
    const r = await closeLadderV4(tokenIds, cc, { dryRun: false });
    // Split the proceeds proportionally to each leg's capital, keeping the per-leg PnL journal correct.
    const totalInit = legs.reduce((s, l) => s + BigInt(l.entryBaseWei || '0'), 0n);
    let attributed = 0n;
    legs.forEach((l, i) => {
      const share = i === legs.length - 1 ? r.baseOutWei - attributed : totalInit > 0n ? (r.baseOutWei * BigInt(l.entryBaseWei || '0')) / totalInit : 0n;
      attributed += share;
      journal.recordClose(
        {
          tokenId: l.tokenId,
          symbol: `${r.sym0}/${r.sym1}`,
          ca: r.other,
          chain: cc.key,
          baseKind: v4Kind(cc, r.base),
          openedAt: l.openedAt,
          initialWethWei: l.entryBaseWei || '0',
        },
        { ...(share > 0n ? { resultEthWei: share } : {}), reason: 'cashed', groupId },
      );
      v4store.removeV4(l.tokenId);
    });
    invalidateV4ListCache();
    const dec = v4BaseDecimals(cc, r.base);
    const sym = v4BaseSymbol(cc, r.base);
    // The token side's symbol, for the pair on the card. A failed read is not fatal.
    const otherSym = r.other ? await v4TokenSymbol(r.other, cc).catch(() => 'token') : 'token';
    // The same close card as the v3 path. v4 returns no list of steps, so one is assembled
    // here from what actually happened — without it the card loses the "Steps performed"
    // section that makes a close traceable.
    await ctx.reply(
      msg.msgCashOut({
        tokenId: legs[0].tokenId,
        legs: legs.length,
        pair: `$${msg.posPair(`${sym} / ${otherSym}`, sym)}`,
        protocol: 'V4',
        notes: [
          `Close ${legs.length}-leg v4 ladder (batched)`,
          ...(r.cashedOut ? [`Swap: token → ${r.cashedOut}`] : []),
        ],
        ethOut: `${msg.cleanUnits(r.baseOutWei, dec)} ${sym}`,
        txHashes: r.txHash ? [r.txHash] : [],
        baseSymbol: sym,
        native: r.base === 'ETH',
      }),
      { ...html, ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Other Positions', 'positions')]]) },
    );
    // A leg forced to burn without a price floor has to be visible, not just in the log.
    if (r.unprotected?.length) await ctx.reply(msg.esc(V4_UNPROTECTED_NOTE(r.unprotected.join(', #'))), html);
    // Ghost legs (absent from the chain) are dropped from the records — left in place they
    // would fail EVERY subsequent close attempt with NOT_MINTED.
    if (r.gone?.length) {
      for (const id of r.gone) v4store.removeV4(id);
      await ctx.reply(
        msg.note(`${r.gone.length} leg no longer existed on-chain and were dropped from tracking.`),
        html,
      );
    }
    // A PnL card for the WHOLE ladder — what the user deposited is one ladder, not 8
    // separate positions. The ladder paths (v3 and v4) used to send no card at all; only a
    // single-position close had one.
    if (r.baseOutWei > 0n) {
      await sendProfitCard(
      ctx,
      `${legs[0].tokenId} +${legs.length - 1}`,
      {
        tokenId: legs[0].tokenId,
        chain: cc.key,
        baseKind: v4Kind(cc, r.base),
        symbol: `${r.sym0}/${r.sym1}`,
        initialWethWei: totalInit.toString(),
        openedAt: Math.min(...legs.map((l) => l.openedAt)),
      } as store.PosRecord,
      r.baseOutWei,
      feesWei,
        legs[0].shape ?? 'bidask',
      ).catch((e) => console.log('[profit-card] the v4 ladder card failed:', (e as Error).message.slice(0, 120)));
    } else {
      await ctx.reply(msg.note('Result could not be measured, so no PnL card for this close.'), html);
    }
  } catch (err) {
    await recoverStrayWeth(cc, 'close v4 ladder').catch(() => {});
    // The entire group turns out to be absent from the chain, so drop its records. Leaving
    // them makes every later close attempt fail for the same reason.
    if (/no longer exist on-chain/i.test((err as Error).message)) {
      for (const l of legs) v4store.removeV4(l.tokenId);
      invalidateV4ListCache();
    }
    await ctx.reply(msg.msgError('close v4 ladder', (err as Error).message), html);
  } finally {
    for (const l of legs) closingInFlight.delete(`v4:${l.tokenId}`);
    store.endMoneyOp();
  }
}

/** Close ONE v3 position. Registered as the Close button, and reused by Close All. */
async function execCloseV3(ctx: any) {
  const tokenId = ctx.match[1];
  const tappedRec = store.get(tokenId);
  // For a ladder, closing one leg closes the WHOLE group, since it is one logical position.
  // Each leg is closed in turn, the proceeds are summed, and one summary is shown.
  if (tappedRec?.groupId) {
    const legs = store.group(tappedRec.groupId).filter((r) => !closeLocked(r.tokenId));
    if (legs.length > 1) return closeGroup(ctx, tappedRec.groupId, legs);
  }
  if (closeLocked(tokenId)) return ctx.answerCbQuery('Processing…');
  closingInFlight.set(tokenId, Date.now());
  const closingRec = store.get(tokenId); // capture it BEFORE finalizeClose removes it
  // A close is remove + collect + swap + unwrap and can take 1-2 minutes. Without this
  // marker the monitor's sweep (every minute) could run in the middle of it from the same
  // wallet: a nonce clash, or this close's WETH being swept along with it.
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgDryRunClose(tokenId), html);
      return;
    }
    // MUST be venue-aware: a position opened on Uniswap v3 on BSC has to be closed through
    // Uniswap's PositionManager. With getChain() alone it uses PancakeSwap's PM, and
    // positions(tokenId) points at SOMEONE ELSE'S position — detectBase fails and the close
    // stops with "pool is not paired with WETH/USDG/USDT".
    const ccClose = closingRec ? ctxOf(closingRec) : getChain();
    const baseSym = isStableBase(closingRec?.baseKind ?? 'weth')
      ? baseSymbolOf(closingRec?.baseKind, ccClose)
      : ccClose.nativeSymbol;
    await ctx.editMessageText(msg.msgClosing(baseSym), html);
    // The probe is the position's liquidity. A drop means decreaseLiquidity or the burn
    // landed, so starting over would only revert (and could sell twice). A position already
    // gone makes pm.positions throw, giving probe -1n — also not retried.
    const summary = await retryOnce(
      'close',
      async () => BigInt((await ccClose.positionManager.positions(tokenId)).liquidity),
      () => stopAndCashOut(tokenId, ccClose),
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    // resultEthWei = 0 is a backfill PLACEHOLDER in the journal (excluded from PnL). A
    // genuinely unmeasurable result must be undefined, not 0.
    finalizeClose(tokenId, {
      ...(summary.baseOutWei > 0n ? { resultEthWei: summary.baseOutWei } : {}),
      reason: 'cashed',
      keep: summary.leftover,
      leftoverWei: summary.leftoverWei,
    });
    await ctx.reply(summary.text, {
      ...html,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Other Positions', 'positions')],
        [Markup.button.callback('💧 Open a New LP', 'howto:add')],
      ]),
    });
    await sendProfitCard(ctx, tokenId, closingRec, summary.baseOutWei, summary.feesBaseWei).catch((e) =>
      console.log('[profit-card] failed:', (e as Error).message.slice(0, 120)),
    );
  } catch (err) {
    if (isGoneErr(err)) {
      finalizeClose(tokenId, { reason: 'gone' });
      await ctx.reply(msg.msgAlreadyClosed(tokenId), html);
    } else {
      // A close that fails part-way usually leaves WETH from the remove behind. That used
      // to mean a manual /unwrap (or waiting up to a minute for the monitor's sweep). Tidy
      // it up here too: withdraw() is safe and idempotent — no WETH means no tx.
      await recoverStrayWeth(getChain(closingRec?.chain), 'close').catch(() => {});
      await ctx.reply(msg.msgError('close', err), html);
    }
  } finally {
    closingInFlight.delete(tokenId);
    store.endMoneyOp();
  }
}

bot.action(/^close:(\d+)$/, execCloseV3);

/** Remove + collect, then swap every LP asset to ETH (tokens via Relay, WETH unwrapped). */

async function stopAndCashOut(
  tokenId: string,
  cc: ChainCtx = getChain(),
): Promise<{ text: string; baseOutWei: bigint; leftover: boolean; leftoverWei: bigint; feesBaseWei?: bigint }> {
  const { positionManager: pm, weth: wethC, wallet: w } = cc;
  const p = await pm.positions(tokenId);
  // A pool with no base we recognise (an imported TOKENA/TOKENB, say) has no two-sided
  // cash-out route. Falling back to WETH would burn the position, then miscalculate
  // (unwrapping WETH belonging to another operation) and leave one token side stranded.
  // Failed BEFORE the burn, so the funds are still intact in the position.
  const base = detectBase(cc, p.token0, p.token1);
  if (!base) {
    throw new Error(
      'This pool is not paired with WETH/USDG/USDT — the bot cannot cash out both sides. Close it manually at app.uniswap.org.',
    );
  }
  const otherAddr = base.address.toLowerCase() === p.token0.toLowerCase() ? p.token1 : p.token0;
  const otherC = new ethers.Contract(otherAddr, ERC20_ABI, w);
  const baseC = base.wrappable ? wethC : new ethers.Contract(base.address, ERC20_ABI, w);
  const baseBefore: bigint = await baseC.balanceOf(w.address);
  // The token balance BEFORE the burn is any spot bag you hold separately. The cash-out may
  // only sell what THIS position produced (the delta above it), never your bag.
  const otherBefore: bigint = await otherC.balanceOf(w.address).catch(() => 0n);

  // Unclaimed fees are READ BEFORE the burn: afterwards the position is gone and the fees
  // have merged into the cash-out proceeds, never to be separated. A failed read is not
  // close: the card merely loses one box.
  const feesBaseWei = await getPositionDetail(tokenId, cc)
    .then((d) => d.feesBaseWei)
    .catch(() => undefined);

  const notes: string[] = [];
  notes.push(...(await executeRemove(tokenId, cc)).notes);
  await sleep(1500); // give the collect time to settle before reading the balance

  const txHashes: string[] = [];
  // (1) Swap the position's token proceeds (above the old bag) to base, repeating until
  //     none remain (not once, and not by delta). This covers leftovers from an older close,
  //     a lagging RPC, and no-ops.
  // The NFT is already burned above: from here on NOTHING may throw, or the user sees only
  // a raw ERROR and never learns the position was withdrawn (losing the PnL with it).
  let sw: { baseOut: bigint; txHashes: string[]; leftover: boolean; leftoverWei: bigint } = {
    baseOut: 0n,
    txHashes: [],
    leftover: true, // a conservative default: assume something is left, so the monitor retries
    leftoverWei: 0n,
  };
  try {
    sw = await sweepTokenToBase(otherAddr, otherC, base, cc, notes, otherBefore);
  } catch (e) {
    notes.push(`Cash-out failed: ${(e as Error).message.slice(0, 120)} — token held, the monitor will retry.`);
  }
  txHashes.push(...sw.txHashes);

  let baseOutWei: bigint;
  if (base.wrappable) {
    // 2. WETH: unwrap the ENTIRE balance, principal plus swap proceeds, into native ETH.
    const wethBal: bigint = await wethC.balanceOf(w.address).catch(() => 0n);

    // The position's proceeds are the WETH that ACCUMULATED during this close, measured
    // BEFORE the unwrap.
    // Two mistakes used to live here, both making the PnL card lie:
    //  - using the whole wallet balance rather than the increase, so WETH left over from
    //    another operation (the 0.12 that was once stranded) counted as this position's gain;
    //  - computing from the unwrap's result, so a FAILED unwrap recorded a result of 0 and
    //    the journal reported -100% while the money was intact, merely still in WETH form.
    // Unwrapping is about form (WETH against ETH), not about value.
    const gainedWeth = wethBal > baseBefore ? wethBal - baseBefore : 0n;
    if (wethBal > gainedWeth) {
      notes.push(
        `Note: ${msg.fmtEth(wethBal - gainedWeth)} WETH was already in the wallet before this close — ` +
          `unwrapped too, but not counted as this position's result.`,
      );
    }

    if (wethBal > 0n) {
      try {
        const tx = await wethC.withdraw(wethBal);
        const rc = await tx.wait();
        if (rc) txHashes.push(rc.hash);
        notes.push(`Unwrap ${msg.fmtEth(wethBal)} WETH → ETH`);
      } catch (e) {
        // Do not trust an exception about what landed on chain. On 2 Aug 2026 an "Unwrap
        // failed" message appeared for a transaction that SUCCEEDED (block 25593905, status
        // 1) — most likely a failed wait()/RPC rather than the transaction. That reads wrong
        // twice over: the user is told to /unwrap when there is nothing to unwrap.
        const after: bigint = await wethC.balanceOf(w.address).catch(() => wethBal);
        if (after < wethBal) {
          notes.push(`Unwrap ${msg.fmtEth(wethBal - after)} WETH → ETH (confirmed by balance)`);
        } else {
          console.error(`[unwrap] failed during close #${tokenId}: ${(e as Error).message.slice(0, 160)}`);
          notes.push('Unwrap failed — the WETH stays in your wallet (use /unwrap). Your result is unaffected.');
        }
      }
    }
    baseOutWei = gainedWeth + sw.baseOut;
  } else {
    // (2) USDG stays a stablecoin (never unwrapped). The net total is the balance increase.
    const baseAfter: bigint = await baseC.balanceOf(w.address).catch(() => baseBefore);
    baseOutWei = baseAfter > baseBefore ? baseAfter - baseBefore : sw.baseOut;
    notes.push(`Received ${ethers.formatUnits(baseOutWei, base.decimals)} ${base.symbol} (kept as stablecoin)`);
  }

  if (sw.leftover) {
    notes.push('⚠️ Some tokens are left over — the monitor will retry automatically.');
  }

  // The unit follows the CHAIN rather than a hardcoded 'ETH': a close on BSC receives BNB
  // and on HyperEVM receives HYPE. The "Received" line is the most trusted number on this
  // card — a wrong unit means misreading the whole trade's result.
  const ethOut = base.wrappable
    ? `${msg.fmtEth(baseOutWei)} ${cc.nativeSymbol}`
    : `${ethers.formatUnits(baseOutWei, base.decimals)} ${base.symbol}`;
  console.log(`[cashout] #${tokenId}:`, notes.join(' | ')); // rekam ke journal
  const text = msg.msgCashOut({
    tokenId,
    pair: (() => {
      const bs = base.wrappable ? cc.nativeSymbol : base.symbol;
      return `$${msg.posPair(`${bs} / ${store.get(tokenId)?.symbol ?? 'token'}`, bs)}`;
    })(),
    protocol: 'V3',
    notes,
    ethOut,
    txHashes,
    baseSymbol: base.wrappable ? cc.nativeSymbol : base.symbol,
    native: base.wrappable,
    leftover: sw.leftover,
  });
  // leftover means tokens genuinely still sitting in the wallet after every attempt.
  return { text, baseOutWei, leftover: sw.leftover, leftoverWei: sw.leftoverWei, feesBaseWei };
}

// ── Close a Uniswap v4 position (read-only for viewing; closing is supported) ──
// Refresh a single v4 card (replacing the removed ➕ button).
/**
 * The chain a v4 tokenId actually lives on.
 *
 * v4 ids are per-chain, so reaching for getChain() means asking the DEFAULT chain about
 * someone else's id — Robinhood's PositionManager answers NOT_MINTED for a BSC position
 * and the close reports a revert for a position that was never touched. The local record
 * answers instantly; an untracked position is found by asking each v4 chain who owns it.
 */
async function v4ChainOf(tokenId: string): Promise<ReturnType<typeof getChain> | undefined> {
  const tracked = v4store.getV4(tokenId);
  if (tracked?.chain && CHAINS[tracked.chain]) return getChain(tracked.chain);
  for (const c of Object.values(CHAINS).filter((x) => v4Supported(x))) {
    const owner = await v4OwnerOf(c, tokenId).catch(() => null);
    if (owner && owner.toLowerCase() === c.wallet.address.toLowerCase()) return c;
  }
  return undefined;
}

bot.action(/^posv4:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cc = (await v4ChainOf(ctx.match[1])) ?? getChain();
  try {
    const list = await listPositionsV4(cc);
    const p = list.find((x) => x.tokenId === ctx.match[1]);
    if (!p) return ctx.editMessageText(msg.msgAlreadyClosed(ctx.match[1]), html);
    const c = await buildV4Card(p, await getEthUsd(cc.wethAddress, cc).catch(() => null), cc);
    await ctx.editMessageText(c.text, c.extra);
  } catch (e) {
    if (!/not modified/i.test((e as Error).message)) {
      await ctx.reply(msg.msgError('v4 position', (e as Error).message), html);
    }
  }
});

bot.action(/^closev4:(\d+)$/, async (ctx) => {
  const tokenId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(msg.msgV4CloseConfirm(tokenId), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⛔ Close v4 Position', `closev4go:${tokenId}`)], // a money action, so it gets its own row
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

/** Close ONE v4 position. Registered as the Close button, and reused by Close All. */
async function execCloseV4(ctx: any) {
  const tokenId = ctx.match[1];
  // A v4 ladder closes the WHOLE group in one batched transaction (BURN x N + TAKE_PAIR).
  const trk = v4store.getV4(tokenId);
  if (trk?.groupId) {
    const legs = v4store.groupV4(trk.groupId);
    if (legs.length > 1) return closeGroupV4(ctx, trk.groupId, legs);
  }
  const key = `v4:${tokenId}`;
  if (closeLocked(key)) return ctx.answerCbQuery('Processing…');
  closingInFlight.set(key, Date.now());
  // The POSITION's chain, never the default one. With getChain() a BSC position was
  // closed against Robinhood's PositionManager, which answers NOT_MINTED — reported as a
  // failed close for a position that had not been touched at all.
  const cc = (await v4ChainOf(tokenId)) ?? getChain();
  const tracked = v4store.getV4(tokenId); // captured BEFORE removeV4
  // The base is read from the poolKey BEFORE the close (after the burn, pool info is gone).
  const trackedBase = await getPoolKeyV4(cc, tokenId)
    .then((x) => v4Kind(cc, x.base))
    .catch(() => 'weth' as const);
  // The close's result is measured from the position's BASE balance delta. An ETH base uses
  // the native balance; a USDG base uses the USDG token balance. `afterWei` used to be
  // forced to null for anything non-ETH, so EVERY USDG-paired v4 close was recorded with no
  // result: missing from /pnl and never producing a profit card. The best pools are often
  // the USDG ones.
  const readBase = async (): Promise<bigint | null> => {
    if (trackedBase === 'usdg') {
      if (!cc.usdgAddress) return null;
      return (await new ethers.Contract(cc.usdgAddress, ERC20_ABI, cc.provider)
        .balanceOf(cc.wallet.address)
        .catch(() => null)) as bigint | null;
    }
    return cc.provider.getBalance(cc.wallet.address).catch(() => null);
  };
  const beforeWei = await readBase();
  // Same reason as the v3 path: v4 fees only exist while the position is alive.
  const feesBaseWei = await checkV4Status(cc, tokenId)
    .then((st) => st.val?.feesBaseWei)
    .catch(() => undefined);
  // The v4 profit card needs a measured result plus the cost basis. It is filled in by the
  // journal branch below (the only place both are known) and sent after the text card.
  let cardRec: store.PosRecord | undefined;
  let cardOutWei: bigint | undefined;
  // A v4 cash-out can only be measured from the balance delta (closePositionV4 does not
  // return it), and it feeds the "Received" line on the close card.
  let measuredOut: bigint | undefined;
  store.beginMoneyOp();
  try {
    await ctx.answerCbQuery('Processing…');
    await ctx.editMessageText(msg.msgProgress('closing v4 position…'), html).catch(() => {});
    // The probe is the v4 position's liquidity: a drop means part of the close landed, so do not retry.
    const r = await retryOnce(
      'close v4',
      () => v4Liquidity(cc, tokenId),
      () => closePositionV4(tokenId, cc, { dryRun: config.safety.dryRun }),
      { onRetry: async () => void (await ctx.editMessageText(msg.msgProgress('first attempt failed — retrying…'), html)) },
    );
    if (!r.dryRun) {
      // Journal before we stop tracking it — without this /history and /pnl are blind to v4,
      // and leftover v4 tokens never become sweep candidates (the ca lives only in the journal).
      if (r.base === 'ETH' || r.base === 'USDG') {
        const afterWei = await readBase();
        // ponytail: the ETH proceeds are the native balance delta, gas included, which keeps PnL conservative.
        // A precise ledger only becomes worthwhile if v4 turns into the main path.
        // The base measured must MATCH the close's base; otherwise the delta belongs to
        // another asset, and "unmeasured" beats a wrong number.
        const sameBase = trackedBase === v4Kind(cc, r.base);
        const measured =
          sameBase && beforeWei !== null && afterWei !== null && afterWei > beforeWei
            ? afterWei - beforeWei
            : undefined;
        const rec = {
          tokenId,
          symbol: `${r.sym0}/${r.sym1}`,
          ca: r.other,
          chain: cc.key,
          baseKind: v4Kind(cc, r.base),
          openedAt: tracked?.openedAt ?? Date.now(),
          initialWethWei: tracked?.entryBaseWei ?? '0',
        };
        measuredOut = measured;
        journal.recordClose(rec, { resultEthWei: measured, reason: 'cashed' });
        // The card only means anything when both cost and result are measured; an untracked
        // v4 position (entry 0) would give a misleading PnL of +infinity.
        if (measured !== undefined && tracked?.entryBaseWei) {
          cardRec = rec as store.PosRecord;
          cardOutWei = measured;
        }
      }
      // A v4 base outside ETH/USDG has no balance reader, so its result is unmeasurable.
      // It is still JOURNALLED without a result ('untracked') — without this the position is
      // deleted from v4store and vanishes entirely from /pnl and /history, without a trace.
      else if (tracked) {
        journal.recordClose(
          {
            tokenId,
            symbol: `${r.sym0}/${r.sym1}`,
            ca: r.other,
            chain: cc.key,
            baseKind: v4Kind(cc, r.base),
            openedAt: tracked.openedAt,
            initialWethWei: tracked.entryBaseWei ?? '0',
          },
          { reason: 'cashed' },
        );
      }
      v4store.removeV4(tokenId); // stop tracking it once closed
      invalidateV4ListCache();
    }
    if (r.dryRun) {
      await ctx.reply(msg.msgV4Closed({ tokenId, base: r.base, dryRun: true }), html);
    } else {
      // One card for every close, v3 and v4 alike. v4 used to use a compact card with no
      // steps and no hashes — the same outcome with far less of a trail, and a different
      // look for the same event.
      const dec4 = v4BaseDecimals(cc, r.base);
      const sym4 = v4BaseSymbol(cc, r.base);
      const otherSym4 = r.other ? await v4TokenSymbol(r.other, cc).catch(() => 'token') : 'token';
      // Unmeasured means inventing nothing: '—' is honest, while '0' reads as a total loss.
      const outLabel4 = measuredOut === undefined ? '—' : `${msg.cleanUnits(measuredOut, dec4)} ${sym4}`;
      await ctx.reply(
        msg.msgCashOut({
          tokenId,
          pair: `$${msg.posPair(`${sym4} / ${otherSym4}`, sym4)}`,
          protocol: 'V4',
          notes: [
            `Close v4 position #${tokenId}`,
            ...(r.cashedOut ? [`Swap: token → ${r.cashedOut}`] : []),
          ],
          ethOut: outLabel4,
          txHashes: r.txHash ? [r.txHash] : [],
          baseSymbol: sym4,
          native: r.base === 'ETH',
          leftover: !!r.leftover,
        }),
        html,
      );
    }
    if (r.unprotected) await ctx.reply(msg.esc(V4_UNPROTECTED_NOTE(tokenId)), html);
    if (cardOutWei !== undefined) {
      await sendProfitCard(ctx, tokenId, cardRec, cardOutWei, feesBaseWei, tracked?.shape).catch((e) =>
        console.log('[profit-card] v4 failed:', (e as Error).message.slice(0, 120)),
      );
    } else if (!r.dryRun) {
      // The card needs cost AND result both measured. A v4 position the bot never recorded
      // (opened elsewhere), or an unreadable balance delta, would produce a made-up figure —
      // so say why rather than staying silent.
      await ctx.reply(msg.note('Result could not be measured, so no PnL card for this close.'), html);
    }
  } catch (e) {
    await recoverStrayWeth(cc, 'close v4').catch(() => {});
    await ctx.reply(msg.msgError('close v4', e), html);
  } finally {
    closingInFlight.delete(key);
    store.endMoneyOp();
  }
}

bot.action(/^closev4go:(\d+)$/, execCloseV4);

// Cancel applies to every flow (the /add wizard and close confirmations alike).
bot.action('cancel', async (ctx) => {
  resetFlows(ctx.from!.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText(msg.msgCancelled(), html);
});

// The catch-all for typed amounts (registered LAST so it never swallows a command).
// Button CRUD used to need a state Map and 5 handlers; one typed line covers it, and
// menutup bug "ketikanku ditelan editor preset".

// A wallet secret mistakenly pasted into the chat. Checked FIRST, before any flow's
// handler, so the key never passes through a flow or a log. The message is also
// deleted — telling the user to delete it themselves leaves the key sitting in the chat
// until they get round to it. Detection: a 64-character hex private key, or a 12/24-word
// BIP-39 phrase.
// A seed is validated with the real BIP-39 validator (checksum plus wordlist), NOT a
// "12 lowercase words" pattern: an ordinary 12-word sentence would match that pattern and
// an innocent user's message would be deleted with it.
const PRIVKEY_RE = /^(0x)?[a-fA-F0-9]{64}$/;
function looksLikeSecret(t: string): boolean {
  const one = t.replace(/\s+/g, ' ').trim();
  if (PRIVKEY_RE.test(one.replace(/\s/g, ''))) return true;
  const n = one.split(' ').length;
  if (n !== 12 && n !== 15 && n !== 18 && n !== 21 && n !== 24) return false;
  try {
    return ethers.Mnemonic.isValidMnemonic(one.toLowerCase());
  } catch {
    return false;
  }
}

bot.on(message('text'), async (ctx) => {
  const raw = (ctx.message.text || '').trim();

  // A /connect flow that is waiting: a key here is exactly what was asked for.
  // But ONLY something genuinely shaped like a key. An abandoned connect prompt used to
  // swallow whatever was typed next — a pasted CA got DELETED from the chat and answered
  // with "import failed", because this branch is checked first and never let go. Not a key
  // means the user has moved on: release the prompt and let the right flow handle it.
  if (awaitingSecret.has(ctx.from.id)) {
    if (looksLikeSecret(raw)) return handleSecret(ctx, raw);
    awaitingSecret.delete(ctx.from.id);
  }

  // Item 19 — a wallet secret outside the /connect flow: ignore it, delete it, warn.
  if (looksLikeSecret(raw)) {
    await ctx.deleteMessage().catch(() => {}); // butuh hak admin di grup; di chat pribadi selalu boleh
    return ctx.reply(msg.msgSecretLeakWarning(), html);
  }

  // /bridge waiting on an amount — checked first because its state is separate.
  if (await handleBridgeAmount(ctx, raw)) return;

  // /buy and /sell: wait for a contract address, then an amount, then quote the best route, then confirm.
  const tflow = tswapFlows.get(ctx.from.id);
  if (tflow && (tflow.awaitingCA || tflow.awaitingToken || tflow.awaitingAmount) && isStaleFlow(tflow.startedAt)) {
    tswapFlows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  // An answer to the percentage prompt in /settings is checked first: "25 50 75" must be
  // saved as a setting, not read as an amount by whichever flow happens to be open.
  if (await handlePctReply(ctx, raw)) return;
  // /send: an address, then an amount. Checked before the other amount flows so a number
  // typed here is not swallowed by an /add or /buy wizard still open.
  if (await handleSendAddress(ctx, raw)) return;
  if (await handleSendAmount(ctx, raw)) return;
  if (tflow?.awaitingCA) {
    // /buy, CA-first: the user pastes a CA, the chain is detected, then safety.
    tflow.awaitingCA = false;
    const prog = await ctx.reply(msg.msgProgress('detecting chain…'), html);
    return buyStartFromCA(ctx, raw.trim(), { message_id: prog.message_id });
  }
  if (tflow?.awaitingAmount && tflow.sellList) {
    // /sell, holdings flow: the user types a token amount (absolute) or "all".
    const bal = tflow.tokenBalWei ?? 0n;
    let amountWei: bigint;
    if (/^(all|max)$/i.test(raw)) {
      amountWei = bal;
    } else {
      const w = parseAmt(raw, tflow.tokenDec!);
      if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
      amountWei = w;
    }
    if (amountWei <= 0n || amountWei > bal) {
      return ctx.reply(msg.msgError('sell', `Amount exceeds your balance (${fmt4(tflow.tokenBalNum ?? 0)} ${tflow.tokenSym}).`), html);
    }
    const amtLabel = `${fmt4(Number(ethers.formatUnits(amountWei, tflow.tokenDec!)))} ${tflow.tokenSym}`;
    return sellPreview(ctx, tflow, amountWei, amtLabel);
  }
  if (tflow?.awaitingAmount) {
    const cc = CHAINS[tflow.chainKey]!;
    const base = tflow.base!;
    try {
      let amountWei: bigint;
      let amountInLabel: string;
      let fromAddr: string;
      let toAddr: string;
      if (tflow.buy) {
        const w = parseAmt(raw, base.decimals);
        if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
        amountWei = w;
        // A wrappable base is funded from native (ETH/BNB), so that is what the card names.
        amountInLabel = `${raw} ${base.wrappable ? cc.nativeSymbol : base.symbol}`;
        fromAddr = base.address;
        toAddr = tflow.token!;
      } else {
        const tc = new ethers.Contract(tflow.token!, ['function balanceOf(address) view returns (uint256)'], cc.provider);
        const balTok: bigint = await tc.balanceOf(cc.wallet.address);
        if (/^(all|max)$/i.test(raw)) {
          amountWei = balTok;
        } else {
          const w = parseAmt(raw, tflow.tokenDec!);
          if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
          amountWei = w;
        }
        if (amountWei <= 0n || amountWei > balTok) {
          return ctx.reply(msg.msgError('swap', `Not enough token balance (you have ${ethers.formatUnits(balTok, tflow.tokenDec!)}).`), html);
        }
        amountInLabel = `${Number(ethers.formatUnits(amountWei, tflow.tokenDec!)).toLocaleString('id-ID', { maximumFractionDigits: 4 })} ${tflow.tokenSym}`;
        fromAddr = tflow.token!;
        toAddr = base.address;
      }
      return tswapQuoteConfirm(ctx, tflow, cc, fromAddr, toAddr, amountWei, amountInLabel);
    } catch (e) {
      tswapFlows.delete(ctx.from.id);
      return ctx.reply(msg.msgError('swap', e), html);
    }
  }

  // The /add wizard is waiting for a typed amount.
  const flow = getFlow(ctx);
  if (flow?.awaitingAmount && isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    return ctx.reply(msg.msgSessionExpired(), html);
  }
  if (flow?.awaitingAmount && flow.strategy !== undefined) {
    const a = amountCtx(flow);
    const dec =
      flow.strategy === 'token'
        ? (flow.tokenDec ?? 18)
        : baseOf(getChain(flow.chain), flow.base ?? 'weth').decimals;
    const w = parseAmt(raw, dec);
    if (w === null) return ctx.reply(msg.msgInvalidAmount(), html);
    const num = Number(ethers.formatUnits(w, dec));
    // The ceiling is the CAPITAL ACTUALLY HELD, not a policy number. usableFor() already
    // handles both sides: the token side is the token balance, and a wrappable base side is
    // the native balance minus the gas reserve (spend it all and the tx itself goes unpaid).
    // Only the token side used to be balance-guarded; the base side leaned on the per-tx
    // limit, so the moment that limit was switched off nothing held it back at all.
    // A failed read falls back to amountCtx's limit rather than blocking over a flaky RPC.
    let cap = a.cap;
    let capLabel = a.capLabel;
    const balWei = await usableFor(flow).catch(() => null);
    if (balWei !== null) {
      const sym = flow.strategy === 'token' ? a.symbol : wizardBase(flow).wrappable ? wizardCtx(flow).nativeSymbol : a.symbol;
      cap = Number(ethers.formatUnits(balWei, dec));
      capLabel = `${cap.toLocaleString('id-ID', { maximumFractionDigits: 6 })} ${sym}`;
    }
    if (num > cap) return ctx.reply(msg.msgOverLimit(capLabel), html);
    flow.awaitingAmount = false;
    flow.ethAmount = ethers.formatUnits(w, dec); // already normalised, with the extra decimals trimmed
    await planThenOpen(ctx, flow);
    return;
  }

  // A bare CA (no command) goes to the TOKEN HUB. Checked AFTER every flow waiting on input,
  // so pasting a CA mid-wizard does not hijack it.
  // (the cast is needed because isAddress is a type guard: without it TS narrows `raw` to never below)
  const isCa = ethers.isAddress(raw) as boolean;
  if (isCa) return startTokenHub(ctx, ethers.getAddress(raw));

  // Not a command (commands are handled elsewhere), so it is unknown.
  // Ignore empty strings and bare numbers with no context.
  if (!raw || raw.startsWith('/')) {
    // An unrecognised command (telegraf did not match): /foo
    if (raw.startsWith('/')) {
      const cmd = raw.split(/\s+/)[0];
      return ctx.reply(msg.msgUnknown(cmd), html);
    }
    return;
  }
  return ctx.reply(msg.msgUnknown(raw), html);
});

bot.catch((err, ctx) => {
  // The button spins until it times out if an error occurs before answerCbQuery.
  if (ctx.callbackQuery) ctx.answerCbQuery('Failed — see the message.').catch(() => {});
  console.error('Bot error:', err);
  ctx.reply?.(msg.msgError('bot', (err as Error).message), html).catch(() => {});
});

/**
 * The Telegram command menu, behind the "/" and Menu buttons.
 * ITS CONTENTS MUST equal every registered bot.command() — verified at boot by
 * assertMenuComplete() below, so a new command can never again be live
 * silently without appearing in the menu.
 */
const BOT_COMMANDS = [
  // Start and help
  { command: 'start', description: 'Welcome card & bot status' },
  { command: 'help', description: 'Menu, bot mode & command list' },
  // Monitoring
  { command: 'portfolio', description: 'Portfolio, balances & network' },
  { command: 'positions', description: 'Active LP positions (live)' },
  { command: 'pnl', description: 'Lifetime PnL summary' },
  // Research
  // LP
  { command: 'claim_fees', description: 'Collect fees without closing' },
  // Trade & move funds
  { command: 'swap', description: 'Swap a token you hold (best route)' },
  { command: 'bridge', description: 'Move funds across chains' },
  { command: 'withdraw', description: 'Withdraw funds to another address' },
  // Wallet and settings
  { command: 'gas', description: 'Current gas cost per chain (USD & IDR)' },
  { command: 'settings', description: 'Wallet & transaction preferences' },
  { command: 'alerts', description: 'Notification settings' },
] as const;

/** The menu against the registered commands. Any difference is logged, never fatal. */
/**
 * Aliases DELIBERATELY kept out of the menu. The menu guard stays strict for everything
 * else — this list simply stops an intentional alias reading as a forgotten registration.
 */
// Hidden aliases: /status is the old name for /portfolio, /sell for /swap and /send for
// /withdraw; /add_lp is still the only door
// to the top-pool picker (with no CA), so its handler stays alive.
//
// /stop, /buy and /unwrap are hidden on purpose too: the menu mirrors the /start grid,
// and none of them has a button there. Closing belongs to the position it closes in
// /positions, buying starts from a pasted CA, and stray wrapped native is unwrapped by
// the monitor every minute. All three still work when typed.
const HIDDEN_COMMANDS = new Set(['status', 'add_lp', 'stop', 'buy', 'unwrap', 'sell', 'send']);

function assertMenuComplete(): void {
  const inMenu = new Set(BOT_COMMANDS.map((c) => c.command));
  const missing = [...registeredCommands].filter((c) => !inMenu.has(c as never) && !HIDDEN_COMMANDS.has(c));
  const stale = [...inMenu].filter((c) => !registeredCommands.has(c));
  if (missing.length) console.error('[menu] live commands missing from the menu:', missing.join(', '));
  if (stale.length) console.error('[menu] in the menu but not registered:', stale.join(', '));
  if (!missing.length && !stale.length) console.log(`[menu] ${inMenu.size} commands, menu and handlers agree`);
}

/**
 * Install the command menu in the scope private chats use.
 *
 * - language_code id/en (ID/EN clients sometimes do not fall back to the default)
 * - setChatMenuButton -> commands (not an empty web app)
 */
async function registerBotCommands() {
  const scopes: Array<Record<string, unknown>> = [
    { type: 'default' },
    { type: 'all_private_chats' },
    { type: 'chat', chat_id: config.telegram.allowedUserId },
  ];
  assertMenuComplete();
  const cmds = [...BOT_COMMANDS];

  // The deleteMyCommands loop used to send 9 pointless calls (the scope is set again a few
  // lines below) and used language_code 'in', which is not a valid code.
  for (const scope of scopes) {
    try {
      await bot.telegram.setMyCommands(cmds, { scope: scope as any });
    } catch (e) {
      console.error('[setMyCommands]', scope.type, (e as Error).message);
    }
    for (const lang of ['id', 'en']) {
      try {
        await bot.telegram.setMyCommands(cmds, {
          scope: scope as any,
          language_code: lang,
        });
      } catch (e) {
        console.error('[setMyCommands]', scope.type, lang, (e as Error).message);
      }
    }
  }

  try {
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
  } catch (e) {
    console.error('[setChatMenuButton] default', (e as Error).message);
  }
  try {
    await bot.telegram.setChatMenuButton({
      chatId: config.telegram.allowedUserId,
      menuButton: { type: 'commands' },
    });
  } catch (e) {
    console.error('[setChatMenuButton] chat', (e as Error).message);
  }

  try {
    const list = await bot.telegram.getMyCommands();
    console.log(
      'Menu commands:',
      list.map((c) => c.command).join(', ') || '(empty!)',
    );
  } catch (e) {
    console.error('[getMyCommands]', (e as Error).message);
  }
}

// --- Start up ---
// A failed launch() (a 409 conflict during an overlapping deploy, or the network) RETRIES
// with backoff rather than exiting. A 409 means the old instance is still polling; wait for it.
// Give up after maxTries with exit(1), and let systemd restart.
function launchWithRetry(attempt = 1, maxTries = 6) {
  // onLaunch fires when polling STARTS. Its promise only settles when the bot STOPS
  // (Telegraf v4) — "online" and the menu installation used to hang there, so the "/" menu
  // was only sent as the process died and was always one version behind.
  bot
    .launch(() => {
      console.log(
        'PHILIPS online | wallet:',
        walletStore.address() ?? '(not connected)',
        '| mode:',
        msg.modeLabel(config.safety.dryRun),
      );
      // Without WALLET_SECRET the keystore is locked with the bot token. Changing or revoking that token
      // in BotFather means the key can never be opened again, and the bot just sits there
      // saying "connect your wallet". Warn once per boot rather than staying silent.
      if (!process.env.WALLET_SECRET) {
        console.warn(
          '[wallet] WARNING: WALLET_SECRET is not set — the keystore is encrypted with the bot token. ' +
            'Rotating the token will make the stored key permanently unreadable. ' +
            'To fix: set WALLET_SECRET, restart, then reconnect the wallet via /settings.',
        );
      }
      registerBotCommands().catch((e) => console.error('[menu]', (e as Error).message));
    })
    .then(
      () => console.log('PHILIPS stopped'),
      (err) => {
        const code = (err as any)?.response?.error_code;
        const text = String((err as Error)?.message ?? err);
        const is409 = code === 409 || /409|conflict|terminated by other getUpdates/i.test(text);

        // A wrong token will NOT heal by waiting. Telegram answers 401 (revoked) or 404 on
        // getMe (unknown) — retrying six times and then exiting has systemd repeat it forever,
        // with a "404: Not Found" message that names no cause at all. Stop, and say plainly what
        // happened.
        const badToken = code === 401 || (code === 404 && /getMe/i.test(JSON.stringify((err as any)?.on ?? '')));
        if (badToken) {
          console.error(
            'TELEGRAM_BOT_TOKEN is not valid — Telegram does not recognise it.\n' +
              '  Open @BotFather, send /mybots, pick your bot, then "API Token".\n' +
              '  Copy the whole line (it looks like 1234567890:AA...) into .env and restart.',
          );
          process.exit(EXIT_CONFIG);
          return;
        }

        console.error(
          `Launch failed (attempt ${attempt}/${maxTries})${is409 ? ' [409 — another instance is still polling]' : ''}:`,
          text.slice(0, 200),
        );
        if (attempt >= maxTries) {
          console.error('Giving up. Check the network, the RPC, and TELEGRAM_BOT_TOKEN.');
          process.exit(1);
          return;
        }
        setTimeout(() => launchWithRetry(attempt + 1, maxTries), is409 ? 5000 : 2000);
      },
    );
}
launchWithRetry();
startMonitor(bot); // the auto-monitor for active positions

// --- Liveness watchdog: telegraf long-polling can STALL silently (a wedged getUpdates, a
// 502 from the bot DC) — the process stays "alive" while the bot goes mute for hours: no
// drop or IL alerts, no command responses. systemd does not restart it, because nothing crashed.
// A periodic getMe() probe: consecutive failures mean polling is dead, so exit(1) and let systemd restart
// (which starts a fresh long poll — the same cure that recovered the 7-hour incident). getMe
// goes through the same DC as getUpdates, so it fails too when polling stalls.
function startWatchdog() {
  const EVERY_MS = 3 * 60_000;
  const TIMEOUT_MS = 10_000;
  const MAX_FAILS = 4; // about 12 minutes unreachable triggers a restart
  let fails = 0;
  setInterval(async () => {
    try {
      await Promise.race([
        bot.telegram.getMe(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getMe timeout')), TIMEOUT_MS)),
      ]);
      fails = 0;
    } catch (e) {
      fails++;
      console.error(`[watchdog] getMe failed ${fails}/${MAX_FAILS}: ${(e as Error).message.slice(0, 80)}`);
      if (fails >= MAX_FAILS) {
        console.error('[watchdog] Telegram is unreachable, restarting through systemd.');
        await notifyCrash('watchdog', 'long-poll ngadat — restart otomatis').catch(() => {});
        setTimeout(() => process.exit(1), 2000).unref();
      }
    }
  }, EVERY_MS).unref();
}
startWatchdog();

// --- Auto-recovery: an unhandled error logs, notifies, and restarts via systemd ---
async function notifyCrash(kind: string, err: unknown) {
  try {
    await bot.telegram.sendMessage(
      config.telegram.allowedUserId,
      msg.msgCrash(kind, String((err as Error)?.message ?? err)),
      html,
    );
  } catch {
    /* ignored */
  }
}
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  // The exit is SCHEDULED FIRST, then the notification. The most common crash cause in this
  // bot is a network or Telegram problem — exactly the situation where sendMessage hangs too.
  // If the exit waited on the notification, the process would stay alive in a post-crash
  // state: the monitor still signing transactions, and systemd never restarting it.
  setTimeout(() => process.exit(1), 3000).unref(); // systemd's Restart=always brings it back
  notifyCrash('uncaughtException', err).finally(() => process.exit(1));
});
process.on('unhandledRejection', (err) => {
  // Do not kill the process over a loose rejection — logging is enough (safe for polling).
  console.error('unhandledRejection:', err);
});

// Clean shutdown: stop polling, then EXIT (it used to hang until SIGKILL).
const shutdown = (sig: string) => {
  try {
    bot.stop(sig);
  } catch {
    /* ignored */
  }
  setTimeout(() => process.exit(0), 1500).unref();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
