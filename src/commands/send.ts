import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { bot, html, editProgress, parseAmt, isStaleFlow, registerFlowReset } from '../core.js';
import { CHAINS, isStableBase, type ChainCtx, type BaseAsset } from '../chains.js';
import { ERC20_ABI } from '../chain.js';
import { gasBuffer } from '../uniswap.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';

/**
 * /send — kirim dana ke alamat lain.
 *
 * Alamat EVM TIDAK membawa informasi chain: `0xabc…` yang sama valid di kelima
 * chain, dan tak ada cara menyimpulkan yang mana dari alamatnya saja. Jadi yang
 * "dideteksi" di sini adalah hal yang benar-benar bisa dideteksi:
 *  - di chain mana KAMU punya saldo untuk dikirim, dan berapa,
 *  - apakah alamat tujuan berupa KONTRAK di chain itu (kirim ke kontrak yang tak
 *    menerima transfer = dana hangus, jadi diperingatkan sebelum konfirmasi).
 *
 * Ini jalur satu arah tanpa pembatalan, jadi polanya sama dengan /bridge: pilihan
 * eksplisit, konfirmasi terpisah, kunci in-flight, dan sesi kedaluwarsa.
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

/** Sisa native yang WAJIB ditinggal untuk gas — kirim habis = tx-nya sendiri gagal. */
const fmtAmt = (wei: bigint, dec: number) => Number(ethers.formatUnits(wei, dec)).toLocaleString('en-US', {
  maximumFractionDigits: dec >= 18 ? 6 : 2,
});

/** Aset yang benar-benar bisa dikirim dari satu chain: native + tiap base ber-saldo. */
async function assetsOn(cc: ChainCtx): Promise<Array<{ address: string | null; symbol: string; decimals: number; wei: bigint }>> {
  const out: Array<{ address: string | null; symbol: string; decimals: number; wei: bigint }> = [];
  const nat = await cc.provider.getBalance(cc.wallet.address).catch(() => 0n);
  if (nat > 0n) out.push({ address: null, symbol: cc.nativeSymbol, decimals: 18, wei: nat });
  for (const b of cc.bases as BaseAsset[]) {
    if (!isStableBase(b.kind)) continue; // wrapped-native urusan /unwrap, bukan kirim
    const wei: bigint = await new ethers.Contract(b.address, ERC20_ABI, cc.provider)
      .balanceOf(cc.wallet.address)
      .catch(() => 0n);
    if (wei > 0n) out.push({ address: b.address, symbol: b.symbol, decimals: b.decimals, wei });
  }
  return out;
}

async function cmdSend(ctx: any) {
  flows.set(ctx.from.id, { awaitingAddress: true, startedAt: Date.now() });
  return ctx.reply(msg.msgSendAskAddress(), {
    ...html,
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel')]]),
  });
}
bot.command('send', cmdSend);

/** Alamat ditempel → pindai kelima chain, tawarkan yang ada isinya. */
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
  // Alamatnya sama di semua chain, jadi yang dipindai adalah SALDO KAMU per chain.
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
  const rows = usable.flatMap((f) =>
    f.assets.map((a) =>
      Markup.button.callback(
        `${f.cc.label} · ${fmtAmt(a.wei, a.decimals)} ${a.symbol}${f.isContract ? ' ⚠️' : ''}`,
        `snd:${f.cc.key}:${a.address ?? 'native'}`,
      ),
    ),
  );
  await editProgress(
    ctx,
    prog,
    msg.msgSendPickAsset(to, usable.map((f) => f.cc.label), found.some((f) => f.isContract)),
    { ...html, ...Markup.inlineKeyboard([...rows.map((r) => [r]), [Markup.button.callback('❌ Cancel', 'cancel')]]) },
  );
  return true;
}

bot.action(/^snd:(\w+):(native|0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const flow = flows.get(ctx.from!.id);
  if (!flow?.to) return ctx.answerCbQuery('Expired — start again with /send.');
  const cc = CHAINS[ctx.match[1]];
  if (!cc) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  // Bandingkan alamat huruf-kecil. Alamat base di chains.ts tak seragam kapitalnya
  // (USDG Robinhood tersimpan lowercase, sisanya checksummed), jadi membandingkan
  // string apa adanya membuat aset yang jelas-jelas ada terbaca "hilang".
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

/** Berapa yang benar-benar boleh dikirim: native disisihkan gasnya dulu. */
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
      usable: `${fmtAmt(usable, flow.asset!.decimals)} ${flow.asset!.symbol}`,
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

/** Ketikan nominal → kartu konfirmasi. Dipanggil penangan teks utama. */
export async function handleSendAmount(ctx: any, raw: string): Promise<boolean> {
  const flow = flows.get(ctx.from.id);
  if (!flow?.awaitingAmount || !flow.asset) return false;
  if (isStaleFlow(flow.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const cc = CHAINS[flow.chainKey!]!;
  const wei = parseAmt(raw, flow.asset.decimals);
  if (wei === null) {
    await ctx.reply(msg.msgInvalidAmount(), html);
    return true;
  }
  const usable = await sendableWei(cc, flow);
  if (wei <= 0n || wei > usable) {
    await ctx.reply(
      msg.msgError('send', `Amount exceeds what you can send (${fmtAmt(usable, flow.asset.decimals)} ${flow.asset.symbol}).`),
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
        [Markup.button.callback('✅ Confirm & Send', 'sndgo')],
        [Markup.button.callback('❌ Cancel', 'cancel')],
      ]),
    },
  );
}

bot.action('sndgo', async (ctx) => {
  const uid = ctx.from!.id;
  const flow = flows.get(uid);
  if (!flow?.amountWei || !flow.asset || !flow.to) return ctx.answerCbQuery('Expired — start again with /send.');
  if (sending.has(uid)) return ctx.answerCbQuery('Processing…');
  sending.add(uid);
  store.beginMoneyOp();
  const cc = CHAINS[flow.chainKey!]!;
  const { to, asset, amountWei } = flow;
  flows.delete(uid); // idempotency: hapus SEBELUM eksekusi (double-tap tak kirim dobel)
  await ctx.answerCbQuery('Sending…');
  try {
    const label = `${fmtAmt(amountWei, asset.decimals)} ${asset.symbol}`;
    if (config.safety.dryRun) {
      return void (await ctx.editMessageText(msg.msgSendDone({ to, chainLabel: cc.label, amount: label, txHash: null, dryRun: true }), html));
    }
    await ctx.editMessageText(msg.msgProgress(`sending ${label} on ${cc.label}…`), html).catch(() => {});
    const tx = asset.address
      ? await new ethers.Contract(asset.address, ERC20_ABI, cc.wallet).transfer(to, amountWei)
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
});
