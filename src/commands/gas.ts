import { ethers } from 'ethers';
import { Markup } from 'telegraf';
import { bot, html } from '../core.js';
import { CHAINS, type ChainCtx } from '../chains.js';
import { getEthUsd } from '../screening.js';
import { bold, esc, italic } from '../messages.js';

/**
 * /gas — what a transaction costs RIGHT NOW on each chain, in USD and Rupiah.
 *
 * The gas price comes from each chain's OWN PUBLIC ENDPOINT (the one its team
 * publishes), not from the Alchemy node the bot trades through. A provider node
 * answers `eth_gasPrice` from its own mempool view and its own pricing policy, so
 * two providers on the same chain disagree; the chain's own endpoint is the figure
 * the chain itself quotes. The bot's provider stays as the fallback, and a row says
 * which one answered so a fallback is never mistaken for the official number.
 *
 * The gas UNITS (not the price) come from the median of this wallet's real
 * transactions over 14 days, not a guess. Textbook estimates (21k for everything)
 * are wildly off: a single v4 modifyLiquidities burns >260k, and that happens to
 * be the operation used most.
 */

/**
 * Median gas per operation, measured from this wallet's OWN transaction receipts.
 *
 * Re-measured 8 Sep 2026 against 233 receipts labelled by the bot's own log
 * ([open] / [cashout] carry the tx hash, so an open is never mistaken for a
 * close — both are `modifyLiquidities` on v4 and the method name cannot tell
 * them apart), plus 45 swap and 45 approve receipts read across every chain:
 *
 *   Swap      327,175  (n=45)    was 280,000 — understated by 17%
 *   Open LP   444,746  (n=116)   was 447,000 — already right
 *   Close LP  299,432  (n=117)   was 267,000 — understated by 12%
 *   Approve    45,985  (n=45)    was  46,000 — already right
 *
 * Understating is the dangerous direction: it promises an operation is cheaper
 * than it is. To re-measure, join the tx hashes in the service log's [open] /
 * [cashout] lines to their receipts and take the median of `gasUsed`.
 */
const OPS: Array<[string, bigint]> = [
  ['Swap', 327_000n],
  ['Open LP', 445_000n],
  ['Close LP', 299_000n],
];

/** Cheap on every chain: not worth a ranked section each, but still shown in
 *  full. Collapsing them into "under RpX" would be a claim that quietly turns
 *  false the moment gas moves. */
const MINOR: Array<[string, bigint]> = [
  ['Send', 21_000n], // protocol constant, not a measurement
  ['Approve', 46_000n],
];

/** USD -> IDR rate. Indodax is PRIMARY (local crypto market, live): that is the
 *  rate you actually face when selling crypto for rupiah, and it moves by the
 *  second. The bank rate is the fallback; it only updates once a day. */
let idrCache: { v: number | null; t: number } = { v: null, t: 0 };

async function usdToIdr(): Promise<number | null> {
  if (Date.now() - idrCache.t < 300_000) return idrCache.v;
  const get = async (url: string, pick: (j: any) => unknown): Promise<number | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const n = Number(pick(await r.json()));
      return isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  const v =
    (await get('https://indodax.com/api/ticker/usdtidr', (j) => j?.ticker?.last)) ??
    (await get('https://open.er-api.com/v6/latest/USD', (j) => j?.rates?.IDR));
  idrCache = { v, t: Date.now() };
  return v;
}

/**
 * Each chain's own published RPC, by chainId. These are the endpoints the chain
 * teams themselves document -- deliberately NOT the .env ones, which all point at
 * Alchemy.
 */
const OFFICIAL_RPC: Record<number, string> = {
  4663: 'https://rpc.mainnet.chain.robinhood.com',
  56: 'https://bsc-dataseed.bnbchain.org',
  8453: 'https://mainnet.base.org',
  999: 'https://rpc.hyperliquid.xyz/evm',
  57073: 'https://rpc-gel.inkonchain.com',
};

/** eth_gasPrice straight from a URL. Raw fetch: one call, no provider to construct. */
async function rawGasPrice(url: string): Promise<bigint | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const hex = (await r.json())?.result;
    return typeof hex === 'string' ? BigInt(hex) : null;
  } catch {
    return null;
  }
}

/** The effective gas price that will be paid, and where the figure came from. */
async function gasPriceOf(cc: ChainCtx): Promise<{ price: bigint; official: boolean } | null> {
  const url = OFFICIAL_RPC[cc.chainId];
  if (url) {
    const p = await rawGasPrice(url);
    if (p !== null && p > 0n) return { price: p, official: true };
  }
  // Fallback only. Flagged, because an unflagged fallback would quietly claim to be
  // the chain's own number while coming from the trading provider.
  try {
    const f = await cc.provider.getFeeData();
    const p = f.gasPrice ?? f.maxFeePerGas ?? null;
    return p === null ? null : { price: p, official: false };
  } catch {
    return null;
  }
}

const gwei = (wei: bigint): string => {
  const g = Number(ethers.formatUnits(wei, 'gwei'));
  return g >= 1 ? g.toFixed(2) : g.toPrecision(2);
};

/**
 * A cost in dollars, always with meaningful digits.
 *
 * Fixed rounding (5 decimals) prints "$0" for the cheapest operations, and "$0"
 * is a lie: the gas is still paid, it is just too small for the format. Below a
 * cent this switches to 3 significant figures, so $0.0000045 reads as itself.
 */
const usd = (v: number): string => {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  if (v === 0) return '$0';
  return `$${Number(v.toPrecision(3))}`;
};

const idr = (v: number): string =>
  `Rp${Math.round(v).toLocaleString('id-ID')}`;

type Row = { label: string; usd: number | null; native: number; sym: string };

/** Every operation's cost on one chain. `null` means that chain's RPC did not answer. */
async function costsOf(cc: ChainCtx): Promise<{ label: string; gwei: string; nativeUsd: number | null; official: boolean; rows: Map<string, Row> } | null> {
  const [src, nativeUsd] = await Promise.all([gasPriceOf(cc), getEthUsd(cc.wethAddress, cc).catch(() => null)]);
  if (src === null) return null;
  const price = src.price;
  const rows = new Map<string, Row>();
  for (const [label, units] of [...OPS, ...MINOR]) {
    const native = Number(ethers.formatEther(price * units));
    rows.set(label, { label, usd: nativeUsd === null ? null : native * nativeUsd, native, sym: cc.nativeSymbol });
  }
  return { label: cc.label, gwei: gwei(price), nativeUsd, official: src.official, rows };
}

type Chain = NonNullable<Awaited<ReturnType<typeof costsOf>>>;

/** One section: chains ranked cheapest first for this operation.
 *  A chain with no native price is left OUT of the ranking — ordering it would
 *  need the very USD figure we lack — and listed below with its cost in native
 *  units instead. */
function section(op: string, chains: Chain[], rate: number | null): string[] {
  const withUsd = chains.filter((c) => c.rows.get(op)!.usd !== null).sort((a, b) => a.rows.get(op)!.usd! - b.rows.get(op)!.usd!);
  const noUsd = chains.filter((c) => c.rows.get(op)!.usd === null);
  const lines = withUsd.map((c, i) => {
    const r = c.rows.get(op)!;
    return `${i + 1}. ${esc(c.label)} = ${bold(usd(r.usd!))} / ${bold(rate ? idr(r.usd! * rate) : '—')}`;
  });
  for (const c of noUsd) {
    const r = c.rows.get(op)!;
    lines.push(`— ${esc(c.label)} = ${bold(`${r.native.toFixed(6)} ${r.sym}`)} ${italic('(no USD price)')}`);
  }
  return [bold(op.toUpperCase()), ...lines];
}

/** The whole card. Exported so it can be tested without Telegram (scripts/smoke-gas.ts). */
export async function gasCard(): Promise<string> {
  const rate = await usdToIdr();
  const all = await Promise.all(Object.values(CHAINS).map(async (cc) => [cc.label, await costsOf(cc)] as const));
  const chains = all.filter((x): x is readonly [string, Chain] => x[1] !== null).map((x) => x[1]);
  const down = all.filter((x) => x[1] === null).map((x) => x[0]);

  if (!chains.length)
    return [bold('⛽️ GAS FEE'), '', italic('No chain responded — every RPC is down. Try again shortly.')].join('\n');

  return [
    bold('⛽️ GAS FEE'),
    '',
    ...OPS.flatMap(([op]) => [...section(op, chains, rate), '']),
    // SEND & APPROVE is pinned to APPROVE, the dearer of the two. Using Send
    // (21k) in a section called "Send & Approve" would understate half of what it
    // promises by 55%.
    ...section('Approve', chains, rate).map((l, i) => (i === 0 ? bold('SEND & APPROVE') : l)),
    '',
    ...(down.length ? [italic(`Unreachable: ${down.join(', ')}`), ''] : []),
    // Silence here would mean "all official". Name the exceptions instead.
    ...(() => {
      const fb = chains.filter((c) => !c.official).map((c) => c.label);
      return fb.length ? [italic(`Chain endpoint down, provider used: ${esc(fb.join(', '))}`), ''] : [];
    })(),
    // The footer carries the date, time and zone, nothing else (owner's call).
    // The rate and an approve note once hitched a ride here and turned it into a
    // catch-all line.
    italic(clock()),
  ].join('\n');
}

/** Read time plus server zone. This is what makes Refresh HONEST: without it,
 *  tapping the button while gas has not moved produces an identical message,
 *  Telegram rejects the edit ("not modified"), and the card sits there looking
 *  like a broken button. */
function clock(): string {
  const d = new Date();
  const tanggal = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${tanggal} · ${d.toLocaleTimeString('en-GB', { hour12: false })} ${offsetLabel()}`;
}

/** One button: re-read every chain. */
export const gasKeyboard = () => Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'gas:refresh')]]);

/** Server timezone label, so the time on the card is not ambiguous. */
function offsetLabel(): string {
  const m = -new Date().getTimezoneOffset();
  if (m === 0) return 'UTC';
  const sign = m > 0 ? '+' : '-';
  return `UTC${sign}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
}

bot.command('gas', async (ctx) => {
  const wait = await ctx.reply('⛽ Reading gas from each chain…');
  const text = await gasCard();
  const opts = { ...html, ...gasKeyboard() };
  await ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, text, opts).catch(async () => {
    await ctx.reply(text, opts);
  });
});

bot.action('gas:refresh', async (ctx) => {
  await ctx.answerCbQuery('Reading gas…');
  try {
    await ctx.editMessageText(await gasCard(), { ...html, ...gasKeyboard() });
  } catch (e) {
    // "message is not modified" just means the numbers have not moved. Not a failure.
    if (!/not modified/i.test((e as Error).message)) throw e;
  }
});
