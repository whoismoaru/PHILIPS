import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, parseAmt, isStaleFlow, registerFlowReset } from '../core.js';
import { CHAINS, getChain, isStableBase, type ChainCtx, type BaseKind } from '../chains.js';
import { bestBridgeQuote, executeBridgeVia, type BridgeProvider } from '../bridgeRoute.js';
import { NATIVE } from '../relay.js';
import { ERC20_ABI } from '../chain.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';

/**
 * /bridge — pindahkan dana NATIVE antar chain lewat Relay.
 *
 * Jalur uang paling tak bisa dibatalkan di bot ini: begitu terkirim, dana ada di
 * chain lain dan hanya bridge lain yang bisa membawanya kembali. Karena itu:
 *  - arah dipilih eksplisit (tak ada default yang bisa salah tap),
 *  - quote DIMINTA ULANG saat konfirmasi, dengan lantai minimum dari angka yang
 *    benar-benar dilihat user (relay.executeBridge),
 *  - sesi kedaluwarsa dan kunci in-flight seperti alur uang lain.
 */

// Quote bridge cepat basi; di atas ini kartu wajib dibuat ulang.
const QUOTE_TTL_MS = 120_000;
/** Sisa gas yang tak boleh ikut dikirim (bridge dibayar di chain asal). */
const GAS_RESERVE_WEI = ethers.parseEther('0.0005');

type BridgeFlow = {
  fromKey: string;
  toKey: string;
  kind?: BaseKind; // aset sumber yang dipilih (weth→native, atau stablecoin)
  originCurrency?: string; // alamat aset dikirim (NATIVE utk native)
  destinationCurrency?: string; // alamat aset diterima di chain tujuan
  srcDecimals?: number;
  dstDecimals?: number;
  srcSymbol?: string;
  awaitingAmount?: boolean;
  amountWei?: bigint;
  minOutWei?: bigint;
  inLabel?: string;
  outLabel?: string;
  provider?: BridgeProvider; // penyedia terpilih (Relay / LI.FI) — dieksekusi ulang saat konfirmasi
  quotedAt?: number;
  startedAt: number;
};
const flows = new Map<number, BridgeFlow>();
const inFlight = new Set<number>();
registerFlowReset((uid) => flows.delete(uid));

/** Simbol tampilan aset sumber: native pakai simbol native, stablecoin pakai simbolnya. */
const assetLabel = (cc: ChainCtx, kind: BaseKind): string =>
  kind === 'weth' ? cc.nativeSymbol : (cc.bases.find((b) => b.kind === kind)?.symbol ?? kind.toUpperCase());

/**
 * Petakan aset sumber (kind di chain asal) ke aset tujuan di chain tujuan:
 *  - native (weth) → native chain tujuan,
 *  - stablecoin → stablecoin sejenis di tujuan, atau stablecoin pertama yang ada.
 * Lempar bila chain tujuan tak punya penerima yang cocok.
 */
function resolveAssets(from: ChainCtx, to: ChainCtx, kind: BaseKind) {
  const srcBase = from.bases.find((b) => b.kind === kind);
  if (!srcBase) throw new Error(`${from.label} tidak punya ${kind.toUpperCase()}`);
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

/** Saldo aset sumber (native atau ERC20), diformat sesuai desimalnya. */
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

/** Semua pasangan arah antar chain aktif. Satu chain = tak ada yang bisa dijembatani. */
function routes(): Array<{ from: ChainCtx; to: ChainCtx }> {
  const list = Object.values(CHAINS);
  const out: Array<{ from: ChainCtx; to: ChainCtx }> = [];
  for (const from of list) for (const to of list) if (from.key !== to.key) out.push({ from, to });
  return out;
}

async function cmdBridge(ctx: any) {
  const rs = routes();
  if (rs.length === 0) return ctx.reply(msg.msgBridgeUnavailable(), html);
  flows.delete(ctx.from.id);
  const rows = rs.map((r) => [
    Markup.button.callback(`${r.from.label} → ${r.to.label}`, `br:${r.from.key}:${r.to.key}`),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
  return ctx.reply(msg.msgBridgePick(rs.map((r) => ({ from: r.from.label, to: r.to.label }))), {
    ...html,
    ...Markup.inlineKeyboard(rows),
  });
}
bot.command('bridge', cmdBridge);

// Setelah rute dipilih → tampilkan bubble ASET yang bisa dijembatani dari chain asal
// (native + tiap stablecoin yang dimiliki chain itu).
bot.action(/^br:(\w+):(\w+)$/, async (ctx) => {
  const [fromKey, toKey] = [ctx.match[1], ctx.match[2]];
  const from = CHAINS[fromKey];
  const to = CHAINS[toKey];
  if (!from || !to) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  flows.set(ctx.from!.id, { fromKey, toKey, startedAt: Date.now() });
  const rows = from.bases.map((b) => [
    Markup.button.callback(assetLabel(from, b.kind), `bra:${fromKey}:${toKey}:${b.kind}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'br:back'), Markup.button.callback('❌ Cancel', 'cancel')]);
  await ctx.editMessageText(msg.msgBridgeAsset(from.label, to.label), { ...html, ...Markup.inlineKeyboard(rows) });
});

// Aset dipilih → minta nominal.
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
  const bal = await assetBalance(from, kind);
  await ctx.editMessageText(msg.msgBridgeAmount(from.label, to.label, bal.label, a.srcSymbol), {
    ...html,
    ...Markup.inlineKeyboard([
      pctPresets.get('bridge').map((p) => Markup.button.callback(`${p}%`, `brpct:${p}`)),
      [Markup.button.callback('⬅️ Back', `br:${fromKey}:${toKey}`)],
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

/**
 * Persen saldo → nominal bridge.
 *
 * Untuk aset NATIVE, persennya dihitung dari saldo yang sudah dikurangi cadangan
 * gas: ongkos bridge dibayar di chain ASAL, jadi 100% dari saldo mentah berarti
 * tak ada sisa untuk membayar transaksinya sendiri. Stablecoin dipakai utuh —
 * gasnya dibayar native, dan kecukupannya dicek terpisah di jalur quote.
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

/** Ketikan nominal → quote + kartu konfirmasi. Dipanggil handler teks index.ts. */
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

/** Cek saldo + quote + kartu konfirmasi. Dipakai jalur ketik-nominal & tombol persen. */
async function bridgeQuote(ctx: any, flow: BridgeFlow, wei: bigint): Promise<void> {
  const from = CHAINS[flow.fromKey];
  const to = CHAINS[flow.toKey];
  const kind = flow.kind ?? 'weth';
  const isNative = kind === 'weth';
  const prog = await ctx.reply(msg.msgProgress('requesting bridge quote…'), html);
  try {
    // Native: sisakan gas (dibayar di chain asal). Stablecoin: cek saldo token cukup,
    // DAN masih ada native buat bayar gas — kalau tidak, tx-nya sendiri gagal.
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
    // Lantai minimum = hasil yang BENAR-BENAR dilihat user, dikurangi toleransi 1%.
    flow.minOutWei = (q.outWei * 99n) / 100n;
    flow.inLabel = q.inLabel;
    flow.outLabel = q.outLabel;
    flow.quotedAt = Date.now();
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

bot.action('br:go', async (ctx) => {
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
  flows.delete(uid); // idempotency: hapus SEBELUM eksekusi (double-tap tak bridge dobel)
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
        // Pakai label out yang sudah dikonfirmasi (simbol+desimal aset tujuan benar);
        // outWei mentah tanpa desimal tujuan bisa salah tampil utk stablecoin 6-desimal.
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
});
