import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, mapLimit, POS_CARD_CONCURRENCY } from '../core.js';
import { ctxOf, CHAINS } from '../chains.js';
import { getPositionDetail, collectFeesOnly, removeLiquidityPct } from '../uniswap.js';
import { listPositionsV4, collectFeesV4, invalidateV4ListCache } from '../uniswapV4.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';

/**
 * /claim_fees — panen fee tanpa menutup posisi.
 * Tarik sebagian — 25/50/75% (posisi tetap hidup) atau 100% (dialihkan ke jalur
 * /stop yang sudah menangani burn + jurnal + cashout). Masuknya lewat tombol
 * "🗑️ Withdraw" di kartu posisi; command /remove_lp sudah dihapus.
 */

// ---------- /claim_fees — panen fee tanpa menutup posisi ----------
/** One claimable position, from either protocol. */
type Claimable = { id: string; chainKey: string; symbol: string; label: string; base: number; v4: boolean };

/**
 * Every position with fees waiting, v3 AND v4, across every chain.
 *
 * v4 was invisible here for months: this read only store.active(), which holds v3
 * records, so a v4 position quietly accrued fees that /claim_fees swore did not exist.
 * v4 positions are enumerated from the chain itself rather than the store, the same way
 * /positions finds them.
 */
async function unclaimedList(): Promise<Claimable[]> {
  const v3 = await mapLimit(store.active(), POS_CARD_CONCURRENCY, async (rec): Promise<Claimable | null> => {
    try {
      const d = await getPositionDetail(rec.tokenId, ctxOf(rec));
      const amt = Number(ethers.formatUnits(d.feesBaseWei, d.baseDecimals));
      return {
        id: rec.tokenId,
        chainKey: rec.chain ?? ctxOf(rec).key,
        symbol: rec.symbol,
        label: `${amt.toFixed(d.baseDecimals >= 18 ? 5 : 2)} ${d.baseSymbol}`,
        base: amt,
        v4: false,
      };
    } catch {
      return null;
    }
  });

  const v4Lists = await Promise.all(
    Object.values(CHAINS).map(async (cc) => {
      try {
        const ps = await listPositionsV4(cc);
        return ps.map((p): Claimable | null => {
          if (p.feesBaseWei === null || p.feesBaseWei <= 0n) return null;
          // v4 fees are already valued in the pair's base; USDG is 6-dec, ETH 18.
          const dec = p.base === 'USDG' ? 6 : 18;
          const amt = Number(ethers.formatUnits(p.feesBaseWei, dec));
          return {
            id: p.tokenId,
            chainKey: cc.key,
            // The token, not the pair: the base side is the same on every row and
            // says nothing about which position this is.
            symbol: p.base && p.sym0 === p.base ? p.sym1 : p.base && p.sym1 === p.base ? p.sym0 : `${p.sym0}/${p.sym1}`,
            label: `${amt.toFixed(dec >= 18 ? 5 : 2)} ${p.base ?? ''}`.trim(),
            base: amt,
            v4: true,
          };
        });
      } catch {
        return [];
      }
    }),
  );

  return [...v3, ...v4Lists.flat()].filter((x): x is Claimable => x !== null && x.base > 0);
}

export async function cmdClaimFees(ctx: any) {
  const prog = await ctx.reply(msg.msgProgress('reading unclaimed fees…'), html);
  const list = await unclaimedList();
  if (!list.length) return editProgress(ctx, prog, msg.msgNoFees());
  // The callback carries the protocol: a v4 id and a v3 id can collide, and collecting
  // with the wrong contract fails in a way that reads like the position is missing.
  const rows = list.map((x) => [
    Markup.button.callback(`💵 ${x.symbol} · ${x.label}`, `claim:${x.v4 ? 'v4' : 'v3'}:${x.chainKey}:${x.id}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Back to Menu', 'positions_back')]);
  await editProgress(
    ctx,
    prog,
    msg.msgClaimPick(list.map((x) => ({ symbol: x.symbol, id: x.id, label: x.label }))),
    { ...html, ...Markup.inlineKeyboard(rows) },
  );
}
bot.command('claim_fees', cmdClaimFees);

const claiming = new Set<string>(); // anti double-tap: tx kedua menarik 0 & buang gas
/** Collect for one position. The caller has already answered the callback and taken
 *  the anti-double-tap slot, so this only has to undo the slot it was handed. */
async function doClaim(ctx: any, proto: string, chainKey: string, id: string) {
  const tag = `${proto}:${id}`;
  const cc = CHAINS[chainKey];
  if (!cc) return void (await ctx.reply(msg.msgError('claim', `Unknown chain ${chainKey}.`), html));
  store.beginMoneyOp(); // sweep monitor tak boleh mengirim tx dari dompet yang sama
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgClaimDone(id, '(dry run)', null), html);
      return;
    }
    if (proto === 'v4') {
      const r = await collectFeesV4(id, cc);
      // Decimals per side, read from the tokens themselves -- a v4 pair can hold a
      // 6-decimal stable next to an 18-decimal token, and assuming 18 shifts the
      // reported figure by a million.
      const dec = async (a: string) =>
        a === ethers.ZeroAddress
          ? 18
          : Number(await new ethers.Contract(a, ['function decimals() view returns (uint8)'], cc.provider).decimals());
      const [d0, d1] = await Promise.all([dec(r.poolKey.currency0), dec(r.poolKey.currency1)]);
      const part = (wei: bigint, d: number, sym: string) =>
        wei > 0n ? `${Number(ethers.formatUnits(wei, d)).toFixed(d >= 18 ? 5 : 2)} ${sym}` : null;
      const label = [part(r.amount0, d0, r.sym0), part(r.amount1, d1, r.sym1)].filter(Boolean).join(' + ') || 'nothing';
      invalidateV4ListCache(); // the list caches fees; a stale entry would offer the same claim twice
      await ctx.editMessageText(msg.msgClaimDone(id, label, r.txHash), html);
      return;
    }
    const rec = store.active().find((r) => r.tokenId === id);
    if (!rec) return void (await ctx.reply(msg.msgError('claim', 'Position is no longer active.'), html));
    const d = await getPositionDetail(id, cc);
    const res = await collectFeesOnly(id, cc);
    const baseRaw = d.baseIsToken0 ? res.amount0 : res.amount1;
    const otherRaw = d.baseIsToken0 ? res.amount1 : res.amount0;
    const label =
      `${Number(ethers.formatUnits(baseRaw, d.baseDecimals)).toFixed(d.baseDecimals >= 18 ? 5 : 2)} ${d.baseSymbol}` +
      (otherRaw > 0n ? ` + ${Number(ethers.formatUnits(otherRaw, d.otherDecimals)).toFixed(4)} ${d.otherSymbol}` : '');
    await ctx.editMessageText(msg.msgClaimDone(id, label, res.txHash), html);
  } catch (e) {
    await ctx.reply(msg.msgError('claim', (e as Error).message), html);
  } finally {
    claiming.delete(tag);
    store.endMoneyOp();
  }
}

// The spinner is answered in the handler itself, not in a helper: a Telegram button
// that returns without answering spins until it times out.
bot.action(/^claim:(v3|v4):([a-z0-9_-]+):(\d+)$/i, async (ctx: any) => {
  const [, proto, chainKey, id] = ctx.match as string[];
  const tag = `${proto}:${id}`;
  if (claiming.has(tag)) return ctx.answerCbQuery('Processing…');
  claiming.add(tag);
  await ctx.answerCbQuery();
  return doClaim(ctx, proto, chainKey, id);
});

// Buttons from cards sent before the protocol tag existed carry a bare id, which is
// always a v3 position whose record names its own chain.
bot.action(/^claim:(\d+)$/, async (ctx: any) => {
  const id = ctx.match[1];
  const tag = `v3:${id}`;
  if (claiming.has(tag)) return ctx.answerCbQuery('Processing…');
  claiming.add(tag);
  await ctx.answerCbQuery();
  const rec = store.active().find((r) => r.tokenId === id);
  return doClaim(ctx, 'v3', rec?.chain ?? ctxOf(rec ?? ({} as any)).key, id);
});

// ---------- Tarik sebagian likuiditas ----------
// Command /remove_lp DIHAPUS (28 Agu 2026): isinya cuma daftar posisi dengan satu
// tombol per posisi menuju pemilih persen di bawah, dan pemilih itu sudah dicapai
// dari kartu posisi lewat tombol "🗑️ Withdraw" (rm:<id>). Dua pintu, satu ruangan.
bot.action(/^rm:(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg.msgRemovePct(id), {
    ...html,
    ...Markup.inlineKeyboard([
      ...pctPresets.chunkButtons(pctPresets.get('stop').map((p) => Markup.button.callback(`${p}%`, `rmpct:${id}:${p}`))),
      [Markup.button.callback('100% (close position)', `stop:${id}`)],
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

bot.action(/^rmpct:(\d+):(\d+)$/, async (ctx) => {
  const [id, pct] = [ctx.match[1], Number(ctx.match[2])];
  await ctx.answerCbQuery();
  const rec = store.active().find((r) => r.tokenId === id);
  if (!rec) return ctx.editMessageText(msg.msgAlreadyClosed(id), html);
  let est = '—';
  try {
    const d = await getPositionDetail(id, ctxOf(rec));
    const v = Number(ethers.formatUnits(d.valueBaseWei, d.baseDecimals)) * (pct / 100);
    est = `≈ ${v.toFixed(d.baseDecimals >= 18 ? 5 : 2)} ${d.baseSymbol}`;
  } catch {
    /* estimasi opsional — jangan blokir penarikan hanya karena RPC baca gagal */
  }
  await ctx.editMessageText(msg.msgRemoveConfirm(id, rec.symbol, pct, est, config.safety.dryRun), {
    ...html,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Withdraw', `rmok:${id}:${pct}`)],
      [Markup.button.callback('⬅️ Back', `rm:${id}`), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

const removing = new Set<string>();
bot.action(/^rmok:(\d+):(\d+)$/, async (ctx) => {
  const [id, pct] = [ctx.match[1], Number(ctx.match[2])];
  if (removing.has(id)) return ctx.answerCbQuery('Processing…');
  const rec = store.active().find((r) => r.tokenId === id);
  if (!rec) return ctx.answerCbQuery('Position is no longer active.');
  removing.add(id);
  await ctx.answerCbQuery();
  store.beginMoneyOp(); // idem: penarikan sebagian juga mengirim tx
  try {
    if (config.safety.dryRun) {
      await ctx.editMessageText(msg.msgRemoveDone(id, pct, null), html);
      return;
    }
    const { txHash } = await removeLiquidityPct(id, pct, ctxOf(rec));
    // Modal tercatat harus ikut menyusut. Tanpa ini sisa posisi dibandingkan dengan
    // modal PENUH: tarik 50% → kartu selamanya menampilkan −50%, dan alert rugi
    // bersih langsung menyala padahal dananya sudah ada di dompet.
    const kept = 100n - BigInt(pct);
    const keptWei = (BigInt(rec.initialWethWei || '0') * kept) / 100n;
    store.update(id, {
      initialWethWei: keptWei.toString(),
      ...(rec.nominalEth ? { nominalEth: String((Number(rec.nominalEth) * Number(kept)) / 100) } : {}),
      ilAlerted: false,
    });
    await ctx.editMessageText(msg.msgRemoveDone(id, pct, txHash), html);
  } catch (e) {
    await ctx.reply(msg.msgError('remove', (e as Error).message), html);
  } finally {
    removing.delete(id);
    store.endMoneyOp();
  }
});

