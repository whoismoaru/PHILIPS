import type { Telegraf } from 'telegraf';
import { config } from './config.js';
import { getPositionDetail } from './uniswap.js';
import { getChain, CHAINS, ERC20_ABI, baseDecimalsOf, baseAssetOf, ctxOf } from './chains.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust } from './relay.js';
import { ethers } from 'ethers';
import * as store from './store.js';
import * as alerts from './alerts.js';
import * as journal from './journal.js';
import * as v4store from './v4store.js';
import { checkV4Status, v4Supported, v4OwnerOf } from './uniswapV4.js';
import { getEthUsd } from './screening.js';
import { msgRangeEnter, msgRangeExit, msgPriceDrop, msgIlAlert, msgConverted, msgV4Range, msgSwept } from './messages.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A passive auto-monitor: every interval it checks the ACTIVE positions and sends a
 * notification as one enters or leaves its range, which is where conversion and fee
 * earning start and stop.
 */

const INTERVAL_MS = 60_000;
const DROP_ALERT_PCT = 25; // the default threshold when /alerts has not been set
const DROP_HYSTERESIS_PCT = 5; // recovering 5% above the threshold re-arms the rung (anti-spam)
/**
 * Drop-alert rungs, from the user's threshold downwards. One alert per rung, so a fall
 * that keeps going keeps reporting without flooding the chat.
 */
/**
 * Token price drop (%) read from the pool tick, with no outside price source.
 * The token price per base is 1.0001^(sgn*tick), with sgn = -1 when the base is currency0.
 * Positive is a fall, a dip; negative is a rise.
 */
export function dropPctFromTick(tick: number, entryTick: number, baseIsCurrency0: boolean): number {
  const sgn = baseIsCurrency0 ? -1 : 1;
  return (1 - Math.pow(1.0001, sgn * (tick - entryTick))) * 100;
}

/**
 * The monitor's ONLY way out to Telegram. `flag` names the /alerts switch that governs
 * this message; null marks a report of an ACTION the bot took with money, which is always
 * sent. It is a required argument so the check cannot be forgotten -- the v4 path used to
 * call bot.telegram directly and ignored the settings entirely.
 */
async function notify(
  bot: Telegraf,
  flag: 'rangeNotify' | 'dropPct' | 'ilPct' | null,
  text: string,
  extra: Record<string, unknown> = html,
): Promise<void> {
  if (flag !== null) {
    const v = alerts.get()[flag];
    if (v === null || v === false) return;
  }
  await bot.telegram.sendMessage(config.telegram.allowedUserId, text, extra);
}

function dropLadder(base: number): number[] {
  return [...new Set([base, 30, 50, 75].filter((t) => t >= base))].sort((a, b) => a - b);
}
const SWEEP_EVERY_MS = 60_000; // sweep leftover tokens every minute, i.e. on every monitor tick
const SWEEP_COOLDOWN_MS = 6 * 3_600_000; // per token max 1 percobaan / 6 jam
const SWEEP_RECENT_MS = 24 * 3_600_000; // cash-out leftovers always surface in the first hours
const DUST_COOLDOWN_MS = 7 * 24 * 3_600_000; // a token that is "too small" backs off for 7 days
const SWEEP_RETRY_BACKOFF_MS = 10 * 60_000; // a transient RPC failure backs off for 10 minutes
const SWEEP_FILE = join(process.cwd(), 'data', 'sweep.json');
const html = { parse_mode: 'HTML' as const };
// nextSweep[key] = the earliest epoch ms this token may be swept again. Persisted to
// disk so the cooldown survives a restart -- in memory, dust was retried on every boot.
const nextSweep = loadSweep();
let lastSweepRun = 0;

function loadSweep(): Map<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SWEEP_FILE, 'utf8')) as Record<string, number>));
  } catch {
    return new Map();
  }
}

function saveSweep() {
  try {
    store.writeJson(SWEEP_FILE, Object.fromEntries(nextSweep));
  } catch {
    /* non-fatal */
  }
}

/** Drop the STOPPED record for this token: its leftover is no longer in the wallet. */
function reapStopped(ca: string, chain?: string): void {
  const st = store
    .all()
    .find(
      (x) =>
        x.status === 'STOPPED' &&
        (x.chain ?? 'robinhood') === (chain ?? 'robinhood') &&
        x.ca?.toLowerCase() === ca.toLowerCase(),
    );
  if (st) store.remove(st.tokenId);
}

/** Sweep leftover tokens from a failed cash-out in the wallet into the position's base. Non-fatal. */
async function sweepLeftovers(bot: Telegraf) {
  if (Date.now() - lastSweepRun < SWEEP_EVERY_MS) return;
  lastSweepRun = Date.now();
  const seen = new Set<string>();
  // Candidates are GENUINE leftovers only: STOPPED positions, plus tokens from a close in
  // the last 24 hours whose record may already be gone. Never every token ever LP'd --
  // that would sell a spot bag bought with /buy along with it.
  const candidates = [
    ...store
      .all()
      .filter((r) => r.status === 'STOPPED')
      .map((r) => ({
        tokenId: r.tokenId,
        ca: r.ca,
        chain: r.chain,
        venue: r.venue,
        symbol: r.symbol,
        baseKind: r.baseKind,
        cap: r.leftoverWei ? BigInt(r.leftoverWei) : undefined,
      })),
    ...journal
      .readMine(80)
      .filter((e) => e.ca && Date.now() - e.closedAt < SWEEP_RECENT_MS)
      .map((e) => ({
        tokenId: e.tokenId,
        ca: e.ca as string,
        chain: e.chain,
        venue: undefined as string | undefined,
        symbol: e.symbol,
        baseKind: e.baseKind,
        cap: undefined as bigint | undefined,
      })),
  ];
  for (const r of candidates) {
    if (!r.ca) continue;
    const key = `${r.chain ?? 'robinhood'}:${r.ca.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Date.now() < (nextSweep.get(key) ?? 0)) continue;
    const cc = ctxOf(r);
    try {
      const t = new ethers.Contract(r.ca, ERC20_ABI, cc.wallet);
      const bal: bigint = await t.balanceOf(cc.wallet.address);
      if (bal === 0n) {
        // Nothing left to recover: the balance was swept earlier or sold by hand. This
        // used to just `continue`, so a dead record stayed in the store for good and was
        // retried every round (币安城 sat there from 11 Aug with a zero on-chain balance).
        // Reap it here instead.
        reapStopped(r.ca, r.chain);
        continue;
      }
      // Sell at most THIS position's leftover, never a spot bag of the same token held
      // separately. An older record without a cap falls back to the whole balance.
      const amt = r.cap !== undefined && r.cap < bal ? r.cap : bal;
      if (amt === 0n) continue;
      nextSweep.set(key, Date.now() + SWEEP_COOLDOWN_MS);
      saveSweep();
      if (config.safety.dryRun) continue;
      // Sweep back to the position's OWN base. This always went to native once: closing a
      // USDT position and recovering its dust as BNB quietly changed both the denomination
      // and the exposure, and left the result impossible to match against the deposit.
      const stableAsset = r.baseKind && r.baseKind !== 'weth' ? baseAssetOf(cc, r.baseKind) : undefined;
      const stableAddr = stableAsset?.address;
      const res = stableAddr
        ? await swapTokenToUsdgRobust(r.ca, amt, stableAddr, cc).then((x) => ({
            outEthWei: x.outWei,
            route: x.route,
            unit: stableAsset!.symbol,
            dec: baseDecimalsOf(r.chain, r.baseKind),
          }))
        : await swapTokenToEthRobust(r.ca, amt, cc).then((x) => ({
            outEthWei: x.outEthWei,
            route: x.route,
            unit: cc.nativeSymbol,
            dec: 18,
          }));
      // The leftover is recovered, so the STOPPED record has no reason to stay -- kept,
      // it would pile up for good and be a sweep candidate every round.
      reapStopped(r.ca, r.chain);
      // The money only arrives NOW, long after the close entry was written. Without this
      // record the journal understates that position's PnL for good.
      journal.recordRecovery({
        tokenId: r.tokenId,
        symbol: r.symbol,
        ca: r.ca,
        chain: r.chain,
        baseKind: stableAddr ? r.baseKind : 'weth',
        amountWei: res.outEthWei,
      });
      const gotLabel = `${Number(ethers.formatUnits(res.outEthWei, res.dec)).toFixed(res.dec >= 18 ? 6 : 2)} ${res.unit}`;
      console.log(`[sweep] ${r.symbol} (${cc.key}) → +${gotLabel} via ${res.route}`);
      // Default extra = html. Passing {} here used to strip the parse mode, so any
      // markup in this card would have reached the chat as raw tags.
      // Flag on the first line on purpose: smoke-alerts scans these calls line by line to
      // prove every notification respects /alerts, and a wrapped call hides the flag.
      await notify(bot, null, msgSwept({ symbol: r.symbol, tokenId: r.tokenId, amountLabel: gotLabel, dryRun: config.safety.dryRun }));
    } catch (e) {
      const emsg = (e as Error).message ?? '';
      // Dust, worth too little to swap, backs off for a long time rather than retrying every 6h.
      if (/too small|below minimum|\bminimum\b|dust/i.test(emsg)) {
        nextSweep.set(key, Date.now() + DUST_COOLDOWN_MS);
        saveSweep();
      } else if (Date.now() >= (nextSweep.get(key) ?? 0)) {
        // Failed BEFORE the 6-hour cooldown was set, most often while reading the balance
        // (an RPC reset). With no pause the token is retried every minute for as long as
        // the RPC misbehaves: on 28 Aug 2026 one token failed 8 times in 15 minutes, adding
        // load exactly while the network was struggling. Back off briefly, not for 6 hours:
        // this is a transient failure, not a verdict that the token is not worth sweeping.
        nextSweep.set(key, Date.now() + SWEEP_RETRY_BACKOFF_MS);
        saveSweep();
      }
      console.log(`[sweep] ${r.symbol} failed: ${emsg.slice(0, 120)}`);
    }
  }
  await sweepStuckWeth(bot);
  await reapDeadV4();
}

/**
 * Drop v4 records whose position no longer exists on chain.
 *
 * A ghost record is worse than clutter: closing a v4 ladder packs every leg into ONE
 * multicall, so a single unminted id reverts the whole batch with 'NOT_MINTED' and the
 * healthy legs cannot be closed either. On 29 Aug 2026 eight ghosts blocked a ladder
 * until they were cleared by hand.
 *
 * ONLY an ownership revert counts as "gone". A failed read (a flaky RPC) is left alone --
 * deleting records because the network is having a bad minute is how positions get lost.
 */
async function reapDeadV4(): Promise<void> {
  for (const cc of Object.values(CHAINS)) {
    if (!v4Supported(cc)) continue;
    for (const r of v4store.allV4().filter((x) => x.chain === cc.key)) {
      try {
        await v4OwnerOf(cc, r.tokenId);
      } catch (e) {
        const m = (e as Error).message ?? '';
        if (!/NOT_MINTED|invalid token id|nonexistent/i.test(m)) continue;
        v4store.removeV4(r.tokenId);
        console.log(`[reap-v4] #${r.tokenId} does not exist on chain, dropping the record`);
      }
    }
  }
}

// The WETH dust threshold: under 0.00001 WETH is ignored, since unwrapping costs more than it is worth.
const WETH_DUST = 10_000_000_000_000n;

/**
 * Unwrap stuck WETH back to native. WETH is only ever an intermediate here (wrapped for
 * an open or a swap), so anything left by a half-failed operation is returned to native.
 * Without this it piles up and has to be unwrapped by hand.
 */
async function sweepStuckWeth(bot: Telegraf) {
  for (const cc of Object.values(CHAINS)) {
    if (!cc.hasWethBase) continue;
    try {
      const bal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (bal < WETH_DUST) continue;
      if (config.safety.dryRun) continue;
      const tx = await cc.weth.withdraw(bal);
      await tx.wait();
      const wrapped = cc.bases.find((b) => b.kind === 'weth')?.symbol ?? 'WETH';
      console.log(`[sweep-weth] unwrap ${ethers.formatEther(bal)} ${wrapped} → ${cc.nativeSymbol} (${cc.key})`);
      await notify(bot, null, `♻️ Swept ${Number(ethers.formatEther(bal)).toFixed(6)} stuck ${wrapped} → ${cc.nativeSymbol} (${cc.label})`, {});
    } catch (e) {
      console.log(`[sweep-weth] ${cc.key} failed: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

let tickStartedAt = 0; // 0 = idle
// One transaction that never settles (an RPC blackhole, an underpriced unwrap) means the
// `finally` never runs. With a boolean flag the monitor would die SILENTLY and for good:
// no range alerts, no drop alerts, no loss alerts, no sweeps. This deadline lets the next
// tick take over, and leaves the hung one to finish on its own.
const TICK_STUCK_MS = 5 * 60_000;

export function startMonitor(bot: Telegraf) {
  setInterval(async () => {
    // The previous tick is still waiting on a transaction: do not stack, unless it is stuck.
    if (tickStartedAt && Date.now() - tickStartedAt < TICK_STUCK_MS) return;
    if (tickStartedAt) console.log('[monitor] previous tick stuck >5m, carrying on without it');
    tickStartedAt = Date.now();
    try {
      await tick(bot);
    } finally {
      tickStartedAt = 0;
    }
  }, INTERVAL_MS);
}

/**
 * Refresh the USD rate for every unit, so a journal entry can be STAMPED as it closes.
 *
 * Ridden on the monitor's own pulse, which already runs every minute -- far cheaper than
 * fetching a price inside the close path, which has to be quick, and it adds no timer.
 */
async function refreshUsdRates(): Promise<void> {
  await Promise.all(
    Object.values(CHAINS).flatMap((cc) =>
      cc.bases.map(async (b) => {
        const unit = journal.unitOf(cc.key, b.kind);
        journal.noteUsdRate(unit, b.kind === 'weth' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : 1);
      }),
    ),
  );
}

async function tick(bot: Telegraf) {
  // A failed price fetch must not stop the monitor: entries closed this round simply go
  // unstamped, and /pnl values them as estimates.
  await refreshUsdRates().catch(() => {});
  // Sweep only while no money transaction is in flight: they share the nonce and the WETH.
  if (!store.isBusy())
    await sweepLeftovers(bot).catch((e) => console.log('[sweep] failed:', (e as Error).message.slice(0, 120)));
  for (const rec of store.active()) {
    try {
      const d = await getPositionDetail(rec.tokenId, ctxOf(rec));
      const cfg = alerts.get();
      if (cfg.rangeNotify && rec.lastInRange !== undefined && rec.lastInRange !== d.inRange) {
        if (d.inRange) {
          await notify(bot, 'rangeNotify',
            msgRangeEnter(rec.tokenId, rec.symbol, d.baseSymbol, rec.side === 'token'),
            {
              ...html,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 View Position Details', callback_data: `back:card:${rec.tokenId}` }],
                  [{ text: '💵 Harvest Fees', callback_data: `claim:${rec.tokenId}` }],
                  [{ text: '❌ Dismiss Alert', callback_data: 'dismiss' }],
                ],
              },
            },
          );
        } else {
          await notify(bot, 'rangeNotify',
            msgRangeExit(rec.tokenId, rec.symbol, d.side === 'above' ? 'above' : 'below', d.baseSymbol),
            html,
          );
        }
      }
      // FULLY CONVERTED alert: price went through the WHOLE range in the intended
      // direction, so the capital is now 100% the other asset and the position has stopped
      // earning fees. That is a different event from merely leaving the range -- and the
      // one that most needs acting on, because the capital cannot recover on its own until
      // price comes back. Fires once per crossing, and re-arms when it returns in range.
      const converted = !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below');
      if (cfg.rangeNotify && converted && !rec.convertedAlerted) {
        await notify(bot, 'rangeNotify',
          msgConverted(rec.tokenId, d.baseSymbol, rec.symbol, rec.side === 'token'),
          {
            ...html,
            reply_markup: {
              inline_keyboard: [
                [{ text: '🗑️ Withdraw Position', callback_data: `rm:${rec.tokenId}` }],
                [{ text: '📊 View Position Details', callback_data: `back:card:${rec.tokenId}` }],
                [{ text: '❌ Dismiss Alert', callback_data: 'dismiss' }],
              ],
            },
          },
        );
        store.update(rec.tokenId, { convertedAlerted: true });
      } else if (rec.convertedAlerted && d.inRange) {
        store.update(rec.tokenId, { convertedAlerted: false });
      }

      // TIERED drop alerts. The old version fired ONCE and then stayed quiet until price
      // recovered, so a catastrophic fall produced exactly one notification: 币安城 alerted
      // at -15%, then silence all the way to -93% because its dropAlerted was already true.
      // Now each rung (-15/-30/-50/-75 from your threshold) speaks for itself.
      const entry = rec.entryPrice ? Number(rec.entryPrice) : 0;
      const cur = Number(d.currentPrice);
      if (cfg.dropPct !== null && entry > 0 && cur > 0) {
        const ladder = dropLadder(cfg.dropPct ?? DROP_ALERT_PCT);
        const dropPct = (1 - cur / entry) * 100;
        // Older records: dropAlerted=true means the first rung has already fired.
        const tier = rec.dropTier ?? (rec.dropAlerted ? 1 : 0);
        // The deepest rung the current price has passed.
        let reached = 0;
        for (const t of ladder) if (dropPct >= t) reached++;
        if (reached > tier) {
          // The button opens the close card rather than sending a transaction, so nothing
          // moves without a deliberate tap -- but no command has to be typed mid-crash.
          await notify(bot, 'dropPct',
            msgPriceDrop(rec.tokenId, rec.symbol, dropPct, d.baseSymbol, ladder[reached - 1]),
            {
              ...html,
              reply_markup: {
                inline_keyboard: [[{ text: '⛔ Close Now', callback_data: `stop:${rec.tokenId}` }]],
              },
            },
          );
          store.update(rec.tokenId, { dropTier: reached, dropAlerted: true });
        } else if (tier > 0 && dropPct < ladder[0] - DROP_HYSTERESIS_PCT) {
          // Recovering above the threshold, less the hysteresis, re-arms the whole ladder.
          store.update(rec.tokenId, { dropTier: 0, dropAlerted: false });
        }
      } else if (rec.dropTier || rec.dropAlerted) {
        // Alerts are OFF, so clear any rung already armed. Left in place, switching
        // /alerts back on would inherit the old tier and the next alert would stay silent
        // until price passed that rung again -- the re-arm branch is off here too.
        store.update(rec.tokenId, { dropTier: 0, dropAlerted: false });
      }
      // The net-loss alert, impermanent loss after fees: position value plus fees against the
      // capital at open. Once per crossing, re-armed through the same marker as the drop alert.
      if (cfg.ilPct !== null && !rec.imported) {
        const init = Number(ethers.formatUnits(BigInt(rec.initialWethWei || '0'), d.baseDecimals));
        const now = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, d.baseDecimals));
        if (init > 0) {
          const lossPct = (1 - now / init) * 100;
          if (lossPct >= cfg.ilPct && !rec.ilAlerted) {
            await notify(bot, 'ilPct',
              msgIlAlert(rec.tokenId, rec.symbol, lossPct, cfg.ilPct),
              {
                ...html,
                reply_markup: {
                  inline_keyboard: [[{ text: '⛔ Close Now', callback_data: `stop:${rec.tokenId}` }]],
                },
              },
            );
            store.update(rec.tokenId, { ilAlerted: true });
          } else if (rec.ilAlerted && lossPct < cfg.ilPct - 5) {
            store.update(rec.tokenId, { ilAlerted: false });
          }
        }
      } else if (rec.ilAlerted) {
        store.update(rec.tokenId, { ilAlerted: false }); // alasan sama spt dropTier
      }
      store.update(rec.tokenId, { lastInRange: d.inRange });
    } catch (e) {
      // The position was burned (its NFT is gone): journal it and drop it from the store.
      // But leave anything being closed by hand alone -- that path holds the cash-out
      // figures, and journalling 'burned' here would double the entry or lose the PnL.
      if (
        /invalid token id/i.test(String((e as Error)?.message ?? e)) &&
        !store.closing.has(rec.tokenId) &&
        store.get(rec.tokenId)?.status === 'ACTIVE'
      ) {
        journal.recordClose(rec, { reason: 'burned' });
        store.remove(rec.tokenId);
      }
      /* any other error: skip this round */
    }
  }
  // Watch the v4 positions the bot MANAGES: in/out-of-range alerts, and cleanup once one
  // is closed. For a ladder, check ONE representative per group rather than every leg. A
  // 69-leg ladder meant 138 serial RPCs per round, which saturated the free Alchemy tier
  // and left every command (/positions among them) taking over a minute. Legs in a group
  // share a pool, so one leg's range status stands for all of them -- and one alert per
  // group is enough, not 69 notifications.
  const seenGroup = new Set<string>();
  const v4reps = v4store.allV4().filter((rec) => {
    if (!rec.groupId) return true; // a single position is always checked
    if (seenGroup.has(rec.groupId)) return false;
    seenGroup.add(rec.groupId);
    return true; // the group's first leg stands for the rest
  });
  for (const rec of v4reps) {
    try {
      const st = await checkV4Status(getChain(rec.chain), rec.tokenId);
      if (!st.exists && !rec.groupId) {
        v4store.removeV4(rec.tokenId); // single position, closed outside the bot: drop it
        continue;
      }
      // setV4InRange HAS A SIDE EFFECT (it stores the last status), so call it first and
      // keep that status fresh even while notifications are off. Skipped, switching
      // /alerts back on would compare against a stale status and fire a false alert.
      const changed = st.inRange !== null && v4store.setV4InRange(rec.tokenId, st.inRange);
      // Respect /alerts exactly as the v3 path does. This block used to check nothing at
      // all, so rangeNotify=false still flooded Telegram.
      if (changed && st.inRange !== null && alerts.get().rangeNotify) {
        const label = rec.groupId ? `${msgV4Range(rec.tokenId, st.inRange)} (ladder ${rec.legCount ?? '?'} leg)` : msgV4Range(rec.tokenId, st.inRange);
        await notify(bot, 'rangeNotify', label);
      }

      const cfgV4 = alerts.get();
      const sym = rec.groupId ? `#${rec.tokenId} (ladder)` : `#${rec.tokenId}`;

      // --- DROP alert, matching v3. The price comes from the TICK (a ratio of
      // 1.0001^Δtick), so it needs no outside price source and no extra RPC. ---
      if (cfgV4.dropPct !== null && st.tick !== null && rec.entryTick !== undefined) {
        const dropPct = dropPctFromTick(st.tick, rec.entryTick, rec.baseIsCurrency0);
        const ladder = dropLadder(cfgV4.dropPct);
        const tier = rec.dropTier ?? 0;
        let reached = 0;
        for (const t of ladder) if (dropPct >= t) reached++;
        if (reached > tier) {
          await notify(bot, 'dropPct',
            msgPriceDrop(rec.tokenId, sym, dropPct, rec.base ?? 'base', ladder[reached - 1]),
            { ...html, reply_markup: { inline_keyboard: [[{ text: '⛔ Close Now', callback_data: `closev4:${rec.tokenId}` }]] } },
          );
          v4store.updateV4(rec.tokenId, { dropTier: reached, dropAlerted: true });
        } else if (tier > 0 && dropPct < ladder[0] - DROP_HYSTERESIS_PCT) {
          v4store.updateV4(rec.tokenId, { dropTier: 0, dropAlerted: false });
        }
      } else if (rec.dropTier || rec.dropAlerted) {
        v4store.updateV4(rec.tokenId, { dropTier: 0, dropAlerted: false }); // switched off, so re-arm from clean
      }

      // --- NET LOSS alert, matching v3: value plus fees against the capital put in. For a
      // ladder this sums EVERY leg, since the legs are weighted differently and one
      // representative does not represent the rest. ---
      if (cfgV4.ilPct !== null && st.val) {
        const legs = rec.groupId ? v4store.groupV4(rec.groupId) : [rec];
        // Large ladders are skipped: each leg costs ~3 RPCs and the monitor runs every
        // minute. Raise this limit once the RPC is a paid one.
        if (legs.length <= 25) {
          let nowSum = 0n;
          let initSum = 0n;
          let failed = false;
          for (const leg of legs) {
            const v = leg.tokenId === rec.tokenId
              ? st.val
              : (await checkV4Status(getChain(leg.chain), leg.tokenId)).val;
            if (!v) { failed = true; break; }
            nowSum += v.valueBaseWei + v.feesBaseWei;
            initSum += BigInt(leg.entryBaseWei || '0');
          }
          if (!failed && initSum > 0n) {
            const dec = baseDecimalsOf(rec.chain, rec.base === 'USDG' ? 'usdg' : 'weth');
            const now = Number(ethers.formatUnits(nowSum, dec));
            const init = Number(ethers.formatUnits(initSum, dec));
            const lossPct = (1 - now / init) * 100;
            if (lossPct >= cfgV4.ilPct && !rec.ilAlerted) {
              await notify(bot, 'ilPct',
                msgIlAlert(rec.tokenId, sym, lossPct, cfgV4.ilPct),
                { ...html, reply_markup: { inline_keyboard: [[{ text: '⛔ Close Now', callback_data: `closev4:${rec.tokenId}` }]] } },
              );
              v4store.updateV4(rec.tokenId, { ilAlerted: true });
            } else if (rec.ilAlerted && lossPct < cfgV4.ilPct - 5) {
              v4store.updateV4(rec.tokenId, { ilAlerted: false });
            }
          }
        }
      } else if (rec.ilAlerted) {
        v4store.updateV4(rec.tokenId, { ilAlerted: false }); // alasan sama spt dropTier
      }
    } catch (e) {
      console.log(`[monitor:v4] #${rec.tokenId} skipped this round:`, (e as Error).message.slice(0, 120));
    }
  }
}
