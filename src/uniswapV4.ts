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
function stableOf(cc: ChainCtx): { addr: string; symbol: string; decimals: number } | null {
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

const DYNAMIC_FEE_FLAG = 0x800000; // v4: fee bertanda dynamic

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
  base: 'ETH' | 'USDG' | null; // aset dasar pasangan (utk add/cash-out)
  poolKey: PoolKeyV4;
  valueBaseWei: bigint | null; // PRINSIPAL dlm base (null bila gagal baca harga)
  feesBaseWei: bigint | null; // fee belum diklaim, dlm base
  rangePctHigh: number | null; // % ujung terdekat dari harga sekarang
  rangePctLow: number | null;
  inRange: boolean | null;
  currentTick: number | null; // tick pool saat ini — kartu memakainya utk mcap "now"
  converted: boolean; // out-of-range & 100% token seberang (target tercapai)
  impliedTokenEthPrice: number | null; // harga token dlm ETH menurut slot0 pool INI (buat cek pool sekarat)
  // How much of the OTHER token this position holds. `valueBaseWei` marks it at the
  // current pool price, and that is NOT what you would receive: selling it moves the
  // price. The card uses this figure to request a real quote before calling anything
  // a "value".
  otherAmountWei: bigint | null;
  otherAddress: string | null;
  otherDecimals: number | null;
  baseAmountWei: bigint | null; // sisi base yang dipegang — ini tak perlu dijual
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

async function tokenSymbol(addr: string, cc: ChainCtx): Promise<string> {
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

async function walletV4TokenIds(cc: ChainCtx): Promise<string[]> {
  const pm = V4_PM[cc.key];
  if (!pm) return [];
  // Positions the bot manages are ALWAYS included: if Blockscout is down or lagging,
  // your v4 positions must not vanish from /positions (catch->[] used to make them
  // flicker as "out of sync").
  const ids = new Set(allV4().filter((r) => r.chain === cc.key).map((r) => r.tokenId));
  if (!cc.blockscout) return [...ids];
  enumDegraded = false;
  // Two attempts: Robinhood's Blockscout often fails BRIEFLY (a 3s abort, a 500, a
  // 503) and succeeds a second later. Treating one failure as broken put an "indexer
  // trouble" warning on nearly every /positions — and a warning that is always lit
  // stops being read. The second attempt gets a longer timeout.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
        // Blockscout returns ~50 items per page, and the wallet accumulates an EMPTY
        // v4 NFT on every close, so without pagination a live position can fall off
        // page 1.
      let url: string | null = `${cc.blockscout}/addresses/${cc.wallet.address}/nft?type=ERC-721`;
      for (let page = 0; url && page < 10; page++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), attempt === 0 ? 3000 : 8000);
        const res = await fetch(url, { headers: EXPLORER_HEADERS, signal: ctrl.signal }).finally(() =>
          clearTimeout(t),
        );
        if (!res.ok) throw new Error(`blockscout HTTP ${res.status}`);
        const j: any = await res.json();
        for (const x of j.items || []) {
          if ((x.token?.address_hash || x.token?.address || '').toLowerCase() === pm.toLowerCase()) ids.add(String(x.id));
        }
        const p = j.next_page_params;
        url = p ? `${cc.blockscout}/addresses/${cc.wallet.address}/nft?${new URLSearchParams(p as any)}` : null;
      }
      enumDegraded = false;
      break;
    } catch (e) {
      // Do not swallow this: an indexer failure that v4store happened to cover has to
      // be visible. And not only in the server log — whoever is looking at /positions
      // needs to know the list may be incomplete. This is what used to make positions
      // "disappear" for no apparent reason.
      enumDegraded = true;
      console.log(
        `[v4] enumerasi Blockscout gagal (percobaan ${attempt + 1}/2), pakai v4store saja:`,
        (e as Error).message.slice(0, 100),
      );
    }
  }
  return [...ids];
}

const signExt24 = (v: bigint): number => Number(v >= 1n << 23n ? v - (1n << 24n) : v);

// v4 Actions (v4-periphery libraries/Actions.sol)
const BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;
const V4_WRITE_ABI = [
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function ownerOf(uint256) view returns (address)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
];

/** Note attached to the close card when a v4 burn had to run without a price floor. */
export const V4_UNPROTECTED_NOTE = (ids: string) =>
  `⚠️ #${ids} withdrawn WITHOUT a price floor — the pool could not be priced, so sandwich protection was off for this close.`;

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
    console.log(`[v4] ⚠️ lantai slippage TAK tersedia (#${tokenId}) — burn tanpa proteksi harga:`, (e as Error).message.slice(0, 80));
    return { min0: 0n, min1: 0n, unprotected: true };
  }
}

/**
 * Close (burn) a v4 position: withdraw ALL liquidity plus fees, take both tokens to
 * the wallet, and burn the NFT — in a single modifyLiquidities (BURN_POSITION +
 * TAKE_PAIR). A staticCall simulation is MANDATORY first; a revert aborts before
 * anything is sent. dryRun simulates only.
 */
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
  leftover?: string;
  unprotected?: boolean; // burn terpaksa tanpa lantai harga
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
  await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address });
  if (opts.dryRun) return { dryRun: true, sym0, sym1, base, other: other ?? undefined, unprotected: mins.unprotected };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline));
  const rc = await tx.wait();
  const out: {
    txHash: string;
    sym0: string;
    sym1: string;
    base: 'ETH' | 'USDG' | null;
    other?: string; // alamat token non-base → dipakai jurnal & kandidat sweep
    cashedOut?: string;
    leftover?: string;
    unprotected?: boolean;
  } = {
    txHash: rc?.hash ?? tx.hash,
    sym0,
    sym1,
    base,
    other: other ?? undefined,
    unprotected: mins.unprotected,
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
        out.cashedOut = `${base} via ${r.route}`;
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
 * BATCH close of a v4 ladder: burn EVERY leg plus take (N x BURN_POSITION + 1 x
 * TAKE_PAIR) in one modifyLiquidities, then a SINGLE token->base swap and unwrap.
 * Returns the measured total baseOut (the base balance delta) for the caller to
 * split across legs.
 */
export async function closeLadderV4(
  tokenIds: string[],
  cc: ChainCtx,
  opts: { dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; base: 'ETH' | 'USDG' | null; other?: string; sym0: string; sym1: string; baseOutWei: bigint; cashedOut?: string; unprotected?: string[]; gone?: string[] }> {
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
  // Swap the whole token proceeds (aggregated across legs) to base in one go.
  if (base && other && other !== ethers.ZeroAddress) {
    try {
      const erc = new ethers.Contract(other, ['function balanceOf(address) view returns (uint256)'], cc.provider);
      const bal: bigint = await erc.balanceOf(cc.wallet.address);
      if (bal > 0n) {
        const r = base === 'ETH' ? await swapTokenToEthRobust(other, bal, cc) : await swapTokenToUsdgRobust(other, bal, stableOf(cc)!.addr, cc);
        cashedOut = `${base} via ${r.route}`;
      }
    } catch { /* token receh tetap di wallet */ }
  }
  if (base === 'ETH') {
    try {
      const wbal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (wbal > 0n) await (await cc.weth.withdraw(wbal)).wait();
    } catch { /* biarkan WETH */ }
  }
  const afterWei = await readBase();
  const baseOutWei = afterWei > beforeWei ? afterWei - beforeWei : 0n;
  return { txHash: rc?.hash ?? tx.hash, base, other: other ?? undefined, sym0, sym1, baseOutWei, cashedOut, unprotected: unprotectedIds, gone };
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
  listCache.set(ck, { t: Date.now(), v: out });
  return out;
}

/** Drop the v4 list cache (called after opening or closing so /positions stays fresh). */
export function invalidateV4ListCache(): void {
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
): Promise<{ liquidity: bigint; impliedTokenEthPrice: number | null }> {
  const liquidity = await readPoolLiquidity(cc, pk).catch(() => 0n);
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
  return { liquidity, impliedTokenEthPrice };
}

async function ensurePermit2(cc: ChainCtx, token: string, spender: string, amount: bigint): Promise<void> {
  const erc = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], cc.wallet);
  if ((await erc.allowance(cc.wallet.address, PERMIT2)) < amount) {
    await (await sendTxNonceSafe(cc.wallet as ethers.Wallet, await erc.approve.populateTransaction(PERMIT2, ethers.MaxUint256))).wait();
  }
  const p2 = new ethers.Contract(PERMIT2, ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)'], cc.wallet);
  const [amt] = await p2.allowance(cc.wallet.address, token, spender);
  if (BigInt(amt) < amount) {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await (await sendTxNonceSafe(cc.wallet as ethers.Wallet, await p2.approve.populateTransaction(token, spender, (1n << 160n) - 1n, exp))).wait();
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
  if (state.sqrtPriceX96 === 0n) throw new Error('This v4 pool is not initialised — pick another pool.');
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
      `[v4] liquidity 0 — pool=${poolKey.currency0}/${poolKey.currency1} fee=${poolKey.fee} spacing=${spacing}` +
        ` baseIsC0=${baseIsCurrency0} amountWei=${baseAmountWei} widthTicks=${tickUpper - tickLower} [${tickLower},${tickUpper}]`,
    );
    throw new Error(
      `Computed liquidity is 0 — the deposit is too small for this pool's range (spacing ${spacing}, width ${tickUpper - tickLower} ticks). Increase the amount, narrow the range %, or pick a finer-spacing pool.`,
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
  if (state.sqrtPriceX96 === 0n) throw new Error('This v4 pool is not initialised — pick another pool.');
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
    if (liquidity <= 0n) continue; // leg debu — lewati
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
async function readPoolState(cc: ChainCtx, pk: PoolKeyV4): Promise<{ tick: number; sqrtPriceX96: bigint }> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
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
async function readPoolLiquidity(cc: ChainCtx, pk: PoolKeyV4): Promise<bigint> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
  const base = BigInt(ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)])));
  const slot = ethers.zeroPadValue(ethers.toBeHex(base + 3n), 32);
  const raw = BigInt(await mgr.extsload(slot));
  return raw & ((1n << 128n) - 1n);
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
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'],
    [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
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
  valueBaseWei: bigint; // nilai posisi dalam unit base (raw, desimal base) — PRINSIPAL saja
  feesBaseWei: bigint; // fee belum diklaim, dinilai dalam base (0 bila tokenId tak diberi)
  rangePctHigh: number; // % ujung terdekat dari harga sekarang
  rangePctLow: number;
  inRange: boolean;
  currentTick: number;
  converted: boolean; // out-of-range & sisi base kosong → 100% token seberang (target tercapai)
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
    return { exists: true, inRange: null, tick: null, val: null }; // transien → jangan hapus & jangan alert
  }
}
