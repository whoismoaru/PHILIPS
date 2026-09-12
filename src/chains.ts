import { ethers } from 'ethers';
import { config } from './config.js';
import * as walletStore from './walletStore.js';
import {
  ERC20_ABI,
  WETH_ABI,
  FACTORY_ABI,
  POSITION_MANAGER_ABI,
  FACTORY_ABI_SLIP,
  POSITION_MANAGER_ABI_SLIP,
} from './chain.js';

/**
 * Multi-chain registry. Every EVM chain with an official Uniswap v3.
 * Contract addresses are Uniswap's canonical deployments (docs.uniswap.org),
 * verified on-chain via scripts/verify-chains.ts.
 */

export type ChainCtx = {
  key: string; // id internal — hanya 'robinhood'
  label: string; // tampilan
  chainId: number;
  nativeSymbol: string; // ETH / BNB
  dexKey: string; // chainId versi DexScreener
  dexLabel: string; // nama DEX tempat posisi dibuka ('Uniswap' | 'PancakeSwap')
  venue?: string; // DEX non-bawaan di chain ini (mis. 'uniswapv3' di BSC); kosong = bawaan
  blockscout: string | null; // base URL API explorer (null = tak tersedia)
  provider: ethers.Provider; // JsonRpcProvider, atau FallbackProvider bila ada RPC cadangan
  /** The active signer. A VoidSigner (address 0x0) when no wallet is connected. */
  wallet: ethers.Wallet | ethers.VoidSigner;
  factory: ethers.Contract;
  positionManager: ethers.Contract;
  weth: ethers.Contract;
  wethAddress: string; // WETH canonical; ZeroAddress bila chain tak punya WETH (stablecoin-native)
  hasWethBase: boolean; // apakah WETH boleh jadi base LP di chain ini
  usdgAddress?: string; // hanya chain yg punya USDG (Global Dollar). undefined = tak ada.
  usdtAddress?: string; // hanya chain yg punya USDT. undefined = tak ada.
  usdcAddress?: string; // hanya chain yg punya USDC (mis. Base). undefined = tak ada.
  /** LP pairing assets available on this chain. Decimals and symbols belong to the
   *  CHAIN, not to some global constant: USDG on Robinhood has 6 decimals, USDT on
   *  BSC has 18. */
  bases: BaseAsset[];
  /** Fee tiers actually registered in this chain's factory, with their tick spacing.
   *  Uniswap: 100/500/3000/10000. PancakeSwap: 100/500/2500/10000 (no 3000). */
  feeTiers: number[];
  tickSpacing: Record<number, number>;
  pmAddress: string;
  routerAddress: string;
  quoterAddress: string;
  /** Router takes an exactInputSingle struct WITH a `deadline` (the original v3
   *  SwapRouter, and PancakeSwap). Uniswap's SwapRouter02 dropped it, and the wrong
   *  struct reverts with no data — confirmed by staticCall against both shapes. */
  routerHasDeadline: boolean;
  /** Venue is Velodrome Slipstream (a Uni v3 fork): pools per tickSpacing, mint
   *  takes a sqrtPriceX96. Swap and close route through aggregators (Relay/LI.FI);
   *  the DEX's own router and quoter go unused. */
  slipstream: boolean;
};

// --- Base assets (LP pairing assets). Per chain: WETH (when hasWethBase), plus
// USDG and/or USDT. A stablecoin-native chain (Stable, say) carries USDT only. ---
export type BaseKind = 'weth' | 'usdg' | 'usdt' | 'usdc';
export type BaseAsset = {
  kind: BaseKind;
  address: string;
  decimals: number; // WETH 18, USDG/USDT 6 — KRITIS untuk parseUnits, JANGAN parseEther utk stablecoin
  symbol: string; // 'WETH' | 'USDG' | 'USDT'
  wrappable: boolean; // WETH: bisa wrap dari ETH native. Stablecoin: ERC20 biasa, harus sudah dipegang.
};

/** true when this base is a dollar stablecoin (USDG/USDT/USDC ~ $1, non-wrappable). */
export const isStableBase = (kind: BaseKind): boolean =>
  kind === 'usdg' || kind === 'usdt' || kind === 'usdc';

/**
 * Display symbol for a base kind. Pass `ctx` when you have it: the wrapped-native
 * symbol differs per chain (WETH on Robinhood, WBNB on BSC), and showing 'WETH' on
 * BSC names an asset the user never holds.
 */
/**
 * Per-tx gas cost ceiling in the native asset. 'off'/'0' removes it; empty uses the
 * default. A nonsensical value (not a number, negative) falls back to the default
 * rather than silently disabling the cap.
 */
const DEFAULT_MAX_TX_FEE = '0.005';
export function gasFeeCapLabel(): string | null {
  const c = parseFeeCap(config.safety.maxTxFeeNative);
  return c === null ? null : ethers.formatEther(c);
}
function parseFeeCap(raw: string): bigint | null {
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === '0') return null;
  const use = Number(v) > 0 ? v : DEFAULT_MAX_TX_FEE;
  return ethers.parseEther(use);
}

export const baseSymbolOf = (kind: BaseKind | undefined, ctx?: ChainCtx): string => {
  if (ctx) {
    const b = ctx.bases.find((x) => x.kind === (kind ?? 'weth'));
    if (b) return b.symbol;
  }
  return kind === 'usdg' ? 'USDG' : kind === 'usdt' ? 'USDT' : kind === 'usdc' ? 'USDC' : 'WETH';
};

/**
 * Pair label for cards and messages. The `symbol` on a position record is NOT
 * uniform: some are already pairs ('AGI/USDG', 'USDG/CLAN'), some are just a token
 * name ('PONS'). Appending the base blindly produces 'USDG / AGI/USDG'. When a pair
 * is already there, the side matching the base is dropped and the rest is used.
 */
export const pairLabel = (baseSym: string, symbol: string): string => {
  const parts = symbol.split('/').map((x) => x.trim()).filter(Boolean);
  const other = parts.length > 1 ? parts.find((x) => x.toLowerCase() !== baseSym.toLowerCase()) : undefined;
  return `${baseSym} / ${other ?? parts[parts.length - 1] ?? symbol}`;
};

/** Base assets available on this chain. */
export function basesFor(ctx: ChainCtx): BaseAsset[] {
  return ctx.bases;
}

/** Base asset by kind, falling back to WETH when the kind is absent on this chain. */
export function baseOf(ctx: ChainCtx, kind: BaseKind): BaseAsset {
  return basesFor(ctx).find((b) => b.kind === kind) ?? basesFor(ctx)[0];
}

/**
 * Base decimals on a chain — the ONLY source of truth.
 *
 * NEVER write `isStableBase(k) ? 6 : 18` again. USDG on Robinhood really is 6, but
 * USDT on BSC is 18; treating them alike shifts every amount by 10^12 — the journal
 * and PnL cards once showed "48,000,000,000,000 USDT" for 48 USDT. Accepts a
 * possibly-undefined `chain` (older entries) and falls back to the main chain.
 */
export function baseDecimalsOf(chain: string | undefined, kind: BaseKind | undefined): number {
  return baseOf(getChain(chain), kind ?? 'weth').decimals;
}

/** Detect the base from a pool's (token0, token1). null when it is not a base pool. */
export function detectBase(ctx: ChainCtx, token0: string, token1: string): BaseAsset | null {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  for (const b of basesFor(ctx)) {
    const a = b.address.toLowerCase();
    if (a === t0 || a === t1) return b;
  }
  return null;
}
// Reuse the Alchemy API key from the already-configured robinhood RPC.
type Def = {
  label: string;
  chainId: number;
  nativeSymbol: string;
  dexKey: string;
  dexLabel?: string; // default 'Uniswap'
  blockscout: string | null;
  rpc: string;
  factory: string;
  pm: string;
  router: string;
  quoter: string;
  weth: string;
  usdg?: string;
  usdt?: string;
  usdc?: string;
  usdcDecimals?: number; // default 6 (USDC di semua chain besar)
  hasWethBase?: boolean; // default true; false utk chain stablecoin-native
  wrappedSymbol?: string; // simbol wrapped-native (default 'WETH'; BSC 'WBNB')
  usdtSymbol?: string; // simbol token USDT di chain ini (default 'USDT'; HyperEVM 'USDT0')
  stableDecimals?: number; // desimal USDG/USDT di chain ini (default 6; BSC USDT 18)
  feeTiers?: number[]; // default fee tier Uniswap v3
  tickSpacing?: Record<number, number>; // default pemetaan Uniswap v3
  noBatch?: boolean; // RPC publik yang menolak JSON-RPC batch (mis. bsc-dataseed)
  slipstream?: boolean; // venue Velodrome Slipstream (ABI int24 tickSpacing + mint sqrtPriceX96)
  routerHasDeadline?: boolean; // default false (SwapRouter02 Uniswap)
  fallbackRpc?: string[]; // RPC cadangan bila `rpc` utama down (FallbackProvider, prioritas)
  privateRpc?: string; // relay privat utk broadcast tx (proteksi MEV/sandwich)
};

/** Uniswap v3 defaults, used by any chain that does not state its own. */
const UNI_FEES = [100, 500, 3000, 10000];
const UNI_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const DEFS: Record<string, Def> = {
  robinhood: {
    label: 'Robinhood',
    chainId: config.chain.chainId,
    nativeSymbol: 'ETH',
    dexKey: 'robinhood',
    blockscout: 'https://robinhoodchain.blockscout.com/api/v2',
    rpc: config.chain.rpcUrl,
    factory: config.uniswap.factory,
    pm: config.uniswap.positionManager,
    router: config.uniswap.swapRouter,
    quoter: config.uniswap.quoter,
    weth: config.uniswap.weth,
    usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // Global Dollar (USDG), 6 desimal — terverifikasi on-chain
    // Alchemy stays primary. The backups take over on 403/503/stall — both have
    // been tested serving eth_call, eth_getCode and eth_getLogs (the old StableChain
    // RPC failed on exactly those, see .env line 40).
    fallbackRpc: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
  },
  ...(config.bsc.enabled
    ? {
        bsc: {
          label: 'BSC',
          chainId: 56,
          nativeSymbol: 'BNB',
          dexKey: 'bsc',
          dexLabel: 'PancakeSwap',
          // BSC has no public Blockscout: holders/verified/top-10 come from GMGN,
          // and v4Supported() is false automatically (PancakeSwap has no v4).
          blockscout: null,
          rpc: config.bsc.rpcUrl,
          // PancakeSwap v3 — a Uniswap v3 fork with an identical position-manager
          // ABI. Every address verified on-chain (PM.factory and PM.WETH9 match).
          factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
          pm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
          router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', // PancakeSwap v3 SwapRouter
          quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', // QuoterV2
          weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
          usdt: '0x55d398326f99059fF775485246999027B3197955',
          wrappedSymbol: 'WBNB',
          // USDT on BSC has 18 decimals, NOT 6 like USDG on Robinhood. Using 6 here
          // shifts every amount by 10^12.
          stableDecimals: 18,
          // Registered in Pancake's factory: 100/500/2500/10000. 3000 does NOT exist.
          feeTiers: [100, 500, 2500, 10000],
          tickSpacing: { 100: 1, 500: 10, 2500: 50, 10000: 200 },
          noBatch: true,
          routerHasDeadline: true, // PancakeSwap v3 SwapRouter (diverifikasi staticCall)
          // Primary RPC is BSC_RPC_URL (Alchemy). If it goes down the public one
          // takes over, and once it recovers the next request returns to it
          // (FallbackProvider re-evaluates priority per request).
          fallbackRpc: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
          // Broadcast through 48 Club's private relay (anti-sandwich). Set
          // BSC_PRIVATE_RPC='' to disable and fall back to the public mempool.
          privateRpc: process.env.BSC_PRIVATE_RPC ?? 'https://rpc-bsc.48.club',
        },
      }
    : {}),
  ...(config.base.enabled
    ? {
        base: {
          label: 'Base',
          chainId: 8453,
          nativeSymbol: 'ETH',
          dexKey: 'base',
          // Base has no public Blockscout the bot uses: holders/verified screening
          // falls back to GMGN + DexScreener, same as BSC.
          blockscout: null,
          rpc: config.base.rpcUrl,
          // Uniswap v3 on Base — EVERY address verified on-chain: PM.factory() and
          // PM.WETH9() match, and all six contracts carry bytecode.
          factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
          pm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
          router: '0x2626664c2603336E57B271c5C0b26F421741e481', // SwapRouter02
          quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // QuoterV2
          weth: '0x4200000000000000000000000000000000000006',
          // The main stablecoin on Base is USDC (6 decimals, verified on-chain),
          // not USDT or USDG: its liquidity is far deeper.
          usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          fallbackRpc: ['https://mainnet.base.org'],
        },
      }
    : {}),
  ...(config.hyperevm.enabled
    ? {
        hyperevm: {
          label: 'HyperEVM',
          chainId: 999,
          nativeSymbol: 'HYPE',
          dexKey: 'hyperevm', // key chain versi DexScreener (BUKAN 'hyperliquid')
          dexLabel: 'HyperSwap',
          // HyperEVM has no public Blockscout the bot uses: holders/verified
          // screening falls back to GMGN + DexScreener, same as BSC and Base.
          blockscout: null,
          rpc: config.hyperevm.rpcUrl,
          // HyperSwap v3 (a Uniswap v3 fork) — EVERY address verified on-chain:
          // NFPM.factory() is the factory and NFPM.WETH9() is WHYPE; the router is an
          // ISwapRouter (exactInputSingle-with-deadline selector 0x414bf389); the
          // quoter is a QuoterV2.
          factory: '0xB1c0fa0B789320044A6F623cFe5eBda9562602E3',
          pm: '0x6eDA206207c09e5428F281761DdC0D300851fBC8',
          router: '0x4e2960a8cd19b467b82d26d83facb0fae26b094d',
          quoter: '0x03A918028f22D9E1473B7959C927AD7425A45C7C',
          weth: '0x5555555555555555555555555555555555555555', // WHYPE (18 desimal)
          wrappedSymbol: 'WHYPE',
          // The dominant stablecoin on HyperEVM: USDT0 (USD-T0), 6 decimals, verified on-chain.
          usdt: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
          usdtSymbol: 'USDT0',
          // Factory fee tiers: 100/500/3000/10000 with standard Uniswap tick spacing
          // (read from feeAmountTickSpacing), so the UNI_FEES/UNI_SPACING defaults fit.
          routerHasDeadline: true, // ISwapRouter (bukan SwapRouter02) — struct ber-deadline
          fallbackRpc: ['https://rpc.hyperliquid.xyz/evm'],
        },
      }
    : {}),
  ...(config.ink.enabled
    ? {
        ink: {
          label: 'Ink',
          chainId: 57073,
          nativeSymbol: 'ETH',
          dexKey: 'ink', // key chain versi DexScreener
          dexLabel: 'Velodrome',
          // Ink does have a public Blockscout, so holders/verified screening works.
          blockscout: 'https://explorer.inkonchain.com/api/v2',
          rpc: config.ink.rpcUrl,
          // Velodrome SLIPSTREAM (CL) deployment v1.2 — LIVE and holding liquidity.
          // NOT the addresses from the official repo (those are empty). All verified
          // on-chain: NFPM.factory() is the factory, WETH9() is WETH, and NFPM reports
          // "Slipstream Position NFT v1.2". Throughout the code `fee` means tickSpacing
          // (int24) for this venue.
          factory: '0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F', // CLFactory
          pm: '0x991d5546C4B442B4c5fdc4c8B8b8d131DEB24702', // NonfungiblePositionManager v1.2
          // Velodrome's router and quoter go UNUSED: swap and close run through
          // Relay/LI.FI (both support Ink). The router is filled in for completeness;
          // the quoter is left empty.
          router: '0x63951637d667f23D5251DEdc0f9123D22d8595be',
          quoter: '0x0000000000000000000000000000000000000000',
          weth: '0x4200000000000000000000000000000000000006', // WETH (gas Ink = ETH)
          usdt: '0x0200C29006150606B650577BBE7B6248F58470c1', // USDT0 (6 desimal) — stable terdalam
          usdtSymbol: 'USDT0',
          slipstream: true,
          // The tick spacings active in CLFactory, not fee tiers. Identity map: "fee"
          // in the code is the tickSpacing itself.
          feeTiers: [1, 10, 50, 100, 200, 2000],
          tickSpacing: { 1: 1, 10: 10, 50: 50, 100: 100, 200: 200, 2000: 2000 },
          fallbackRpc: ['https://rpc-qnd.inkonchain.com'],
        },
      }
    : {}),
};

function basesOf(d: Def): BaseAsset[] {
  const out: BaseAsset[] = [];
  const stableDec = d.stableDecimals ?? 6;
  if (d.hasWethBase ?? true)
    out.push({ kind: 'weth', address: d.weth, decimals: 18, symbol: d.wrappedSymbol ?? 'WETH', wrappable: true });
  if (d.usdg) out.push({ kind: 'usdg', address: d.usdg, decimals: stableDec, symbol: 'USDG', wrappable: false });
  if (d.usdt) out.push({ kind: 'usdt', address: d.usdt, decimals: stableDec, symbol: d.usdtSymbol ?? 'USDT', wrappable: false });
  if (d.usdc) out.push({ kind: 'usdc', address: d.usdc, decimals: d.usdcDecimals ?? 6, symbol: 'USDC', wrappable: false });
  return out;
}

function build(key: string, d: Def): ChainCtx {
  // staticNetwork: we already know the chainId, so do not spend a round-trip
  // detecting it. batchMaxCount 1: public BSC RPCs reject batched JSON-RPC and
  // ethers batches by default, which failed every read at once ("failed to detect
  // network").
  const jsonOpts = { staticNetwork: true, ...(d.noBatch ? { batchMaxCount: 1 } : {}) };
  const mkJson = (url: string) => new ethers.JsonRpcProvider(url, d.chainId, jsonOpts);
  // One RPC gives a plain JsonRpcProvider. With a backup it becomes a
  // FallbackProvider: the primary (priority 1) is used while healthy; on a
  // failure or stall it falls to the public one, and as soon as the primary
  // recovers the next request returns to it (quorum 1, evaluated per call).
  const provider: ethers.Provider =
    d.fallbackRpc && d.fallbackRpc.length
      ? new ethers.FallbackProvider(
          [
            { provider: mkJson(d.rpc), priority: 1, stallTimeout: 1500, weight: 1 },
            ...d.fallbackRpc.map((u, i) => ({ provider: mkJson(u), priority: 2 + i, stallTimeout: 1500, weight: 1 })),
          ],
          d.chainId,
          { quorum: 1 },
        )
      : mkJson(d.rpc);

  // MEV protection: broadcast through a PRIVATE relay, so the tx never hits the
  // public mempool and cannot be sandwiched. ONLY the broadcast is diverted; nonce,
  // gas and wait still go through the main provider, because private relays often
  // will not serve receipt reads. If the private path fails it falls back to a
  // public broadcast so a tx NEVER fails to land. Active when d.privateRpc is set.
  if (d.privateRpc) {
    const priv = mkJson(d.privateRpc);
    const publicBroadcast = provider.broadcastTransaction.bind(provider);
    provider.broadcastTransaction = async (signedTx: string) => {
      let resp;
      try {
        resp = await priv.broadcastTransaction(signedTx);
      } catch (e) {
        console.log('[mev] broadcast privat gagal, pakai publik:', (e as Error).message.slice(0, 80));
        return publicBroadcast(signedTx);
      }
      // Track the receipt through the main provider, not the private relay.
      resp.wait = (confirms?: number, timeout?: number) =>
        provider.waitForTransaction(resp.hash, confirms, timeout) as ReturnType<typeof resp.wait>;
      return resp;
    };
  }

  // GAS COST CEILING. Gas is fetched from the network with no upper bound, so a
  // single spike — or an RPC returning a nonsense fee — would be paid whatever it
  // came to. Checked at the broadcast point so EVERY path is covered: ordinary
  // contract calls, sendTxNonceSafe, and raw txs from aggregators alike, not just
  // whatever happens to go through one helper. A 400k-gas tx costs ~0.00003 native
  // on all five chains, so the 0.005 default leaves ~170x of headroom: it never
  // interferes with normal operation but still stops something genuinely wild.
  const feeCap = parseFeeCap(config.safety.maxTxFeeNative);
  if (feeCap !== null) {
    const beforeCap = provider.broadcastTransaction.bind(provider);
    provider.broadcastTransaction = async (signedTx: string) => {
      const parsed = ethers.Transaction.from(signedTx);
      const price = parsed.maxFeePerGas ?? parsed.gasPrice ?? 0n;
      const worst = price * (parsed.gasLimit ?? 0n);
      if (worst > feeCap) {
        throw new Error(
          `Gas fee ceiling hit: this transaction could cost up to ${ethers.formatEther(worst)} ${d.nativeSymbol} ` +
            `(ceiling ${ethers.formatEther(feeCap)}). Nothing was sent. Wait for gas to drop, or raise MAX_TX_FEE_NATIVE.`,
        );
      }
      return beforeCap(signedTx);
    };
  }

  // No wallet connected yet gives a VoidSigner: READS keep working (balances,
  // positions, token audits) while WRITES fail loudly instead of using a ghost key.
  const wallet: ethers.Wallet | ethers.VoidSigner =
    walletStore.signerFor(provider) ?? new ethers.VoidSigner(ethers.ZeroAddress, provider);
  return {
    key,
    label: d.label,
    chainId: d.chainId,
    nativeSymbol: d.nativeSymbol,
    dexKey: d.dexKey,
    dexLabel: d.dexLabel ?? 'Uniswap',
    blockscout: d.blockscout,
    provider,
    wallet,
    factory: new ethers.Contract(d.factory, d.slipstream ? FACTORY_ABI_SLIP : FACTORY_ABI, wallet),
    positionManager: new ethers.Contract(d.pm, d.slipstream ? POSITION_MANAGER_ABI_SLIP : POSITION_MANAGER_ABI, wallet),
    weth: new ethers.Contract(d.weth, WETH_ABI, wallet),
    wethAddress: d.weth,
    hasWethBase: d.hasWethBase ?? true,
    usdgAddress: d.usdg,
    usdtAddress: d.usdt,
    usdcAddress: d.usdc,
    pmAddress: d.pm,
    routerAddress: d.router,
    quoterAddress: d.quoter,
    routerHasDeadline: d.routerHasDeadline ?? false,
    slipstream: d.slipstream ?? false,
    bases: basesOf(d),
    feeTiers: d.feeTiers ?? UNI_FEES,
    tickSpacing: d.tickSpacing ?? UNI_SPACING,
  };
}

/**
 * A VENUE is a second DEX on the SAME chain.
 *
 * ChainCtx holds one contract set per chain, so BSC could only ever "see"
 * PancakeSwap. Yet Uniswap v3 lives on BSC too, with its own factory, and its pools
 * are often the deepest for a given token (SAUCE/USDT, for instance: PancakeSwap
 * has no pool at all, while Uniswap v3 holds $14.7k TVL on $263k of 24h volume).
 * Dropping it means hiding real single-sided pools.
 *
 * Venues are deliberately kept OUT of CHAINS: `Object.values(CHAINS)` drives the
 * per-chain balance and WETH sweeps, and a chain appearing twice would be processed
 * twice. Instead venueCtx() clones the ChainCtx and swaps only its CONTRACTS —
 * provider, wallet, bases and RPC stay shared, so there is no extra connection and
 * no second nonce queue.
 */
export type VenueDef = {
  dexLabel: string;
  factory: string;
  pm: string;
  router: string;
  quoter: string;
  feeTiers?: number[];
  tickSpacing?: Record<number, number>;
  routerHasDeadline?: boolean;
};

// Addresses verified on-chain: PM.factory() matches and PM.WETH9() is WBNB.
export const VENUES: Record<string, Record<string, VenueDef>> = {
  bsc: {
    uniswapv3: {
      dexLabel: 'Uniswap',
      factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
      pm: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
      router: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
      quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
      // Uniswap uses 3000, PancakeSwap 2500 — do not inherit it.
      feeTiers: UNI_FEES,
      tickSpacing: UNI_SPACING,
    },
  },
};

/** Names of the non-default venues available on a chain. */
export const venuesFor = (key: string): string[] => Object.keys(VENUES[key] ?? {});

/**
 * ChainCtx for a venue. An empty or unknown venue returns the original ctx (the
 * chain's default DEX). Wallet and provider are reused, so the nonce queue stays
 * single-file.
 */
export function venueCtx(cc: ChainCtx, venue?: string): ChainCtx {
  if (!venue) return cc;
  const v = VENUES[cc.key]?.[venue];
  if (!v) return cc;
  return {
    ...cc,
    dexLabel: v.dexLabel,
    factory: new ethers.Contract(v.factory, FACTORY_ABI, cc.wallet),
    positionManager: new ethers.Contract(v.pm, POSITION_MANAGER_ABI, cc.wallet),
    pmAddress: v.pm,
    routerAddress: v.router,
    quoterAddress: v.quoter,
    routerHasDeadline: v.routerHasDeadline ?? false,
    feeTiers: v.feeTiers ?? cc.feeTiers,
    tickSpacing: v.tickSpacing ?? cc.tickSpacing,
    venue,
  };
}

// Built LAZILY and rebuildable: a new wallet only exists after /connect, and the
// contracts hold their signer inside. The Proxy exists so the ~100 places that use
// `CHAINS[...]` / `Object.values(CHAINS)` need no changes at all.
let ctxCache: Record<string, ChainCtx> | null = null;
function chains(): Record<string, ChainCtx> {
  // Self-heal a cache built before the wallet existed. The first module to touch
  // CHAINS decides what every context holds, and if that happened before the keystore
  // was readable, every chain froze around a VoidSigner -- reads kept working, so the
  // only symptom was an address of 0x0 on cards, while every write would have failed.
  // rebuildChains() alone does not cover it: it is called on /connect, and a wallet
  // adopted from .env never goes through /connect.
  if (ctxCache && walletStore.isConnected()) {
    const anyCtx = Object.values(ctxCache)[0];
    if (anyCtx && anyCtx.wallet.address === ethers.ZeroAddress) ctxCache = null;
  }
  if (!ctxCache) ctxCache = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, build(k, d)]));
  return ctxCache;
}

/** Call after connect/disconnect: existing contracts still hold the old signer. */
export function rebuildChains(): void {
  ctxCache = null;
}

export const CHAINS: Record<string, ChainCtx> = new Proxy({} as Record<string, ChainCtx>, {
  get: (_t, k: string) => chains()[k],
  has: (_t, k: string) => k in chains(),
  ownKeys: () => Reflect.ownKeys(chains()),
  getOwnPropertyDescriptor: (_t, k: string) => ({
    value: chains()[k],
    enumerable: true,
    configurable: true,
  }),
});

export const DEFAULT_CHAIN = 'robinhood';
/**
 * ChainCtx for a position or journal record: its chain plus its venue. A position
 * opened on a non-default DEX (Uniswap v3 on BSC, say) MUST be closed and read
 * through that DEX's contracts too — using the chain's cc.factory would point at
 * the wrong pool, or at nothing.
 */
export const ctxOf = (rec: { chain?: string; venue?: string }): ChainCtx =>
  venueCtx(getChain(rec.chain), rec.venue);

export const getChain = (key?: string): ChainCtx => CHAINS[key ?? DEFAULT_CHAIN] ?? CHAINS[DEFAULT_CHAIN];

/** Detect which chains this token address EXISTS on (has contract code). */
export async function detectChains(tokenAddress: string): Promise<ChainCtx[]> {
  const checks = await Promise.all(
    Object.values(CHAINS).map(async (c) => {
      try {
        const code = await c.provider.getCode(tokenAddress);
        return code && code !== '0x' ? c : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((c): c is ChainCtx => c !== null);
}

/** Re-export the ERC20 ABI for cross-module use. */
export { ERC20_ABI };
