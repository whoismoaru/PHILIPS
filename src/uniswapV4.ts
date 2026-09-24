import { ethers } from 'ethers';
import { TickMath, nearestUsableTick } from '@uniswap/v3-sdk';
import { isStableBase, type ChainCtx } from './chains.js';
import { EXPLORER_HEADERS } from './chain.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust } from './relay.js';
import { sendTxNonceSafe, mapLimit } from './core.js';
import { amountsForLiquidity, withdrawFloors } from './lpmath.js';
import { allV4 } from './v4store.js';

const Q96 = 2n ** 96n;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// The v4 PoolManager singleton, per chain.
const V4_POOL_MANAGER: Record<string, string> = {
  robinhood: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  bsc: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF',
  // Verified on-chain before adding: both contracts carry code on Base, and the
  // PositionManager's own poolManager() returns exactly this address -- so the pair is
  // matched rather than two addresses that merely look right.
  base: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  // Arc, from @uniswap/sdk-core and verified on-chain (48,020 bytes of code; the Arc
  // PositionManager's poolManager() returns exactly this). Arc shares its PoolManager
  // address with Robinhood -- same deployer, same salt, different chain.
  arc: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
};
// Extra v4 actions (add).
const MINT_POSITION = 0x02;
const SETTLE_PAIR = 0x0d;
const SWEEP = 0x14;

/**
 * Read-only access to Uniswap **v4** positions (a different architecture from v3: a
 * singleton PoolManager plus a PositionManager NFT). PHILIPS manages v3; this module
 * only DISPLAYS the v4 positions a wallet holds (opened through the UI or CLI, say)
 * so /positions mirrors what is on-chain. tokenIds are enumerated through Blockscout
 * (the v4 PM is not ERC721Enumerable, so there is no tokenOfOwnerByIndex); details
 * come from RPC.
 */

// The Uniswap v4 PositionManager per chain. Absent means v4 is unsupported there.
const V4_PM: Record<string, string> = {
  robinhood: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  bsc: '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b',
  base: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  // Arc, verified on-chain: 47,756 bytes, poolManager() and permit2() both resolve.
  arc: '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B',
};

/**
 * Contract addresses are normalised AT MODULE LOAD.
 *
 * ethers rejects an address whose checksum is wrong, and pool reads are wrapped in
 * `.catch(() => 0n)` — so one wrong capital letter surfaces not as an error but as
 * "zero liquidity", quietly discarding EVERY pool on that chain. Normalising here
 * makes a typo fail loudly at startup instead of masquerading as a dead pool.
 */
for (const table of [V4_PM, V4_POOL_MANAGER]) {
  for (const [k, v] of Object.entries(table)) table[k] = ethers.getAddress(v.toLowerCase());
}

/**
 * This chain's stablecoin base. The module used to hardcode USDG (the only v4 chain
 * at the time), so enabling v4 on BSC left USDT pools unrecognised as single-sided
 * candidates. Now it comes from the chain's own base list.
 */
export function stableOf(cc: ChainCtx): { addr: string; symbol: string; decimals: number } | null {
  const b = cc.bases.find((x) => isStableBase(x.kind));
  return b ? { addr: b.address, symbol: b.symbol, decimals: b.decimals } : null;
}
/** The CORRECT base symbol for this chain, used by cards and labels. */
export function v4BaseSymbol(cc: ChainCtx, base: 'ETH' | 'USDG' | null): string {
  if (base === 'ETH') return cc.nativeSymbol;
  return base === 'USDG' ? (stableOf(cc)?.symbol ?? 'USD') : '';
}
/** v4 base decimals on this chain (stable is 18 on BSC, 6 on Robinhood — never hardcode). */
export function v4BaseDecimals(cc: ChainCtx, base: 'ETH' | 'USDG' | null): number {
  return base === 'USDG' ? (stableOf(cc)?.decimals ?? 6) : 18;
}

const DYNAMIC_FEE_FLAG = 0x800000; // v4: the flag marking a dynamic fee

/**
 * Probe for the automatic retry: has an operation ALREADY landed on chain?
 * -1n means it cannot be determined (v4 unsupported, or the RPC failed), and the
 * caller MUST treat that as "it may have landed" and not retry.
 */
export async function v4PositionCount(cc: ChainCtx): Promise<bigint> {
  const addr = V4_PM[cc.key];
  if (!addr) return -1n;
  const c = new ethers.Contract(addr, ['function balanceOf(address) view returns (uint256)'], cc.provider);
  return (await c.balanceOf(cc.wallet.address)) as bigint;
}

/** A v4 position's liquidity. A change means decreaseLiquidity has landed. */
export async function v4Liquidity(cc: ChainCtx, tokenId: string): Promise<bigint> {
  const addr = V4_PM[cc.key];
  if (!addr) return -1n;
  const c = new ethers.Contract(addr, V4_ABI, cc.provider);
  return BigInt(await c.getPositionLiquidity(tokenId));
}

/**
 * Prove the close actually happened, on-chain, before anything is journalled or untracked.
 *
 * On 20 Sep 2026 a BSC v4 close reported "✅ POSITION CLOSED" for a transaction that had
 * REVERTED. The card carried its hash, the position was dropped from tracking, and
 * the position stayed alive with 9179.88 units of liquidity still owned by the
 * wallet: money in a live LP that PHILIPS no longer knew about. The only reason the bot
 * believed it had closed was that closePositionV4 returned without throwing.
 *
 * So returning is not evidence. The burn is evidence. This reads the liquidity back and
 * refuses to call anything closed while it is still there, whatever the transaction
 * receipt claimed.
 *
 * The test is deliberately one-sided: only LIQUIDITY STILL PRESENT counts as proof of
 * failure. A burned position makes getPositionLiquidity revert, and so does an RPC that is
 * simply down, so "unreadable" cannot be told apart from "successfully burned" and must
 * never be treated as either. Unreadable therefore changes nothing and the close proceeds
 * exactly as it did before this check existed. That keeps the guard strictly additive: it
 * can only catch the proven failure, never invent a new one.
 */
export async function v4StillOpen(cc: ChainCtx, tokenIds: string[]): Promise<string[]> {
  const reads = await Promise.all(
    tokenIds.map(async (id) => ({ id, liq: await v4Liquidity(cc, id).catch(() => -1n) })),
  );
  return reads.filter((r) => r.liq > 0n).map((r) => r.id);
}

const V4_ABI = [
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
];
const ERC20_SYM = ['function symbol() view returns (string)'];

export type V4Position = {
  tokenId: string;
  sym0: string;
  sym1: string;
  fee: number; // raw; 0x800000 = dynamic
  dynamicFee: boolean;
  hasHooks: boolean;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  base: 'ETH' | 'USDG' | null; // the pair's base asset, for adds and cash-outs
  poolKey: PoolKeyV4;
  valueBaseWei: bigint | null; // the PRINCIPAL in the base, null when the price could not be read
  feesBaseWei: bigint | null; // unclaimed fees, in the base
  rangePctHigh: number | null; // the near end as a % of the current price
  rangePctLow: number | null;
  inRange: boolean | null;
  currentTick: number | null; // the pool's current tick; the card uses it for the "now" mcap
  converted: boolean; // out-of-range & 100% token seberang (target tercapai)
  impliedTokenEthPrice: number | null; // the token price in ETH according to THIS pool's slot0, used to spot a dying pool
  // How much of the OTHER token this position holds. `valueBaseWei` marks it at the
  // current pool price, and that is NOT what you would receive: selling it moves the
  // price. The card uses this figure to request a real quote before calling anything
  // a "value".
  otherAmountWei: bigint | null;
  otherAddress: string | null;
  otherDecimals: number | null;
  baseAmountWei: bigint | null; // the base side held, which never needs selling
};

/** Work out the pair's base asset, and whether the base is currency0. */
function pairBase(cc: ChainCtx, cur0: string, cur1: string): { base: 'ETH' | 'USDG' | null; baseIsCurrency0: boolean } {
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const st = stableOf(cc);
  const isUsdg = (a: string) => !!st && a.toLowerCase() === st.addr.toLowerCase();
  if (isEth(cur0)) return { base: 'ETH', baseIsCurrency0: true };
  if (isEth(cur1)) return { base: 'ETH', baseIsCurrency0: false };
  if (isUsdg(cur0)) return { base: 'USDG', baseIsCurrency0: true };
  if (isUsdg(cur1)) return { base: 'USDG', baseIsCurrency0: false };
  return { base: null, baseIsCurrency0: true };
}

export function v4Supported(cc: ChainCtx): boolean {
  // Blockscout is no longer a requirement: enumeration has an indexer-free path
  // (nextTokenId + ownerOf), and positions the bot opens are always recorded
  // locally. Without an indexer the only thing missing is a v4 position opened
  // OUTSIDE the bot — and /positions already says the list may be incomplete.
  return !!V4_PM[cc.key];
}

// Token symbols and decimals NEVER change, so the cache is permanent. Without it,
// /positions on a 69-leg pool fired ~207 repeat RPCs for identical metadata.
const symCache = new Map<string, string>();
const decCache = new Map<string, number>();

export async function tokenSymbol(addr: string, cc: ChainCtx): Promise<string> {
  if (!addr || addr === ethers.ZeroAddress) return 'ETH'; // native currency0
  const key = `${cc.key}:${addr.toLowerCase()}`;
  const hit = symCache.get(key);
  if (hit !== undefined) return hit;
  let v: string;
  try {
    v = await new ethers.Contract(addr, ERC20_SYM, cc.provider).symbol();
  } catch {
    v = addr.slice(0, 6);
  }
  symCache.set(key, v);
  return v;
}

async function tokenDecimals(addr: string, cc: ChainCtx): Promise<number> {
  if (!addr || addr === ethers.ZeroAddress) return 18; // native ETH
  const key = `${cc.key}:${addr.toLowerCase()}`;
  const hit = decCache.get(key);
  if (hit !== undefined) return hit;
  let v: number;
  try {
    v = Number(await new ethers.Contract(addr, ['function decimals() view returns (uint8)'], cc.provider).decimals());
  } catch {
    v = 18;
  }
  decCache.set(key, v);
  return v;
}

/** v4 NFT tokenIds held by the wallet (via Blockscout). */
/** true when indexer enumeration failed on the last call, so the list may be incomplete. */
let enumDegraded = false;
export function v4ListDegraded(): boolean {
  return enumDegraded;
}

// Full-range eth_getLogs, which the wallet's own RPC refuses: Alchemy's free tier
// caps the range at 10 blocks, and Robinhood is ~1.5M blocks a day. The chain's
// public RPC answers the same query over all 58M blocks in under a second.
const LOGS_RPC: Record<string, string> = {
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
  // Arc is deliberately ABSENT. Its public endpoint prunes history ("pruned history
  // unavailable"), so a scan from block 0 can never succeed there, and Alchemy's free tier
  // caps the range at 10 blocks. The bot's own v4 records still answer /positions; what is
  // lost is only finding a position opened OUTSIDE the bot, and a call that is certain to
  // fail is worse than not making it.
};
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
// Scans are incremental: the first one walks the whole chain, later ones resume from
// where the last left off. The public RPC rate-limits full-range queries (observed
// 429 after a handful in a row), and /positions is called often.
const enumCache = new Map<string, { block: number; ids: Set<string> }>();
/**
 * When the scan FAILS, stop hammering it.
 *
 * The cursor only advances on success, so a failing endpoint was re-scanned in full on
 * every single call -- each /positions tap paying the same 8-12 second timeout. The list
 * still answers from the bot's own records during the cool-down, and still says it is
 * degraded, so nothing is hidden; it simply stops charging the owner for a retry that has
 * just failed.
 */
const ENUM_COOLDOWN_MS = 60_000;
const enumCooldown = new Map<string, number>();

/** Forget the incremental scan state and walk the chain again from block 0. */
export function resetV4EnumCache(): void {
  enumCache.clear();
}

/**
 * A full-range eth_getLogs against a PUBLIC endpoint, with a hard ceiling on how long a
 * button may wait for it. Measured on 15 Sep 2026: with no timeout this call sat for 8.7 s
 * ("context deadline exceeded") and then for 12.3 s on the next tap, and every /positions
 * tap paid it again. The tap has to answer either way, so cap the wait and fall back.
 */
const LOGS_TIMEOUT_MS = 4_000;

async function logsRpc(url: string, params: unknown): Promise<any[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...EXPLORER_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [params] }),
    signal: AbortSignal.timeout(LOGS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`logs HTTP ${res.status}`);
  const j: any = await res.json();
  if (j.error) throw new Error(String(j.error.message ?? 'logs error').slice(0, 80));
  return j.result ?? [];
}

export async function walletV4TokenIds(cc: ChainCtx): Promise<string[]> {
  const pm = V4_PM[cc.key];
  if (!pm) return [];
  // Positions the bot manages are ALWAYS included: if enumeration is down or lagging,
  // your v4 positions must not vanish from /positions (catch->[] used to make them
  // flicker as "out of sync").
  const ids = new Set(allV4().filter((r) => r.chain === cc.key).map((r) => r.tokenId));
  const rpc = LOGS_RPC[cc.key];
  if (!rpc) return [...ids];

  const w = ethers.zeroPadValue(cc.wallet.address, 32);
  const cache = enumCache.get(cc.key);
  const until = enumCooldown.get(cc.key) ?? 0;
  if (Date.now() < until) {
    enumDegraded = true;
    if (cache) for (const id of cache.ids) ids.add(id);
    return [...ids];
  }
  const scanFrom = cache ? cache.block + 1 : 0;
  try {
    const scanTo = await cc.provider.getBlockNumber();
    if (cache && scanFrom > scanTo) {
      enumDegraded = false;
      for (const id of cache.ids) ids.add(id);
      return [...ids];
    }
    const range = { fromBlock: '0x' + scanFrom.toString(16), toBlock: '0x' + scanTo.toString(16), address: pm };
    const [incoming, outgoing] = await Promise.all([
      logsRpc(rpc, { ...range, topics: [TRANSFER_TOPIC, null, w] }),
      logsRpc(rpc, { ...range, topics: [TRANSFER_TOPIC, w, null] }),
    ]);
    // An NFT can leave and come back, so the LAST event per tokenId decides ownership.
    // Ordering by (block, logIndex) is what makes a mint-then-burn in one transaction
    // resolve correctly.
    const ev = [
      ...incoming.map((l) => [Number(l.blockNumber), Number(l.logIndex), l.topics[3], true] as const),
      ...outgoing.map((l) => [Number(l.blockNumber), Number(l.logIndex), l.topics[3], false] as const),
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const ownedNow = new Map<string, boolean>(cache ? [...cache.ids].map((i) => [i, true]) : []);
    for (const [, , topic, isIncoming] of ev) ownedNow.set(BigInt(topic).toString(), isIncoming);
    const owned = new Set([...ownedNow].filter(([, v]) => v).map(([k]) => k));
    enumCache.set(cc.key, { block: scanTo, ids: owned });
    enumCooldown.delete(cc.key); // it works again, so stop holding it back
    for (const id of owned) ids.add(id);
    enumDegraded = false;
  } catch (e) {
    // Do not swallow this: an enumeration failure that v4store happened to cover has
    // to be visible. And not only in the server log -- whoever is looking at
    // /positions needs to know the list may be incomplete.
    enumDegraded = true;
    enumCooldown.set(cc.key, Date.now() + ENUM_COOLDOWN_MS);
    console.log(
      `[v4] log enumeration failed, falling back to v4store alone (retry in ${ENUM_COOLDOWN_MS / 1000}s):`,
      (e as Error).message.slice(0, 100),
    );
    if (cache) for (const id of cache.ids) ids.add(id);
  }
  return [...ids];
}

const signExt24 = (v: bigint): number => Number(v >= 1n << 23n ? v - (1n << 24n) : v);

// v4 Actions (v4-periphery libraries/Actions.sol)
const DECREASE_LIQUIDITY = 0x01;
const BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;
// Used only by the escape hatch below: forfeit one currency's dust (CLEAR_OR_TAKE) and
// take the other outright (TAKE). Codes from v4-periphery's Actions.sol -- note that this
// PositionManager build rejects TAKE_ALL (0x0f) with UnsupportedAction, so TAKE it is.
const CLEAR_OR_TAKE = 0x13;
const TAKE = 0x0e;
const V4_WRITE_ABI = [
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function ownerOf(uint256) view returns (address)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
];

/** Note attached to the close card when a v4 burn had to run without a price floor. */
export const V4_UNPROTECTED_NOTE = (ids: string) =>
  `⚠️ #${ids} withdrawn WITHOUT a price floor: the pool could not be priced, so sandwich protection was off for this close.`;

/**
 * amount0Min/amount1Min for BURN_POSITION.
 *
 * Both were once 0, on the reasoning that "a burn withdraws your own funds, it is not
 * a swap". That reasoning does NOT hold for concentrated liquidity: price can be
 * pushed to a range edge, the position exits ~100% as the asset being suppressed,
 * and price is then restored — with the tx still reporting success, so nothing flags
 * it. v3 has been guarded for a long time (withdrawMins); this closes the same hole
 * in v4.
 *
 * The floor is computed from PRINCIPAL alone (at the current pool price), while the
 * on-chain slippage check measures principal plus fees. Fees only add, so this floor
 * is conservative and will not reject a healthy burn.
 *
 * The maths lives in `withdrawFloors` (lpmath.ts), shared with v3: floors come from
 * a PRICE BAND rather than a per-side percentage. Per-side floors pinned composition
 * — which is meant to move — instead of value, and in a narrow range an ordinary
 * 0.2% price move was enough to trigger `MinimumAmountInsufficient` (0x12816f22) and
 * fail a close over and over with no attacker anywhere near it.
 *
 * If it cannot be computed: {0,0} plus an `unprotected` flag (the user's funds
 * outrank the MEV risk), and that flag is CARRIED UP so it appears on the card, not
 * just in the server log.
 */
async function burnMinsV4(
  cc: ChainCtx,
  pm: ethers.Contract,
  tokenId: string,
  pk: PoolKeyV4,
): Promise<{ min0: bigint; min1: bigint; unprotected: boolean }> {
  try {
    const [, info] = await pm.getPoolAndPositionInfo(tokenId);
    const liquidity: bigint = await pm.getPositionLiquidity(tokenId);
    // Zero liquidity means no principal that price can steal; not a hole.
    if (liquidity === 0n) return { min0: 0n, min1: 0n, unprotected: false };
    const tickLower = signExt24((BigInt(info) >> 8n) & 0xffffffn);
    const tickUpper = signExt24((BigInt(info) >> 32n) & 0xffffffn);
    const { sqrtPriceX96 } = await readPoolState(cc, pk);
    return { ...withdrawFloors(sqrtPriceX96, sqrtAtTick(tickLower), sqrtAtTick(tickUpper), liquidity), unprotected: false };
  } catch (e) {
    console.log(`[v4] ⚠️ no slippage floor available (#${tokenId}), burning without price protection:`, (e as Error).message.slice(0, 80));
    return { min0: 0n, min1: 0n, unprotected: true };
  }
}

/**
 * Close (burn) a v4 position: withdraw ALL liquidity plus fees, take both tokens to
 * the wallet, and burn the NFT — in a single modifyLiquidities (BURN_POSITION +
 * TAKE_PAIR). A staticCall simulation is MANDATORY first; a revert aborts before
 * anything is sent. dryRun simulates only.
 */
/**
 * A revert that means "this token will not move".
 *
 * v4 wraps an inner failure as WrappedError(target, selector, reason, details); when the
 * selector is ERC20.transfer the pool could not hand the token over. Matched on the
 * selector rather than on any message, because such tokens revert with custom errors of
 * their own that carry no text at all.
 */
function isTransferBlocked(e: unknown): boolean {
  const data = String((e as { data?: string })?.data ?? '');
  // 0x90bfb865 = WrappedError(...), and a9059cbb = transfer(address,uint256).
  return data.startsWith('0x90bfb865') && data.includes('a9059cbb');
}

export async function closePositionV4(
  tokenId: string,
  cc: ChainCtx,
  opts: { dryRun: boolean },
): Promise<{
  dryRun?: boolean;
  txHash?: string;
  sym0: string;
  sym1: string;
  base: 'ETH' | 'USDG' | null;
  other?: string; // token non-base → jurnal & kandidat sweep
  cashedOut?: string;
  cashTxHashes?: string[];
  leftover?: string;
  unprotected?: boolean; // the burn was forced through without a price floor
  /** The symbol of a side that had to be FORFEITED because the token refuses transfers. */
  forfeited?: string;
}> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);
  const owner: string = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() !== cc.wallet.address.toLowerCase()) {
    throw new Error(`v4 position #${tokenId} is not owned by this wallet.`);
  }
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.concat([Uint8Array.of(BURN_POSITION), Uint8Array.of(TAKE_PAIR)]);
  const mins = await burnMinsV4(cc, pm, tokenId, pk);
  const pBurn = coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [tokenId, mins.min0, mins.min1, '0x']);
  const pTake = coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, cc.wallet.address]);
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, [pBurn, pTake]]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);

  // Pick the cash-out asset: an ETH pair gives ETH, a USDG pair gives USDG, anything else none.
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const st = stableOf(cc);
  const isUsdg = (a: string) => !!st && a.toLowerCase() === st.addr.toLowerCase();
  let base: 'ETH' | 'USDG' | null = null;
  let other: string | null = null;
  if (isEth(pk.currency0) || isEth(pk.currency1)) {
    base = 'ETH';
    other = isEth(pk.currency0) ? pk.currency1 : pk.currency0;
  } else if (isUsdg(pk.currency0) || isUsdg(pk.currency1)) {
    base = 'USDG';
    other = isUsdg(pk.currency0) ? pk.currency1 : pk.currency0;
  }

  // Simulation is MANDATORY (burn+take): a revert here cancels before a tx goes out.
  let payload = unlockData;
  let forfeited: string | undefined;
  try {
    await pm.modifyLiquidities.staticCall(payload, deadline, { from: cc.wallet.address });
  } catch (e) {
    // A token that REFUSES to be transferred out of the pool traps the whole position.
    // STANDARD on Robinhood does exactly this: a 0-wei transfer succeeds, any real amount
    // reverts, so TAKE_PAIR -- which moves BOTH sides -- can never complete and $350 of
    // USDG sits behind a few cents of untransferable dust.
    //
    // The escape hatch forfeits that side (CLEAR_OR_TAKE) and takes the base outright. It
    // is used ONLY when the base really is the base: nothing here can forfeit the asset
    // the position was opened with, and the simulation still has to pass before anything
    // is sent.
    const baseCur = base === 'ETH' ? (isEth(pk.currency0) ? pk.currency0 : pk.currency1) : isUsdg(pk.currency0) ? pk.currency0 : pk.currency1;
    const otherCur = baseCur === pk.currency0 ? pk.currency1 : pk.currency0;
    if (!base || !isTransferBlocked(e)) throw e;
    const alt = coder.encode(
      ['bytes', 'bytes[]'],
      [
        ethers.concat([Uint8Array.of(BURN_POSITION), Uint8Array.of(CLEAR_OR_TAKE), Uint8Array.of(TAKE)]),
        [
          pBurn,
          coder.encode(['address', 'uint256'], [otherCur, ethers.MaxUint256]), // forfeit whatever is owed
          coder.encode(['address', 'address', 'uint256'], [baseCur, cc.wallet.address, 0n]), // 0 = the whole delta
        ],
      ],
    );
    // If THIS reverts too, the original error is the honest one to report.
    await pm.modifyLiquidities.staticCall(alt, deadline, { from: cc.wallet.address }).catch(() => {
      throw e;
    });
    payload = alt;
    forfeited = await tokenSymbol(otherCur, cc).catch(() => 'the token side');
    console.log(`[v4] #${tokenId}: ${forfeited} cannot be transferred out of the pool; closing by forfeiting its dust and taking the ${base}`);
  }
  if (opts.dryRun) return { dryRun: true, sym0, sym1, base, other: other ?? undefined, unprotected: mins.unprotected, forfeited };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(payload, deadline));
  const rc = await tx.wait();
  const out: {
    txHash: string;
    sym0: string;
    sym1: string;
    base: 'ETH' | 'USDG' | null;
    other?: string; // the non-base token address, used by the journal and as a sweep candidate
    cashedOut?: string;
    cashTxHashes?: string[];
    leftover?: string;
    unprotected?: boolean;
    forfeited?: string;
  } = {
    txHash: rc?.hash ?? tx.hash,
    sym0,
    sym1,
    base,
    other: other ?? undefined,
    unprotected: mins.unprotected,
    forfeited,
  };

  // Cash out: swap the leftover token to base. Best-effort; on failure it stays as a leftover, not lost.
  if (base && other && other !== ethers.ZeroAddress) {
    try {
      const erc = new ethers.Contract(other, ['function balanceOf(address) view returns (uint256)'], cc.provider);
      const bal: bigint = await erc.balanceOf(cc.wallet.address);
      if (bal > 0n) {
        const r = base === 'ETH'
          ? await swapTokenToEthRobust(other, bal, cc)
          : await swapTokenToUsdgRobust(other, bal, stableOf(cc)!.addr, cc);
        // The chain's real symbol (USDT on BSC), not the internal 'USDG' kind; route without its
        // '-usdg' suffix, which named the code path, not the asset.
        out.cashTxHashes = r.txHashes ?? [];
        out.cashedOut = `${v4BaseSymbol(cc, base)} via ${r.route.replace(/-usdg\b/, '')}`;
      }
    } catch (e) {
      out.leftover = (e as Error).message.slice(0, 100); // token receh tetap di wallet (aman)
    }
  }

  // ETH base: Uniswap's fallback route yields WETH, so unwrap to native ETH and make
  // "everything to ETH" actually true (matching v3's stopAndCashOut).
  if (base === 'ETH') {
    try {
      const wbal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (wbal > 0n) {
        await (await cc.weth.withdraw(wbal)).wait();
        out.cashedOut = out.cashedOut ? `${out.cashedOut} + unwrap WETH` : 'ETH (unwrap WETH)';
      }
    } catch {
      /* WETH stays in the wallet — not fatal, it can be unwrapped manually */
    }
  }
  return out;
}

/**
 * Collect the fees of a v4 position WITHOUT touching its liquidity.
 *
 * v4 has no "collect" action: fees are settled by any liquidity change, so a decrease
 * of ZERO moves the accrued fees out and leaves the position exactly as it was. Both
 * minimums are 0 on purpose -- the amounts here ARE the fees, and a floor would make
 * the call revert whenever the pool had earned nothing since the last read.
 *
 * The amounts collected are measured from the wallet's own balance delta, never from
 * what the call claims, matching how every other money path here reports.
 */
export async function collectFeesV4(
  tokenId: string,
  cc: ChainCtx,
): Promise<{ txHash: string; amount0: bigint; amount1: bigint; sym0: string; sym1: string; poolKey: PoolKeyV4 }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);
  const owner: string = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() !== cc.wallet.address.toLowerCase()) {
    throw new Error(`v4 position #${tokenId} is not owned by this wallet.`);
  }
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.concat([Uint8Array.of(DECREASE_LIQUIDITY), Uint8Array.of(TAKE_PAIR)]);
  const pDec = coder.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [tokenId, 0n, 0n, 0n, '0x']);
  const pTake = coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, cc.wallet.address]);
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, [pDec, pTake]]);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const bal = async (a: string) =>
    a === ethers.ZeroAddress
      ? cc.provider.getBalance(cc.wallet.address)
      : (new ethers.Contract(a, ['function balanceOf(address) view returns (uint256)'], cc.provider).balanceOf(
          cc.wallet.address,
        ) as Promise<bigint>);

  // Simulation first: a revert aborts before any gas is spent.
  await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address });
  const [b0, b1, sym0, sym1] = await Promise.all([
    bal(pk.currency0),
    bal(pk.currency1),
    tokenSymbol(pk.currency0, cc),
    tokenSymbol(pk.currency1, cc),
  ]);
  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline));
  const rc = await tx.wait();
  const [a0, a1] = await Promise.all([bal(pk.currency0), bal(pk.currency1)]);
  // Native gas is paid out of currency0 when it is ETH, so a delta can read negative;
  // clamp rather than report a nonsense figure.
  const delta = (before: bigint, after: bigint) => (after > before ? after - before : 0n);
  return {
    txHash: rc?.hash ?? tx.hash,
    amount0: delta(b0, a0),
    amount1: delta(b1, a1),
    sym0,
    sym1,
    poolKey: pk,
  };
}

/**
 * BATCH close of a v4 ladder: burn EVERY leg plus take (N x BURN_POSITION + 1 x
 * TAKE_PAIR) in one modifyLiquidities, then a SINGLE token->base swap and unwrap.
 * Returns the measured total baseOut (the base balance delta) for the caller to
 * split across legs.
 */
export async function closeLadderV4(
  tokenIds: string[],
  cc: ChainCtx,
  opts: { dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; base: 'ETH' | 'USDG' | null; other?: string; sym0: string; sym1: string; baseOutWei: bigint; cashedOut?: string; cashTxHashes?: string[]; unprotected?: string[]; gone?: string[] }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);
  const [pk] = await pm.getPoolAndPositionInfo(tokenIds[0]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const st = stableOf(cc);
  const isUsdg = (a: string) => !!st && a.toLowerCase() === st.addr.toLowerCase();
  let base: 'ETH' | 'USDG' | null = null;
  let other: string | null = null;
  if (isEth(pk.currency0) || isEth(pk.currency1)) { base = 'ETH'; other = isEth(pk.currency0) ? pk.currency1 : pk.currency0; }
  else if (isUsdg(pk.currency0) || isUsdg(pk.currency1)) { base = 'USDG'; other = isUsdg(pk.currency0) ? pk.currency1 : pk.currency0; }

  // Measure the base balance BEFORE (the delta is the result). ETH means native; USDG means the token.
  const readBase = async (): Promise<bigint> =>
    base === 'USDG' && stableOf(cc)
      ? ((await new ethers.Contract(stableOf(cc)!.addr, ['function balanceOf(address) view returns (uint256)'], cc.provider).balanceOf(cc.wallet.address).catch(() => 0n)) as bigint)
      : ((await cc.provider.getBalance(cc.wallet.address).catch(() => 0n)) as bigint);
  const beforeWei = await readBase();

  // Legs that ALREADY vanished have to be filtered out first. BURN_POSITION on an id
  // that was never minted, or no longer is, reverts with 'NOT_MINTED', and since this
  // is ONE multicall the whole batch fails with it — eight legs left unclosable
  // because of a single ghost id. Only an ownership revert counts as "gone"; any
  // other read failure is rethrown, so a flaky RPC is never again read as "the
  // position does not exist".
  const alive: string[] = [];
  const gone: string[] = [];
  for (const id of tokenIds) {
    try {
      await pm.ownerOf(id);
      alive.push(id);
    } catch (e) {
      const m = (e as Error).message ?? '';
      if (/NOT_MINTED|invalid token id|nonexistent/i.test(m)) gone.push(id);
      else throw new Error(`Could not read v4 position #${id} (${m.slice(0, 80)}). Nothing was closed.`);
    }
  }
  if (alive.length === 0) {
    throw new Error(
      `None of these ${tokenIds.length} legs exist on-chain, so there was nothing to close. ` +
        'They no longer exist on-chain and have been dropped from tracking.',
    );
  }
  tokenIds = alive;

  const actionBytes = [...tokenIds.map(() => BURN_POSITION), TAKE_PAIR];
  // Each leg has its own range, so floors are computed per leg rather than once.
  const legMins = await Promise.all(tokenIds.map((id) => burnMinsV4(cc, pm, id, pk)));
  const unprotectedIds = tokenIds.filter((_, i) => legMins[i].unprotected);
  const params = [
    ...tokenIds.map((id, i) => coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [id, legMins[i].min0, legMins[i].min1, '0x'])),
    coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, cc.wallet.address]),
  ];
  const unlockData = coder.encode(['bytes', 'bytes[]'], [ethers.hexlify(new Uint8Array(actionBytes)), params]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address });
  if (opts.dryRun) return { dryRun: true, base, other: other ?? undefined, sym0, sym1, baseOutWei: 0n, unprotected: unprotectedIds, gone };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline));
  const rc = await tx.wait();
  let cashedOut: string | undefined;
  let cashTxHashes: string[] = [];
  // Swap the whole token proceeds (aggregated across legs) to base in one go.
  if (base && other && other !== ethers.ZeroAddress) {
    try {
      const erc = new ethers.Contract(other, ['function balanceOf(address) view returns (uint256)'], cc.provider);
      const bal: bigint = await erc.balanceOf(cc.wallet.address);
      if (bal > 0n) {
        const r = base === 'ETH' ? await swapTokenToEthRobust(other, bal, cc) : await swapTokenToUsdgRobust(other, bal, stableOf(cc)!.addr, cc);
        cashTxHashes = r.txHashes ?? [];
        cashedOut = `${v4BaseSymbol(cc, base)} via ${r.route.replace(/-usdg\b/, '')}`;
      }
    } catch { /* token receh tetap di wallet */ }
  }
  if (base === 'ETH') {
    try {
      const wbal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (wbal > 0n) await (await cc.weth.withdraw(wbal)).wait();
    } catch { /* leave the WETH as it is */ }
  }
  const afterWei = await readBase();
  const baseOutWei = afterWei > beforeWei ? afterWei - beforeWei : 0n;
  return { txHash: rc?.hash ?? tx.hash, base, other: other ?? undefined, sym0, sym1, baseOutWei, cashedOut, cashTxHashes, unprotected: unprotectedIds, gone };
}

// Per-chain cache of the v4 list (short TTL): several commands (/status,
// /positions and others) call it back to back, and without a cache each one
// re-fetches every leg.
const listCache = new Map<string, { t: number; v: V4Position[] }>();
const LIST_TTL_MS = 45_000;

/** The wallet's v4 positions. onlyLive=true returns only those with liquidity > 0. */
export async function listPositionsV4(cc: ChainCtx, { onlyLive = true }: { onlyLive?: boolean } = {}): Promise<V4Position[]> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) return [];
  const ck = `${cc.key}:${onlyLive}`;
  const hit = listCache.get(ck);
  if (hit && Date.now() - hit.t < LIST_TTL_MS) return hit.v;
  // Stale but recent: answer with it now and refresh behind. A cold read is ~3s on
  // Robinhood, and every open/close clears this cache, so a stale list can only be off by
  // price drift, never by a position that came or went.
  if (hit && Date.now() - hit.t < LIST_STALE_MS) {
    if (!refreshing.has(ck)) {
      refreshing.add(ck);
      listFresh(cc, onlyLive, ck).catch(() => {}).finally(() => refreshing.delete(ck));
    }
    return hit.v;
  }
  return listFresh(cc, onlyLive, ck);
}

const LIST_STALE_MS = 10 * 60_000;
const refreshing = new Set<string>();

async function listFresh(cc: ChainCtx, onlyLive: boolean, ck: string): Promise<V4Position[]> {
  const pmAddr = V4_PM[cc.key]!;
  const gen = listGen;
  const ids = await walletV4TokenIds(cc);
  if (ids.length === 0) return [];
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  // Concurrency is CAPPED: 69 legs x ~5 RPCs through Promise.all is ~300 concurrent
  // requests, which Alchemy throttles. mapLimit holds it at about 8 at a time.
  const rows = await mapLimit(ids, 8,
    async (id): Promise<V4Position | null> => {
      try {
        const [pk, info] = await pm.getPoolAndPositionInfo(id);
        const liquidity: bigint = await pm.getPositionLiquidity(id);
        if (onlyLive && liquidity === 0n) return null;
        const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);
        const fee = Number(pk.fee);
        const tickLower = signExt24((info >> 8n) & 0xffffffn);
        const tickUpper = signExt24((info >> 32n) & 0xffffffn);
        const poolKey: PoolKeyV4 = {
          currency0: pk.currency0,
          currency1: pk.currency1,
          fee,
          tickSpacing: Number(pk.tickSpacing),
          hooks: pk.hooks,
        };
        // Valuation (value plus range %); if the price read fails, null — the card still renders.
        let val: Awaited<ReturnType<typeof valuePositionV4>> | null = null;
        try {
          val = await valuePositionV4(cc, poolKey, tickLower, tickUpper, liquidity, id);
        } catch {
          /* leave it null */
        }
        // The token's price in ETH according to THIS pool's slot0, used to spot a
        // dying pool by comparing it with DexScreener's market price on the card.
        // ETH pairs only.
        let impliedTokenEthPrice: number | null = null;
        const pb = pairBase(cc, pk.currency0, pk.currency1);
        if (val && pb.base === 'ETH') {
          try {
            const tokenAddr = pb.baseIsCurrency0 ? pk.currency1 : pk.currency0;
            const tokDec = await tokenDecimals(tokenAddr, cc);
            const P = Math.pow(1.0001, val.currentTick); // currency1_raw / currency0_raw
            const factor = pb.baseIsCurrency0 ? 1 / P : P; // ETH_raw per token_raw
            const px = factor * Math.pow(10, tokDec - 18);
            if (isFinite(px) && px > 0) impliedTokenEthPrice = px;
          } catch {
          /* leave it null */
          }
        }
        return {
          tokenId: id,
          sym0,
          sym1,
          fee,
          dynamicFee: fee === DYNAMIC_FEE_FLAG,
          hasHooks: pk.hooks !== ethers.ZeroAddress,
          tickLower,
          tickUpper,
          liquidity,
          poolKey,
          valueBaseWei: val ? val.valueBaseWei : null,
          feesBaseWei: val ? val.feesBaseWei : null,
          otherAmountWei: val ? (val.baseIsCurrency0 ? val.amount1 : val.amount0) : null,
          otherAddress: val ? (val.baseIsCurrency0 ? pk.currency1 : pk.currency0) : null,
          otherDecimals: val ? await tokenDecimals(val.baseIsCurrency0 ? pk.currency1 : pk.currency0, cc).catch(() => 18) : null,
          baseAmountWei: val ? (val.baseIsCurrency0 ? val.amount0 : val.amount1) : null,
          currentTick: val ? val.currentTick : null,
          rangePctHigh: val ? val.rangePctHigh : null,
          rangePctLow: val ? val.rangePctLow : null,
          inRange: val ? val.inRange : null,
          converted: val ? val.converted : false,
          base: pb.base,
          impliedTokenEthPrice,
        };
      } catch {
        return null;
      }
    },
  );
  const out = rows.filter((r): r is V4Position => r !== null);
  // A close or open during this read has cleared the cache; do not put the old list back.
  if (gen === listGen) listCache.set(ck, { t: Date.now(), v: out });
  return out;
}

/** Drop the v4 list cache (called after opening or closing so /positions stays fresh). */
let listGen = 0;
export function invalidateV4ListCache(): void {
  listGen++;
  listCache.clear();
}

// ── Add (mint) a single-sided v4 position ──────────────────────────────────
export const sqrtAtTick = (tick: number): bigint => BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
function liqForAmount0(a: bigint, b: bigint, amt0: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (amt0 * ((a * b) / Q96)) / (b - a);
}
function liqForAmount1(a: bigint, b: bigint, amt1: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (amt1 * Q96) / (b - a);
}

export type PoolKeyV4 = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };

/**
 * The gateway's PoolKey is often wrong: currencies come back unsorted, and a
 * native-ETH pool is reported using the WETH address. The keccak poolId then does not
 * match, and modifyLiquidities reverts with PoolNotInitialized at the very last step
 * — a dead end four taps in. This tries the plausible variants and returns whichever
 * has a LIVE slot0; null means the pool does not exist.
 */
export async function resolvePoolKeyV4(
  cc: ChainCtx,
  pk: PoolKeyV4,
  baseIsCurrency0: boolean,
): Promise<{ poolKey: PoolKeyV4; baseIsCurrency0: boolean } | null> {
  if (!V4_POOL_MANAGER[cc.key]) return null;
  const baseAddr = baseIsCurrency0 ? pk.currency0 : pk.currency1;
  const otherAddr = baseIsCurrency0 ? pk.currency1 : pk.currency0;
  const isWeth = baseAddr.toLowerCase() === cc.wethAddress.toLowerCase();
  const bases = isWeth ? [baseAddr, ethers.ZeroAddress] : [baseAddr];
  // Do not take the FIRST initialised pool: the native-ETH and WETH variants can both
  // be live, and one of them may be a dying pool (liquidity near $0) whose price is
  // stuck far from the market. Pick the one with the DEEPEST liquidity.
  let best: { poolKey: PoolKeyV4; baseIsCurrency0: boolean; liq: bigint } | null = null;
  for (const b of bases) {
    const [c0, c1] = b.toLowerCase() < otherAddr.toLowerCase() ? [b, otherAddr] : [otherAddr, b];
    const cand: PoolKeyV4 = { ...pk, currency0: c0, currency1: c1 };
    const { sqrtPriceX96 } = await readPoolState(cc, cand).catch(() => ({ sqrtPriceX96: 0n }));
    if (sqrtPriceX96 === 0n) continue;
    const liq = await readPoolLiquidity(cc, cand).catch(() => 0n);
    if (!best || liq > best.liq) best = { poolKey: cand, baseIsCurrency0: c0 === b, liq };
  }
  return best ? { poolKey: best.poolKey, baseIsCurrency0: best.baseIsCurrency0 } : null;
}

/**
 * v4 pool health for an OPEN decision: on-chain active liquidity plus the token's
 * price (in ETH) according to this pool's slot0. The wizard uses it to filter out
 * dying pools and prices that have drifted from the market before offering them.
 * impliedTokenEthPrice is for ETH pairs only (null otherwise, or on a read failure).
 */
export async function poolHealthV4(
  cc: ChainCtx,
  pk: PoolKeyV4,
): Promise<{ liquidity: bigint; impliedTokenEthPrice: number | null; paysLps: boolean }> {
  const liquidity = await readPoolLiquidity(cc, pk).catch(() => 0n);
  // A pool that has never accrued fee growth pays its LPs nothing. Unreadable is
  // NOT the same as zero: a failed read must not condemn a healthy pool, so it
  // fails open to `true`.
  const fg = await readFeeGrowth(cc, pk).catch(() => null);
  const paysLps = fg === null ? true : fg.g0 > 0n || fg.g1 > 0n;
  let impliedTokenEthPrice: number | null = null;
  const pb = pairBase(cc, pk.currency0, pk.currency1);
  if (pb.base === 'ETH') {
    try {
      const { tick } = await readPoolState(cc, pk);
      const tokenAddr = pb.baseIsCurrency0 ? pk.currency1 : pk.currency0;
      const tokDec = await tokenDecimals(tokenAddr, cc);
      const P = Math.pow(1.0001, tick);
      const factor = pb.baseIsCurrency0 ? 1 / P : P;
      const px = factor * Math.pow(10, tokDec - 18);
      if (isFinite(px) && px > 0) impliedTokenEthPrice = px;
    } catch {
      /* leave it null */
    }
  }
  return { liquidity, impliedTokenEthPrice, paysLps };
}

async function ensurePermit2(cc: ChainCtx, token: string, spender: string, amount: bigint): Promise<void> {
  const erc = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], cc.wallet);
  if ((await erc.allowance(cc.wallet.address, PERMIT2)) < amount) {
    await (await sendTxNonceSafe(cc.wallet as ethers.Wallet, await erc.approve.populateTransaction(PERMIT2, ethers.MaxUint256))).wait();
  }
  const p2 = new ethers.Contract(PERMIT2, ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)'], cc.wallet);
  // Permit2 returns (amount, expiration, nonce). The expiration used to be DISCARDED here,
  // and only the amount decided whether to re-approve.
  //
  // An approval is written for 30 days with a max amount, so thirty days later the amount
  // is still max and this branch stays shut while every add reverts with
  // AllowanceExpired(1790118992). That is exactly what happened on 23 Sep 2026 from 06:16
  // WIB onward: USDG on Robinhood carried a full allowance that had expired hours earlier.
  //
  // The renewal is EARLY by a day. Renewing at the moment of expiry races the block time:
  // an approval that is valid when it is read can be stale by the time the add lands.
  const [amt, exp] = await p2.allowance(cc.wallet.address, token, spender);
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(amt) < amount || Number(exp) < now + 24 * 3600) {
    await (await sendTxNonceSafe(cc.wallet as ethers.Wallet, await p2.approve.populateTransaction(token, spender, (1n << 160n) - 1n, now + 30 * 24 * 3600))).wait();
  }
}

/**
 * Open a single-sided v4 position: deposit ONLY the base into a range on one side of
 * the price (base=currency0 puts the range above; base=currency1 puts it below), so
 * only the base is drawn down. Simulation is MANDATORY before sending. An ERC20 base
 * goes through Permit2.
 */
export async function openPositionV4(
  cc: ChainCtx,
  poolKey: PoolKeyV4,
  baseIsCurrency0: boolean,
  baseAmountWei: bigint,
  opts: { widthSpacings?: number; gapSpacings?: number; dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; tokenId?: string; tickLower: number; tickUpper: number; liquidity: bigint; baseIsCurrency0: boolean }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || !V4_POOL_MANAGER[cc.key]) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const spacing = poolKey.tickSpacing;
  const width = (opts.widthSpacings ?? 50) * spacing;
  // A default gap of 0 puts the near edge FLUSH against the current price, so the
  // position starts filling on the first move our way rather than waiting out a gap.
  const gap = (opts.gapSpacings ?? 0) * spacing;
  const state = await readPoolState(cc, poolKey);
  // An empty slot0 means the poolKey matches no pool. Without this check the revert
  // only surfaces as an 'unknown custom error' (PoolNotInitialized) in the plan preview.
  if (state.sqrtPriceX96 === 0n) throw new Error('This v4 pool is not initialised. Pick another pool.');
  const current = state.tick;
  const aligned = nearestUsableTick(current, spacing);
  let tickLower: number;
  let tickUpper: number;
  if (baseIsCurrency0) {
    // Depositing currency0 puts the range ABOVE the price. A rising tick means a
    // falling token price, which fills it. The near edge is the SMALLEST usable tick
    // strictly above current (flush), plus an optional gap.
    tickLower = (aligned > current ? aligned : aligned + spacing) + gap;
    tickUpper = tickLower + width;
  } else {
    // Depositing currency1 puts the range BELOW the price. A falling tick means a
    // falling token price, which fills it. The near edge is the LARGEST usable tick
    // strictly below current (flush), minus an optional gap.
    tickUpper = (aligned < current ? aligned : aligned - spacing) - gap;
    tickLower = tickUpper - width;
  }
  const sqrtL = sqrtAtTick(tickLower);
  const sqrtU = sqrtAtTick(tickUpper);
  const liquidity = baseIsCurrency0 ? liqForAmount0(sqrtL, sqrtU, baseAmountWei) : liqForAmount1(sqrtL, sqrtU, baseAmountWei);
  if (liquidity <= 0n) {
    // Blind without numbers: log the pool, amount, spacing and tick width so it is
    // clear whether this is too small a deposit (USDG wei at 6 decimals) or too wide
    // a range (large spacing).
    console.log(
      `[v4] liquidity 0: pool=${poolKey.currency0}/${poolKey.currency1} fee=${poolKey.fee} spacing=${spacing}` +
        ` baseIsC0=${baseIsCurrency0} amountWei=${baseAmountWei} widthTicks=${tickUpper - tickLower} [${tickLower},${tickUpper}]`,
    );
    throw new Error(
      `Computed liquidity is 0: the deposit is too small for this pool's range (spacing ${spacing}, width ${tickUpper - tickLower} ticks). Increase the amount, narrow the range %, or pick a finer-spacing pool.`,
    );
  }

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const amount0Max = baseIsCurrency0 ? baseAmountWei : 0n;
  const amount1Max = baseIsCurrency0 ? 0n : baseAmountWei;
  const baseCurrency = baseIsCurrency0 ? poolKey.currency0 : poolKey.currency1;
  const isNative = baseCurrency === ethers.ZeroAddress;

  const mintParam = coder.encode(
    ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], tickLower, tickUpper, liquidity, amount0Max, amount1Max, cc.wallet.address, '0x'],
  );
  const settleParam = coder.encode(['address', 'address'], [poolKey.currency0, poolKey.currency1]);
  let actions: string;
  let params: string[];
  if (isNative) {
    actions = ethers.hexlify(new Uint8Array([MINT_POSITION, SETTLE_PAIR, SWEEP]));
    params = [mintParam, settleParam, coder.encode(['address', 'address'], [ethers.ZeroAddress, cc.wallet.address])];
  } else {
    actions = ethers.hexlify(new Uint8Array([MINT_POSITION, SETTLE_PAIR]));
    params = [mintParam, settleParam];
  }
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const value = isNative ? baseAmountWei : 0n;
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);

  if (!isNative && !opts.dryRun) await ensurePermit2(cc, baseCurrency, pmAddr, baseAmountWei);

  // staticCall validates the mint before sending. For a non-native base during a
  // DRY RUN, Permit2 is not set up yet so staticCall is certain to revert; skip it.
  // The live path still validates: ensurePermit2 first, then the staticCall below,
  // then the tx.
  if (isNative || !opts.dryRun) {
    await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address, value });
  }
  if (opts.dryRun) return { dryRun: true, tickLower, tickUpper, liquidity, baseIsCurrency0 };
  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline, { value }));
  const rc = await tx.wait();
  // The new NFT tokenId comes from the PositionManager's Transfer(from=0x0, to=wallet) event.
  let tokenId: string | undefined;
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const toPadded = ethers.zeroPadValue(cc.wallet.address, 32).toLowerCase();
  for (const log of rc?.logs ?? []) {
    if (
      log.address.toLowerCase() === pmAddr.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[1] === ethers.ZeroHash &&
      (log.topics[2] ?? '').toLowerCase() === toPadded
    ) {
      tokenId = BigInt(log.topics[3]).toString();
      break;
    }
  }
  return { txHash: rc?.hash ?? tx.hash, tokenId, tickLower, tickUpper, liquidity, baseIsCurrency0 };
}

// ── v4 Bid-Ask ladder (native batch: N MINT + 1 SETTLE in one tx) ───────────
export type V4LadderLeg = { tickLower: number; tickUpper: number; baseAmountWei: bigint; liquidity: bigint; pctHigh: number; pctLow: number };

/** Per-leg weights (index 0 is nearest the price, N-1 the furthest). spot is even, bidask scales with (i+1). */
function ladderWeightsV4(n: number, shape: 'spot' | 'bidask'): number[] {
  if (n <= 1) return [1];
  const raw = shape === 'bidask' ? Array.from({ length: n }, (_, i) => i + 1) : Array.from({ length: n }, () => 1);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * Plan a single-sided v4 ladder (base side, buy-the-dip): split the range [now ...
 * -X%] into N weighted legs. Mirrors v3's planLadderSingleSided but uses v4 tick
  * maths (readPoolState + liqForAmount). N is auto-capped to the spacing's capacity.
 */
export async function planLadderV4(
  cc: ChainCtx,
  poolKey: PoolKeyV4,
  baseIsCurrency0: boolean,
  totalBaseWei: bigint,
  rangePercent: number,
  legs: number,
  shape: 'spot' | 'bidask',
): Promise<V4LadderLeg[]> {
  const spacing = poolKey.tickSpacing;
  const state = await readPoolState(cc, poolKey);
  if (state.sqrtPriceX96 === 0n) throw new Error('This v4 pool is not initialised. Pick another pool.');
  const current = state.tick;
  const frac = Math.min(Math.max(rangePercent, 0.1), 95) / 100;
  const fullWidth = Math.max(spacing, Math.ceil(Math.abs(Math.log(1 - frac)) / Math.log(1.0001) / spacing) * spacing);
  const maxLegs = Math.max(1, Math.floor(fullWidth / spacing));
  const n = Math.max(1, Math.min(legs, 69, maxLegs));
  const legWidth = Math.max(spacing, Math.round(fullWidth / n / spacing) * spacing);
  const weights = ladderWeightsV4(n, shape);
  const aligned = nearestUsableTick(current, spacing);
  const sgn = baseIsCurrency0 ? -1 : 1;
  const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - current)) - 1) * 100;

  const out: V4LadderLeg[] = [];
  let allocated = 0n;
  for (let k = 0; k < n; k++) {
    const legWei = k === n - 1 ? totalBaseWei - allocated : (totalBaseWei * BigInt(Math.round(weights[k] * 1e9))) / 1_000_000_000n;
    allocated += legWei;
    let tickLower: number;
    let tickUpper: number;
    if (baseIsCurrency0) {
      const anchor = aligned > current ? aligned : aligned + spacing;
      tickLower = anchor + k * legWidth;
      tickUpper = tickLower + legWidth;
    } else {
      const anchor = aligned < current ? aligned : aligned - spacing;
      tickUpper = anchor - k * legWidth;
      tickLower = tickUpper - legWidth;
    }
    const sqrtL = sqrtAtTick(tickLower);
    const sqrtU = sqrtAtTick(tickUpper);
    const liquidity = baseIsCurrency0 ? liqForAmount0(sqrtL, sqrtU, legWei) : liqForAmount1(sqrtL, sqrtU, legWei);
    if (liquidity <= 0n) continue; // a dust leg, skipped
    const pcts = [pctOf(tickUpper), pctOf(tickLower)].sort((a, b) => b - a);
    out.push({ tickLower, tickUpper, baseAmountWei: legWei, liquidity, pctHigh: pcts[0], pctLow: pcts[1] });
  }
  return out;
}

/**
 * BATCH mint a v4 ladder: N legs in ONE atomic modifyLiquidities (N x MINT_POSITION
 * + 1 x SETTLE_PAIR, plus SWEEP when native). The cheapest route, settling the base
 * once at the end.
 */
export async function openLadderV4(
  cc: ChainCtx,
  poolKey: PoolKeyV4,
  baseIsCurrency0: boolean,
  legs: V4LadderLeg[],
  opts: { dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; tokenIds: string[] }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || !V4_POOL_MANAGER[cc.key]) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const baseCurrency = baseIsCurrency0 ? poolKey.currency0 : poolKey.currency1;
  const isNative = baseCurrency === ethers.ZeroAddress;
  const totalBase = legs.reduce((s, l) => s + l.baseAmountWei, 0n);

  const mintParams = legs.map((l) => {
    const amount0Max = baseIsCurrency0 ? l.baseAmountWei : 0n;
    const amount1Max = baseIsCurrency0 ? 0n : l.baseAmountWei;
    return coder.encode(
      ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
      [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], l.tickLower, l.tickUpper, l.liquidity, amount0Max, amount1Max, cc.wallet.address, '0x'],
    );
  });
  const settleParam = coder.encode(['address', 'address'], [poolKey.currency0, poolKey.currency1]);
  const actionBytes = [...legs.map(() => MINT_POSITION), SETTLE_PAIR, ...(isNative ? [SWEEP] : [])];
  const params = [...mintParams, settleParam, ...(isNative ? [coder.encode(['address', 'address'], [ethers.ZeroAddress, cc.wallet.address])] : [])];
  const actions = ethers.hexlify(new Uint8Array(actionBytes));
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const value = isNative ? totalBase : 0n;
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);

  if (!isNative && !opts.dryRun) await ensurePermit2(cc, baseCurrency, pmAddr, totalBase);
  if (isNative || !opts.dryRun) {
    await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address, value });
  }
  if (opts.dryRun) return { dryRun: true, tokenIds: [] };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline, { value }));
  const rc = await tx.wait();
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const toPadded = ethers.zeroPadValue(cc.wallet.address, 32).toLowerCase();
  const tokenIds: string[] = [];
  for (const log of rc?.logs ?? []) {
    if (
      log.address.toLowerCase() === pmAddr.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[1] === ethers.ZeroHash &&
      (log.topics[2] ?? '').toLowerCase() === toPadded
    ) {
      tokenIds.push(BigInt(log.topics[3]).toString());
    }
  }
  return { txHash: rc?.hash ?? tx.hash, tokenIds };
}

/**
 * The PositionManager's next position NFT id. Used to BRACKET the range of ids one
 * open attempt might produce: read before sending, read again afterwards.
 * Authoritative (straight from the contract) and independent of any indexer.
 */
export async function v4NextTokenId(cc: ChainCtx): Promise<bigint> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  return await new ethers.Contract(pmAddr, ['function nextTokenId() view returns (uint256)'], cc.provider).nextTokenId();
}

/** Owner of a v4 position NFT — a 'NOT_MINTED' revert means the position is gone. */
export async function v4OwnerOf(cc: ChainCtx, tokenId: string): Promise<string> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  return await new ethers.Contract(pmAddr, ['function ownerOf(uint256) view returns (address)'], cc.provider).ownerOf(tokenId);
}

/**
 * Ids in [from, to) owned by our wallet. For recovering a position that DID get
 * minted while its open flow failed part-way through — without this the position
 * exists on chain but has no record, so it never appears in /positions while the
 * indexer is down.
 * ponytail: capped at `cap` ids, since one open attempt always spans a small range.
 */
export async function v4OwnedIdsInRange(cc: ChainCtx, from: bigint, to: bigint, cap = 64): Promise<string[]> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || to <= from) return [];
  const pm = new ethers.Contract(pmAddr, ['function ownerOf(uint256) view returns (address)'], cc.provider);
  const me = cc.wallet.address.toLowerCase();
  const out: string[] = [];
  for (let id = from; id < to && id - from < BigInt(cap); id++) {
    const owner = await pm.ownerOf(id).catch(() => null);
    if (owner && String(owner).toLowerCase() === me) out.push(id.toString());
  }
  return out;
}

/** A v4 position's PoolKey plus base info (for adding to the same pool). */
export async function getPoolKeyV4(cc: ChainCtx, tokenId: string): Promise<{ poolKey: PoolKeyV4; baseIsCurrency0: boolean; base: 'ETH' | 'USDG' | null }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const poolKey: PoolKeyV4 = { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks };
  const { base, baseIsCurrency0 } = pairBase(cc, pk.currency0, pk.currency1);
  return { poolKey, baseIsCurrency0, base };
}

// ── v4 position valuation (value in base + range %) ─────────────────────────
/** The v4 pool's current tick, used to stamp entryTick when opening. */
export async function currentTickV4(cc: ChainCtx, pk: PoolKeyV4): Promise<number> {
  return (await readPoolState(cc, pk)).tick;
}

/** Read a v4 pool's slot0: current tick and sqrtPriceX96. */
/**
 * The v4 pool id: keccak of the PoolKey. It is the pool's identity everywhere -- the
 * PoolManager's storage slots AND DexScreener's pairAddress, which is what lets the
 * detail card read TVL and volume for a pool the Uniswap index does not carry.
 */
export function poolIdV4(pk: PoolKeyV4): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,uint24,int24,address)'],
      [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]],
    ),
  );
}

async function readPoolState(cc: ChainCtx, pk: PoolKeyV4): Promise<{ tick: number; sqrtPriceX96: bigint }> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const poolId = poolIdV4(pk);
  const slot = ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)]));
  const raw = BigInt(await mgr.extsload(slot));
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  let tick = Number((raw >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;
  return { tick, sqrtPriceX96 };
}

/**
 * TOTAL pool liquidity (the pool, not a position). Pool.State layout: base slot =
 * keccak256(poolId, POOLS_SLOT=6); slot0 at offset 0, liquidity (uint128) at offset
 * 3. Used to detect a dying pool, where the price is unreliable.
 */
/**
 * The pool's own liquidity at the current price, valued in its base asset.
 *
 * Read straight from the chain, so it is available for pools the Uniswap index has not
 * picked up yet -- which is every pool for its first hours, and exactly when a position
 * card would otherwise show nothing at all. It is depth AT the price, not total TVL:
 * that is the number that decides whether a swap through this pool moves it.
 */
export async function poolDepthV4(cc: ChainCtx, pk: PoolKeyV4): Promise<bigint | null> {
  try {
    const L = await readPoolLiquidity(cc, pk);
    if (L <= 0n) return 0n;
    const { tick } = await readPoolState(cc, pk);
    // A one-spacing band around the current tick: the liquidity that a trade actually
    // meets first. A full-range valuation would overstate a concentrated pool wildly.
    const spacing = Number(pk.tickSpacing) || 1;
    const lo = Math.floor(tick / spacing) * spacing;
    const val = await valuePositionV4(cc, pk, lo, lo + spacing, L);
    return val.valueBaseWei;
  } catch {
    return null;
  }
}

async function readPoolLiquidity(cc: ChainCtx, pk: PoolKeyV4): Promise<bigint> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const poolId = poolIdV4(pk);
  const base = BigInt(ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)])));
  const slot = ethers.zeroPadValue(ethers.toBeHex(base + 3n), 32);
  const raw = BigInt(await mgr.extsload(slot));
  return raw & ((1n << 128n) - 1n);
}

/**
 * A pool's LIFETIME fee growth. Zero on both sides means the pool has never paid
 * its liquidity providers a single unit.
 *
 * On a hook pool with `fee = 0` the hook collects the swap fee and routes it
 * elsewhere — protocol, creator, buyback — so `feeGrowthGlobal` never moves no
 * matter how much volume passes through. Measured on Robinhood: $RSTR's deepest
 * pool turned over $3.4M in a day with both counters still at zero, while three
 * hookless pools on the same token had accrued normally.
 */
export async function readFeeGrowth(cc: ChainCtx, pk: PoolKeyV4): Promise<{ g0: bigint; g1: bigint }> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const poolId = poolIdV4(pk);
  const base = BigInt(ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)])));
  const at = async (off: bigint) => BigInt(await mgr.extsload(ethers.zeroPadValue(ethers.toBeHex(base + off), 32)));
  return { g0: await at(1n), g1: await at(2n) };
}

/**
 * slot0 plus a position's fees in a SINGLE extsload(bytes32[]). Replaces
 * readPoolState inside valuePositionV4 so the RPC count does not grow even though
 * fees are now computed too. tokenId is the v4 position's salt (owner = PositionManager).
 * Pool.State layout: slot0@0, feeGrowthGlobal0/1@1,2, ticks@4, positions@6.
 */
async function readPoolAndFees(
  cc: ChainCtx, pk: PoolKeyV4, tickLower: number, tickUpper: number, tokenId: string,
): Promise<{ tick: number; sqrtPriceX96: bigint; fee0: bigint; fee1: bigint }> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], [
    'function extsload(bytes32[]) view returns (bytes32[])',
  ], cc.provider);
  const poolId = poolIdV4(pk);
  const h = (x: bigint) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
  const base = BigInt(ethers.keccak256(ethers.concat([poolId, h(6n)])));
  const tickSlot = (t: number) => BigInt(ethers.keccak256(ethers.concat([
    h(BigInt.asUintN(256, BigInt(t))), h(base + 4n)])));
  const posKey = ethers.keccak256(ethers.solidityPacked(
    ['address', 'int24', 'int24', 'bytes32'], [V4_PM[cc.key], tickLower, tickUpper, h(BigInt(tokenId))]));
  const posSlot = BigInt(ethers.keccak256(ethers.concat([posKey, h(base + 6n)])));

  const raw: string[] = await mgr['extsload(bytes32[])']([
    h(base), h(base + 1n), h(base + 2n),
    h(tickSlot(tickLower) + 1n), h(tickSlot(tickLower) + 2n),
    h(tickSlot(tickUpper) + 1n), h(tickSlot(tickUpper) + 2n),
    h(posSlot), h(posSlot + 1n), h(posSlot + 2n),
  ]);
  const [s0, fg0, fg1, lo0, lo1, up0, up1, pl, il0, il1] = raw.map((x) => BigInt(x));

  const sqrtPriceX96 = s0 & ((1n << 160n) - 1n);
  let tick = Number((s0 >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;

  // feeGrowthInside = global - below - above (the uint256 wrap-around is intentional).
  const M = 1n << 256n;
  const wrap = (x: bigint) => ((x % M) + M) % M;
  const below0 = tick >= tickLower ? lo0 : wrap(fg0 - lo0);
  const below1 = tick >= tickLower ? lo1 : wrap(fg1 - lo1);
  const above0 = tick < tickUpper ? up0 : wrap(fg0 - up0);
  const above1 = tick < tickUpper ? up1 : wrap(fg1 - up1);
  const L = pl & ((1n << 128n) - 1n);
  const fee0 = (wrap(wrap(fg0 - below0 - above0) - il0) * L) >> 128n;
  const fee1 = (wrap(wrap(fg1 - below1 - above1) - il1) * L) >> 128n;
  return { tick, sqrtPriceX96, fee0, fee1 };
}

export type V4Valuation = {
  amount0: bigint;
  amount1: bigint;
  base: 'ETH' | 'USDG' | null;
  baseIsCurrency0: boolean;
  valueBaseWei: bigint; // the position's value in base units (raw, base decimals): PRINCIPAL only
  feesBaseWei: bigint; // unclaimed fees, valued in the base (0 when no tokenId is given)
  rangePctHigh: number; // the near end as a % of the current price
  rangePctLow: number;
  inRange: boolean;
  currentTick: number;
  converted: boolean; // out of range with an empty base side: 100% in the other token, the target reached
};

/** Value a v4 position (token amounts, value in base, range %). */
export async function valuePositionV4(cc: ChainCtx, pk: PoolKeyV4, tickLower: number, tickUpper: number, liquidity: bigint, tokenId?: string): Promise<V4Valuation> {
  // With a tokenId, fetch fees at the same time (same RPC count). Without one (a
  // preview of a position not yet opened), read slot0 only and treat fees as 0.
  const { tick, sqrtPriceX96, fee0, fee1 } = tokenId
    ? await readPoolAndFees(cc, pk, tickLower, tickUpper, tokenId)
    : { ...(await readPoolState(cc, pk)), fee0: 0n, fee1: 0n };
  const sqrtL = sqrtAtTick(tickLower);
  const sqrtU = sqrtAtTick(tickUpper);
  const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, sqrtL, sqrtU, liquidity);
  const { base, baseIsCurrency0 } = pairBase(cc, pk.currency0, pk.currency1);
  // sqrtPriceX96 = sqrt(token1/token0)*Q96 (a raw ratio). Value in base terms:
  const p2 = sqrtPriceX96 * sqrtPriceX96; // (token1/token0)*Q96^2
  const inBase = (a0: bigint, a1: bigint) => baseIsCurrency0
    ? a0 + (p2 === 0n ? 0n : (a1 * Q96 * Q96) / p2)
    : a1 + (a0 * p2) / (Q96 * Q96);
  const valueBaseWei = inBase(amount0, amount1);
  const feesBaseWei = inBase(fee0, fee1);
  const sgn = baseIsCurrency0 ? -1 : 1;
  const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - tick)) - 1) * 100;
  const pcts = [pctOf(tickUpper), pctOf(tickLower)].sort((a, b) => b - a);
  const inRange = tick >= tickLower && tick < tickUpper;
  // An empty base side while out of range means price has crossed the WHOLE range,
  // leaving 100% of the other token (buy-the-dip: already converted, leg target met).
  const baseAmt = baseIsCurrency0 ? amount0 : amount1;
  return {
    amount0,
    amount1,
    base,
    baseIsCurrency0,
    valueBaseWei,
    feesBaseWei,
    rangePctHigh: pcts[0],
    rangePctLow: pcts[1],
    inRange,
    currentTick: tick,
    converted: !inRange && baseAmt === 0n,
  };
}

/** A compact v4 position status for the monitor: does it still exist, is it in range? */
export async function checkV4Status(
  cc: ChainCtx,
  tokenId: string,
): Promise<{ exists: boolean; inRange: boolean | null; tick: number | null; val: V4Valuation | null }> {
  // inRange null means UNKNOWN (RPC failed, or a chain with no PM). Do not map it to
  // false: that fires a bogus "OUT OF RANGE" alert that drives a money decision.
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) return { exists: true, inRange: null, tick: null, val: null };
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  try {
    const [pk, info] = await pm.getPoolAndPositionInfo(tokenId);
    const liquidity: bigint = await pm.getPositionLiquidity(tokenId);
    if (liquidity === 0n || (pk.currency0 === ethers.ZeroAddress && pk.currency1 === ethers.ZeroAddress)) {
      return { exists: false, inRange: false, tick: null, val: null };
    }
    const tickLower = signExt24((info >> 8n) & 0xffffffn);
    const tickUpper = signExt24((info >> 32n) & 0xffffffn);
    const poolKey: PoolKeyV4 = { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks };
    // valuePositionV4 uses ONE extsload that also carries slot0, so tick, value and
    // fees all arrive on the same RPC budget readPoolState used to need.
    const val = await valuePositionV4(cc, poolKey, tickLower, tickUpper, liquidity, tokenId);
    return { exists: true, inRange: val.inRange, tick: val.currentTick, val };
  } catch {
    return { exists: true, inRange: null, tick: null, val: null }; // transient: neither delete nor alert
  }
}
