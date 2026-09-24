import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { config } from '../config.js';
import { bot, html, editProgress, parseAmt, isStaleFlow, registerFlowReset, sendTxNonceSafe } from '../core.js';
import { CHAINS, isStableBase, txButtons, type ChainCtx, type BaseKind } from '../chains.js';
import { TRADE_LIMIT_PCT } from '../tradeLimit.js';
import { ERC20_ABI } from '../chain.js';
import * as store from '../store.js';
import * as pctPresets from '../pctPresets.js';
import * as msg from '../messages.js';
import * as solWallet from '../solana/walletStore.js';
import { solBalance } from '../solana/jupiter.js';
import { rpcUrl } from '../solana/rpc.js';
import { highPriorityMicro, broadcastOfficial } from '../solana/fees.js';
import { solUsd } from '../solana/holdings.js';
import { getEthUsd } from '../screening.js';

/** Gas actually burned by these EVM transactions, in dollars. null when unreadable. */
export async function evmGasUsd(cc: ChainCtx, hashes: string[]): Promise<number | null> {
  try {
    let wei = 0n;
    for (const rc of await Promise.all(hashes.map((h) => cc.provider.getTransactionReceipt(h)))) if (rc) wei += rc.gasUsed * (rc.gasPrice ?? 0n);
    if (wei === 0n) return null;
    const px = cc.hasWethBase ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : 1;
    return px ? Number(ethers.formatEther(wei)) * px : null;
  } catch {
    return null;
  }
}

/** The network fee of these Solana transactions, in dollars. */
async function solGasUsd(sigs: string[]): Promise<number | null> {
  try {
    const conn = new Connection(rpcUrl()!, 'confirmed');
    let lam = 0;
    for (const s of sigs) lam += (await conn.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }))?.meta?.fee ?? 0;
    const px = await solUsd().catch(() => null);
    return lam && px ? (lam / 1e9) * px : null;
  } catch {
    return null;
  }
}

/**
 * /bridge between an EVM chain and Solana, through Relay (the only provider that quoted
 * all four directions Robinhood/BSC <-> Solana on 24 Sep 2026; LI.FI has no Robinhood).
 * Same rules as the EVM bridge: it goes the moment the amount is set, refused above the
 * 3% impact limit, one in flight per user.
 */

const RELAY_API = 'https://api.relay.link/quote';
const SOL_CHAIN_ID = 792703809;
const SOL_NATIVE = '11111111111111111111111111111111';
const EVM_NATIVE = '0x0000000000000000000000000000000000000000';
/** SOL kept back: the deposit fee, plus rent for any account the fill touches. */
const SOL_RESERVE = 10_000_000n;
const GAS_RESERVE_WEI = ethers.parseEther('0.0005');

type Dir = 'in' | 'out'; // in = EVM -> Solana, out = Solana -> EVM
type Flow = { key: string; dir: Dir; kind: BaseKind; awaitingAmount: boolean; startedAt: number };
const flows = new Map<number, Flow>();
const inFlight = new Set<number>();
registerFlowReset((uid) => flows.delete(uid));
/** Opening the /bridge menu drops a half-finished Solana bridge, so a typed number cannot reach it. */
export const clearSolBridge = (uid: number): void => void flows.delete(uid);

/** EVM chains Relay carries to and from Solana. */
export function solBridgeChains(): ChainCtx[] {
  if (!config.solana.enabled || !solWallet.address()) return [];
  return Object.values(CHAINS).filter((c) => c.key === 'robinhood' || c.key === 'bsc');
}

const baseOf = (cc: ChainCtx, kind: BaseKind) => cc.bases.find((b) => b.kind === kind)!;
const symOf = (cc: ChainCtx, kind: BaseKind) => (kind === 'weth' ? cc.nativeSymbol : baseOf(cc, kind).symbol);
const evmCurrency = (cc: ChainCtx, kind: BaseKind) => (kind === 'weth' ? EVM_NATIVE : baseOf(cc, kind).address);
const decOf = (cc: ChainCtx, kind: BaseKind) => (kind === 'weth' ? 18 : baseOf(cc, kind).decimals);

async function evmBalance(cc: ChainCtx, kind: BaseKind): Promise<bigint> {
  if (kind === 'weth') return cc.provider.getBalance(cc.wallet.address).catch(() => 0n);
  return new ethers.Contract(baseOf(cc, kind).address, ERC20_ABI, cc.provider).balanceOf(cc.wallet.address).catch(() => 0n);
}

async function relayQuote(cc: ChainCtx, dir: Dir, kind: BaseKind, amount: bigint): Promise<any> {
  const sol = solWallet.address()!;
  const evm = cc.wallet.address;
  const body =
    dir === 'in'
      ? { user: evm, recipient: sol, originChainId: cc.chainId, destinationChainId: SOL_CHAIN_ID, originCurrency: evmCurrency(cc, kind), destinationCurrency: SOL_NATIVE }
      : { user: sol, recipient: evm, originChainId: SOL_CHAIN_ID, destinationChainId: cc.chainId, originCurrency: SOL_NATIVE, destinationCurrency: evmCurrency(cc, kind) };
  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, amount: amount.toString(), tradeType: 'EXACT_INPUT' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.steps) throw new Error(`Relay has no route right now: ${String(j.message ?? res.status).slice(0, 120)}`);
  return j;
}

/** Sign and land Relay's Solana deposit: its instructions, its lookup tables, our fee bid. */
async function sendSolDeposit(data: any): Promise<string> {
  const kp = solWallet.keypair();
  if (!kp) throw new Error('No Solana key connected.');
  const url = rpcUrl();
  if (!url) throw new Error('No Solana RPC configured.');
  const conn = new Connection(url, 'confirmed');
  const user = Keypair.fromSeed(Buffer.from(kp.seed));
  const ixs: TransactionInstruction[] = (data.instructions as any[]).map(
    (i) =>
      new TransactionInstruction({
        programId: new PublicKey(i.programId),
        keys: i.keys.map((k: any) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(String(i.data).replace(/^0x/, ''), 'hex'),
      }),
  );
  const alts = (
    await Promise.all(((data.addressLookupTableAddresses ?? []) as string[]).map((a) => conn.getAddressLookupTable(new PublicKey(a))))
  )
    .map((r) => r.value)
    .filter((v): v is AddressLookupTableAccount => !!v);
  const micro = Math.max(50_000, (await highPriorityMicro())?.micro ?? 0);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }), ...ixs],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(message);
  tx.sign([user]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 3 });
  const b64 = Buffer.from(raw).toString('base64');
  broadcastOfficial(b64);
  const resend = setInterval(() => {
    conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    broadcastOfficial(b64);
  }, 2_000);
  try {
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (r.value.err) throw new Error(`the deposit failed on-chain (${sig})`);
  } finally {
    clearInterval(resend);
  }
  return sig;
}

// Route picked: which asset leaves (EVM -> SOL) or lands (SOL -> EVM).
bot.action(/^brs:(\w+):(in|out)$/, async (ctx) => {
  const cc = CHAINS[ctx.match[1]];
  if (!cc) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  const dir = ctx.match[2] as Dir;
  const kinds = cc.bases.filter((b) => b.kind === 'weth' || isStableBase(b.kind)).map((b) => b.kind);
  const rows = kinds.map((k) => [
    Markup.button.callback(dir === 'in' ? `${symOf(cc, k)} → SOL` : `SOL → ${symOf(cc, k)}`, `brsa:${cc.key}:${dir}:${k}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'br:back'), Markup.button.callback('❌ Cancel', 'cancel')]);
  const [a, b] = dir === 'in' ? [cc.label, 'Solana'] : ['Solana', cc.label];
  await ctx.editMessageText(msg.msgBridgeAsset(a, b), { ...html, ...Markup.inlineKeyboard(rows) });
});

bot.action(/^brsa:(\w+):(in|out):(\w+)$/, async (ctx) => {
  const cc = CHAINS[ctx.match[1]];
  if (!cc) return ctx.answerCbQuery('Chain unavailable.');
  await ctx.answerCbQuery();
  const dir = ctx.match[2] as Dir;
  const kind = ctx.match[3] as BaseKind;
  flows.set(ctx.from!.id, { key: cc.key, dir, kind, awaitingAmount: true, startedAt: Date.now() });
  const [a, b] = dir === 'in' ? [cc.label, 'Solana'] : ['Solana', cc.label];
  const bal =
    dir === 'in'
      ? `${Number(ethers.formatUnits(await evmBalance(cc, kind), decOf(cc, kind))).toFixed(6)} ${symOf(cc, kind)}`
      : `${(Number(await solBalance(solWallet.address()!).catch(() => 0n)) / 1e9).toFixed(4)} SOL`;
  await ctx.editMessageText(msg.msgBridgeAmount(a, b, bal, dir === 'in' ? symOf(cc, kind) : 'SOL'), {
    ...html,
    ...Markup.inlineKeyboard([
      ...pctPresets.chunkButtons(pctPresets.get('bridge').map((p) => Markup.button.callback(`${p}%`, `brsp:${p}`))),
      [Markup.button.callback('⬅️ Back', `brs:${cc.key}:${dir}`), Markup.button.callback('❌ Cancel', 'cancel')],
    ]),
  });
});

/** What can leave: the balance less what must stay behind to pay for sending it. */
async function usable(f: Flow): Promise<bigint> {
  const cc = CHAINS[f.key]!;
  if (f.dir === 'out') {
    const b = await solBalance(solWallet.address()!).catch(() => 0n);
    return b > SOL_RESERVE ? b - SOL_RESERVE : 0n;
  }
  const b = await evmBalance(cc, f.kind);
  if (f.kind !== 'weth') return b;
  return b > GAS_RESERVE_WEI ? b - GAS_RESERVE_WEI : 0n;
}

bot.action(/^brsp:(\d+)$/, async (ctx) => {
  const f = flows.get(ctx.from!.id);
  if (!f?.awaitingAmount) return ctx.answerCbQuery('Expired. Start again with /bridge.');
  await ctx.answerCbQuery();
  const u = await usable(f);
  const pct = Number(ctx.match[1]);
  const amt = pct >= 100 ? u : (u * BigInt(pct)) / 100n;
  if (amt <= 0n) return ctx.reply(msg.msgError('bridge', 'Nothing left to bridge after the fee reserve.'), html);
  return run(ctx, f, amt);
});

/** A typed amount. Called from the text handler in index.ts. */
export async function handleSolBridgeAmount(ctx: any, raw: string): Promise<boolean> {
  const f = flows.get(ctx.from.id);
  if (!f?.awaitingAmount) return false;
  if (isStaleFlow(f.startedAt)) {
    flows.delete(ctx.from.id);
    await ctx.reply(msg.msgSessionExpired(), html);
    return true;
  }
  const cc = CHAINS[f.key]!;
  const amt = parseAmt(raw, f.dir === 'out' ? 9 : decOf(cc, f.kind));
  if (amt === null) {
    await ctx.reply(msg.msgInvalidAmount(), html);
    return true;
  }
  await run(ctx, f, amt);
  return true;
}

async function run(ctx: any, f: Flow, amount: bigint): Promise<void> {
  const uid = ctx.from.id;
  if (inFlight.has(uid)) return;
  const cc = CHAINS[f.key]!;
  const prog = await ctx.reply(msg.msgProgress('requesting bridge quote…'), html);
  if (amount > (await usable(f))) {
    await editProgress(ctx, prog, msg.msgError('bridge', 'That is more than you can send after the fee reserve.'));
    return;
  }
  if (f.dir === 'in' && f.kind !== 'weth' && (await evmBalance(cc, 'weth')) < GAS_RESERVE_WEI) {
    await editProgress(ctx, prog, msg.msgError('bridge', `Not enough ${cc.nativeSymbol} for gas on ${cc.label}.`));
    return;
  }
  inFlight.add(uid);
  flows.delete(uid); // before sending: a double tap must not bridge twice
  store.beginMoneyOp();
  try {
    const q = await relayQuote(cc, f.dir, f.kind, amount);
    const d = q.details ?? {};
    const impact = d.totalImpact?.percent != null ? Math.abs(Number(d.totalImpact.percent)) : null;
    if (impact !== null && impact > TRADE_LIMIT_PCT) {
      await editProgress(ctx, prog, msg.msgError('bridge', `Price impact is ${impact.toFixed(1)}%, above the ${TRADE_LIMIT_PCT}% limit. Nothing was sent. Try a larger amount.`));
      return;
    }
    const fmt = (c: any) => `${Number(c?.amountFormatted ?? 0).toFixed(6)} ${c?.currency?.symbol ?? ''}`;
    const inLabel = fmt(d.currencyIn);
    const outLabel = fmt(d.currencyOut);
    const [a, b] = f.dir === 'in' ? [cc.label, 'Solana'] : ['Solana', cc.label];
    if (config.safety.dryRun) {
      await editProgress(ctx, prog, msg.msgBridgeDone({ fromLabel: a, toLabel: b, inLabel, outLabel, txHashes: [], dryRun: true }));
      return;
    }
    await editProgress(ctx, prog, msg.msgProgress(`bridging ${inLabel} → ${outLabel}…`));
    const hashes: string[] = [];
    for (const st of q.steps) {
      for (const it of st.items ?? []) {
        if (f.dir === 'out') {
          hashes.push(await sendSolDeposit(it.data));
        } else if (it.data?.to) {
          const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, { to: it.data.to, data: it.data.data, value: BigInt(it.data.value ?? '0') });
          const rc = await tx.wait();
          hashes.push(rc?.hash ?? tx.hash);
        }
      }
    }
    console.log(`[bridge-sol] ${a}→${b} ${inLabel} → ${outLabel} tx ${hashes.join(',')}`);
    const inUsd = Number(d.currencyIn?.amountUsd), outUsd = Number(d.currencyOut?.amountUsd);
    const bridgeFeeUsd = isFinite(inUsd) && isFinite(outUsd) ? Math.max(0, inUsd - outUsd) : null;
    const gasUsd = f.dir === 'out' ? await solGasUsd(hashes) : await evmGasUsd(cc, hashes);
    await editProgress(ctx, prog, msg.msgBridgeDone({ fromLabel: a, toLabel: b, inLabel, outLabel, txHashes: hashes, dryRun: false, bridgeFeeUsd, gasUsd }), {
      ...html,
      ...Markup.inlineKeyboard([
        ...txButtons(f.dir === 'out' ? 'solana' : cc.key, hashes).map((r) => r.map((x) => Markup.button.url(x.text, x.url))),
        // Relay's page follows the fill to the destination chain as well.
        ...(hashes[0] ? [[Markup.button.url('🌉 Track on Relay', `https://relay.link/transaction/${hashes[hashes.length - 1]}`)]] : []),
      ]),
    });
  } catch (e) {
    await editProgress(ctx, prog, msg.msgError('bridge', (e as Error).message));
  } finally {
    inFlight.delete(uid);
    store.endMoneyOp();
  }
}
