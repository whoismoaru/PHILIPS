import { Telegraf, Markup } from 'telegraf';
import { rpcUrl as solRpcUrl } from './solana/rpc.js';
import { withGasScope } from './gasBudget.js';
import { ethers } from 'ethers';
import { config } from './config.js';
import * as walletStore from './walletStore.js';
import * as solWallet from './solana/walletStore.js';
import * as store from './store.js';
import * as msg from './messages.js';
import { CHAINS, getChain } from './chains.js';

/**
 * The shared floor every command module stands on: the bot instance, the HTML parse
 * options, and the small helpers used all over the place.
 *
 * This module must NOT import a command module. Imports always run commands/* -> core and
 * never the other way, which is what keeps the split of index.ts free of import cycles.
 */

export const bot = new Telegraf(config.telegram.botToken);
// Registered here, before any module adds a handler: telegraf runs middleware in order, so
// a scope opened later would not cover commands registered by earlier imports. Every tx one
// update sends is measured against the value that update moves (see gasBudget.ts).
// --- Guard: only the owner may use the bot ---
// FIRST, here in core.ts: ES imports run before index.ts's body, so every command and button
// registered in commands/*.ts used to sit AHEAD of this guard -- a stranger could open
// /settings and tap its buttons.
bot.use((ctx, next) => {
  // Ignore silently: replying to a stranger confirms this bot exists and can be made
  // to answer. Groups are refused too (a balance card would be readable by everyone).
  if (ctx.from?.id !== config.telegram.allowedUserId || (ctx.chat && ctx.chat.type !== 'private')) {
    console.log(`[guard] ignored an update from id ${ctx.from?.id} (chat ${ctx.chat?.type}); TELEGRAM_ALLOWED_USER_ID is ${config.telegram.allowedUserId}`);
    return;
  }
  return next();
});
bot.use((_ctx, next) => withGasScope(() => next()));

/**
 * The ownership mark at the foot of EVERY message.
 *
 * Applied at the TELEGRAM layer rather than in ~90 message functions or in ctx middleware:
 * ctx.reply, the monitor's cards (which call bot.telegram.sendMessage directly) and the
 * watchdog all funnel through here. One place means a new message gets it without anyone
 * remembering to add it, and no path is missed.
 */
const SIGNATURE = '<i>Powered by Moaru</i>';
const TG_TEXT_MAX = 4096;
const TG_CAPTION_MAX = 1024;

function sign(text: unknown, max: number): unknown {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (text.includes('Powered by Moaru')) return text; // repeated edits must not stack it up
  const tail = `\n\n${SIGNATURE}`;
  // Telegram rejects an over-long message outright, so losing the signature is better
  // than losing the message.
  return text.length + tail.length > max ? text : text + tail;
}

{
  const tg = bot.telegram as unknown as Record<string, (...a: any[]) => unknown>;
  const wrapText = (name: string, argIndex: number, max: number) => {
    const orig = tg[name]?.bind(tg);
    if (!orig) return;
    tg[name] = (...args: any[]) => {
      args[argIndex] = sign(args[argIndex], max);
      return orig(...args);
    };
  };
  wrapText('sendMessage', 1, TG_TEXT_MAX);
  wrapText('editMessageText', 3, TG_TEXT_MAX);
  // A document, the PnL card, carries its text in the caption.
  for (const [name, i] of [['sendDocument', 2], ['sendPhoto', 2]] as const) {
    const orig = tg[name]?.bind(tg);
    if (!orig) continue;
    tg[name] = (...args: any[]) => {
      const extra = args[i];
      if (extra?.caption) args[i] = { ...extra, caption: sign(extra.caption, TG_CAPTION_MAX) };
      return orig(...args);
    };
  }
  const editMedia = tg.editMessageMedia?.bind(tg);
  if (editMedia) {
    tg.editMessageMedia = (...args: any[]) => {
      const m = args[3];
      if (m?.caption) args[3] = { ...m, caption: sign(m.caption, TG_CAPTION_MAX) };
      return editMedia(...args);
    };
  }
}

/**
 * The name of every command actually registered. Telegraf keeps no such list, and without
 * one there is no way to check the Telegram menu is complete -- and a command that is alive
 * but missing from the menu is effectively invisible. bot.start() is added by hand: it is
 * not a bot.command().
 */
export const registeredCommands = new Set<string>(['start']);
const originalCommand = bot.command.bind(bot);
(bot as any).command = (cmd: unknown, ...rest: unknown[]) => {
  for (const c of Array.isArray(cmd) ? cmd : [cmd]) {
    if (typeof c === 'string') registeredCommands.add(c);
  }
  return (originalCommand as any)(cmd, ...rest);
};

export const html = { parse_mode: 'HTML' as const };

/**
 * The per-transaction limit. Turning it off has to be DELIBERATE, never a side effect.
 *
 * An empty `.env` falls back to a sensible default. Empty used to mean unlimited, and
 * silently so: one mistyped line opened the whole wallet with nothing holding it back. To
 * really remove the limit, write `off` (or `0`) explicitly; anything else is read as a number.
 */
const DEFAULT_MAX_ETH = 0.1;
const DEFAULT_MAX_STABLE = 250;

const parseCap = (raw: string, fallback: number): number => {
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === '0') return Infinity;
  const n = Number(v);
  return n > 0 ? n : fallback;
};

export const maxEth = parseCap(config.safety.maxEthPerTx, DEFAULT_MAX_ETH);
export const maxStable = parseCap(config.safety.maxStablePerTx, DEFAULT_MAX_STABLE);

/** The limit, labelled in the right asset for the chain (ETH on Robinhood, BNB on BSC). */
export const capLabelFor = (cap: number, sym: string) => (cap === Infinity ? 'unlimited' : `${cap} ${sym}`);
export const maxEthLabel = capLabelFor(maxEth, 'ETH');

/** The position was burned, or never existed on chain: its NFT is gone. */
/**
 * The position is GONE -- already burned, or never minted.
 *
 * v3 says 'invalid token id'; v4's PositionManager says 'NOT_MINTED'. Only v3's wording
 * was matched here, so closing a v4 position that had already been closed produced a
 * TRANSACTION ERROR card instead of "already closed" -- and because the revert is
 * deterministic, the retry fired and sent a second card. Seven ladder legs made fourteen
 * error messages for a position that was simply no longer there.
 */
export const isGoneErr = (e: unknown) =>
  /invalid token id|NOT_MINTED|nonexistent token|ERC721: owner query for nonexistent/i.test(
    String((e as Error)?.message ?? e),
  );

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a transaction, recovering from a NONCE collision. Back-to-back writes (a Permit2
 * approve then modifyLiquidities, or a swap route that failed and is being retried) can
 * reuse the same nonce when the RPC's "pending" count lags behind, and the whole step dies
 * with "nonce has already been used". On a nonce error, read a FRESH nonce from the chain
 * and retry -- rather than a NonceManager, which drifts ahead whenever a transaction fails.
 */
export async function sendTxNonceSafe(
  wallet: ethers.Wallet,
  txReq: ethers.TransactionRequest,
): Promise<ethers.TransactionResponse> {
  let nonce: number | undefined;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await wallet.sendTransaction(nonce === undefined ? txReq : { ...txReq, nonce });
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (attempt < 3 && /nonce|already been used|nonce too low|replacement/i.test(msg)) {
        await sleep(800);
        nonce = await wallet.provider!.getTransactionCount(wallet.address, 'pending');
        continue;
      }
      throw e;
    }
  }
  throw new Error('unreachable');
}

/** How long a wizard flow may live before old input counts as expired. */
export const FLOW_TTL_MS = 15 * 60_000;
export const isStaleFlow = (startedAt: number): boolean => Date.now() - startedAt > FLOW_TTL_MS;

/**
 * How many position cards are built at once. It was 3, chosen to protect the RPC rate,
 * but a measurement on 30 Aug 2026 showed the RPC has far more headroom than that (33
 * parallel resolvePoolKeyV4 calls took 77 ms) while a single getPositionDetail takes about
 * 820 ms. At 3, twelve positions meant four waves and ~3.3 s before the first card went out.
 */
export const POS_CARD_CONCURRENCY = 6;

/**
 * A typed amount to wei, or null when it makes no sense. `Number(raw) > 0` alone lets
 * '1e-9' and over-long decimals through, and parseUnits then throws OUTSIDE the try block,
 * surfacing as a raw error card. Extra decimals are TRUNCATED, never rounded up.
 */
export function parseAmt(raw: string, dec: number): bigint | null {
  const t = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  const wei = ethers.parseUnits(`${i}.${f.slice(0, dec) || '0'}`, dec);
  return wei > 0n ? wei : null;
}

/** Run fn over items with a concurrency limit, to stay inside RPC rate limits. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Like mapLimit, but it returns ONE promise per item, so the order
 * pengiriman tetap terjaga sementara pekerjaan tetap jalan di latar.
 *
 * Position cards used to be built in full (`await mapLimit`) and only then sent one by
 * one, so the screen sat still through the last build wave even though the first card had
 * been ready for ages. Now card #1 goes out the moment card #1 exists.
 */
export function mapLimitStream<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R>[] {
  const out: Array<{ resolve: (v: R) => void; reject: (e: unknown) => void; promise: Promise<R> }> = items.map(() => {
    let resolve!: (v: R) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Without this, a failed item becomes an unhandled rejection BEFORE the caller can
    // await it, and Node kills the process -- the whole bot dying over one bad card.
    promise.catch(() => {});
    return { resolve, reject, promise };
  });
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i].resolve(await fn(items[i], i));
      } catch (e) {
        out[i].reject(e);
      }
    }
  };
  void Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.map((o) => o.promise);
}

/** Edit the existing progress message, or send a new one if that fails or none exists. */
export async function editProgress(
  ctx: any,
  prog: { message_id: number } | null | undefined,
  text: string,
  extra: Record<string, unknown> = html,
): Promise<{ message_id: number }> {
  if (prog?.message_id && ctx.chat?.id) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, prog.message_id, undefined, text, extra);
      return prog;
    } catch {
      /* fallback: send a fresh bubble */
    }
  }
  return ctx.reply(text, extra);
}

/**
 * Flow-reset registration. Every module holding per-user state registers its own cleaner
 * here, so resetFlows() needs to know nothing about which flows exist -- which is what used
 * to force all of them to live in one file.
 */
const flowResets: Array<(uid: number) => void> = [];

export function registerFlowReset(fn: (uid: number) => void): void {
  flowResets.push(fn);
}

/** Starting a new flow discards the old one, so nothing hijacks the next message. */
export function resetFlows(uid: number): void {
  for (const fn of flowResets) fn(uid);
}

/**
 * The /start grid: every command the bot answers, as one tap each.
 *
 * This deliberately breaks the usual "at most six buttons per card" rule. /start is a
 * launcher, not a card that asks a question -- hiding twelve of fifteen commands behind
 * a submenu costs a tap on every use to save scrolling once.
 *
 * Connect Wallet replaces the whole grid when there is no wallet: nothing else on it
 * would work anyway.
 */
export const START_GRID: Array<[label: string, data: string]> = [
  ['💰 Portfolio', 'portfolio'], ['📊 Positions', 'positions'], ['🧾 PnL', 'pnl'],
  // No Add LP, Close LP or Buy: all three start from a pasted CA or from the position
  // itself in /positions. A button for any of them would only ask for the CA again.
  // Swap stays -- it opens the holdings list, which is the point when the CA is the
  // thing you do not have to hand. It runs /sell: the label is the wider word, the
  // action behind it is still selling a holding back to the pair's base.
  // No Unwrap either: sweepStuckWeth unwraps stray WETH on every chain each minute, and
  // recoverStrayWeth fires the moment an add or close fails. /unwrap stays as a typed
  // command for the rare case both are unavailable; it does not need a button.
  ['🎯 Claim Fees', 'cmd:claim_fees'], ['💱 Swap', 'cmd:swap'], ['🌉 Bridge', 'cmd:bridge'],
  // Withdraw, not Send: it runs /send, but "withdraw" is what moving funds out to your
  // own address is called, and it reads as the exit from the bot rather than a transfer.
  ['📤 Withdraw', 'cmd:withdraw'], ['⛽ Gas', 'cmd:gas'], ['🔔 Alerts', 'cmd:alerts'],
  ['⚙️ Settings', 'cmd:settings'], ['📖 Help', 'help'],
];

export const startKeyboard = () => {
  if (!walletStore.isConnected()) {
    return Markup.inlineKeyboard([[Markup.button.callback('🔗 Connect Wallet', 'connect')]]);
  }
  const rows = [];
  for (let i = 0; i < START_GRID.length; i += 3) {
    rows.push(START_GRID.slice(i, i + 3).map(([t, d]) => Markup.button.callback(t, d)));
  }
  return Markup.inlineKeyboard(rows);
};

/**
 * The WELCOME card, built in one place.
 *
 * /start, a successful connect and every "Back to Menu" button all land here, and when
 * each built its own version they drifted: Back to Menu still opened the old /help card
 * long after /start had become the real menu.
 */
export function startCard(o: { imported?: number; gone?: number } = {}): string {
  const cc = getChain();
  const addr = walletStore.address();
  // All three, or none: an RPC without a wallet reads nothing, and a wallet without an RPC
  // has nothing to read with. Either way the card must not advertise Solana.
  // The connected keystore first, the .env address second: once a key is connected it is
  // the wallet that actually signs, and the card must name that one.
  const solAddr = solWallet.address();
  const solConfigured = config.solana.enabled && !!solRpcUrl() && !!solAddr;
  return msg.msgStarted({
    dryRun: config.safety.dryRun,
    chainLabel: cc.label,
    chainId: cc.chainId,
    positions: store.active().length,
    imported: o.imported ?? 0,
    gone: o.gone ?? 0,
    walletShort: addr ? msg.shortAddr(addr) : null,
    // Shortened here rather than through shortAddr(): that helper cuts 6 and 4 around an
    // ellipsis, which is right for '0x'-prefixed hex where the first two characters carry
    // no identity. A base58 key has no prefix, so all six leading characters are kept.
    solShort: solConfigured && solAddr ? `${solAddr.slice(0, 6)}…${solAddr.slice(-4)}` : null,
    // Solana is not in CHAINS and never will be (it is not a ChainCtx), so the label is
    // appended here. Only when it is actually configured: an unreachable chain listed on
    // the welcome card is a promise the bot cannot keep.
    chainLabels: [
      ...Object.values(CHAINS).map((c) => c.label),
      ...(solConfigured ? ['Solana'] : []),
    ],
  });
}
