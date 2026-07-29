import { ethers } from 'ethers';
import { config } from './config.js';
import * as walletStore from './walletStore.js';
import {
  ERC20_ABI,
  WETH_ABI,
  FACTORY_ABI,
  POSITION_MANAGER_ABI,
} from './chain.js';

/**
 * Registry multi-chain. Semua chain EVM dengan Uniswap v3 resmi.
 * Alamat kontrak = deployment kanonik Uniswap (docs.uniswap.org) —
 * diverifikasi on-chain lewat scripts/verify-chains.ts.
 */

export type ChainCtx = {
  key: string; // id internal — hanya 'robinhood'
  label: string; // tampilan
  chainId: number;
  nativeSymbol: string; // ETH / BNB
  dexKey: string; // chainId versi DexScreener
  blockscout: string | null; // base URL API explorer (null = tak tersedia)
  provider: ethers.JsonRpcProvider;
  /** Signer aktif. VoidSigner (alamat 0x0) bila belum ada dompet terhubung. */
  wallet: ethers.Wallet | ethers.VoidSigner;
  factory: ethers.Contract;
  positionManager: ethers.Contract;
  weth: ethers.Contract;
  wethAddress: string; // WETH canonical; ZeroAddress bila chain tak punya WETH (stablecoin-native)
  hasWethBase: boolean; // apakah WETH boleh jadi base LP di chain ini
  usdgAddress?: string; // hanya chain yg punya USDG (Global Dollar). undefined = tak ada.
  usdtAddress?: string; // hanya chain yg punya USDT (mis. Stable). undefined = tak ada.
  pmAddress: string;
  routerAddress: string;
  quoterAddress: string;
};

// --- Base asset (aset pasangan LP). Per chain: WETH (bila hasWethBase), USDG dan/atau
// USDT (stablecoin 6-desimal). Chain stablecoin-native (mis. Stable) = USDT saja. ---
export type BaseKind = 'weth' | 'usdg' | 'usdt';
export type BaseAsset = {
  kind: BaseKind;
  address: string;
  decimals: number; // WETH 18, USDG/USDT 6 — KRITIS untuk parseUnits, JANGAN parseEther utk stablecoin
  symbol: string; // 'WETH' | 'USDG' | 'USDT'
  wrappable: boolean; // WETH: bisa wrap dari ETH native. Stablecoin: ERC20 biasa, harus sudah dipegang.
};

/** true bila base ini stablecoin dolar (USDG/USDT ≈ $1, 6-desimal, non-wrappable). */
export const isStableBase = (kind: BaseKind): boolean => kind === 'usdg' || kind === 'usdt';

/** Simbol tampilan sebuah base kind. */
export const baseSymbolOf = (kind: BaseKind | undefined): string =>
  kind === 'usdg' ? 'USDG' : kind === 'usdt' ? 'USDT' : 'WETH';

/** Daftar base asset yang tersedia di chain ini. */
export function basesFor(ctx: ChainCtx): BaseAsset[] {
  const out: BaseAsset[] = [];
  if (ctx.hasWethBase)
    out.push({ kind: 'weth', address: ctx.wethAddress, decimals: 18, symbol: 'WETH', wrappable: true });
  if (ctx.usdgAddress)
    out.push({ kind: 'usdg', address: ctx.usdgAddress, decimals: 6, symbol: 'USDG', wrappable: false });
  if (ctx.usdtAddress)
    out.push({ kind: 'usdt', address: ctx.usdtAddress, decimals: 6, symbol: 'USDT', wrappable: false });
  return out;
}

/** Base asset berdasarkan kind (fallback ke WETH bila kind tak tersedia di chain). */
export function baseOf(ctx: ChainCtx, kind: BaseKind): BaseAsset {
  return basesFor(ctx).find((b) => b.kind === kind) ?? basesFor(ctx)[0];
}

/** Deteksi base dari pasangan (token0, token1) sebuah pool. null bila bukan pool base. */
export function detectBase(ctx: ChainCtx, token0: string, token1: string): BaseAsset | null {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  for (const b of basesFor(ctx)) {
    const a = b.address.toLowerCase();
    if (a === t0 || a === t1) return b;
  }
  return null;
}
// Ambil API key Alchemy dari RPC robinhood yang sudah dikonfigurasi.
type Def = {
  label: string;
  chainId: number;
  nativeSymbol: string;
  dexKey: string;
  blockscout: string | null;
  rpc: string;
  factory: string;
  pm: string;
  router: string;
  quoter: string;
  weth: string;
  usdg?: string;
  usdt?: string;
  hasWethBase?: boolean; // default true; false utk chain stablecoin-native (Stable)
};

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
  },
};

// Hanya Robinhood. Antar-chain ke depan = Robinhood <-> Solana (belum diimplementasi).

function build(key: string, d: Def): ChainCtx {
  const provider = new ethers.JsonRpcProvider(d.rpc, d.chainId);
  // Belum ada dompet terhubung → VoidSigner: BACA tetap jalan (saldo, posisi,
  // audit token), TULIS gagal terang-terangan alih-alih memakai kunci hantu.
  const wallet: ethers.Wallet | ethers.VoidSigner =
    walletStore.signerFor(provider) ?? new ethers.VoidSigner(ethers.ZeroAddress, provider);
  return {
    key,
    label: d.label,
    chainId: d.chainId,
    nativeSymbol: d.nativeSymbol,
    dexKey: d.dexKey,
    blockscout: d.blockscout,
    provider,
    wallet,
    factory: new ethers.Contract(d.factory, FACTORY_ABI, wallet),
    positionManager: new ethers.Contract(d.pm, POSITION_MANAGER_ABI, wallet),
    weth: new ethers.Contract(d.weth, WETH_ABI, wallet),
    wethAddress: d.weth,
    hasWethBase: d.hasWethBase ?? true,
    usdgAddress: d.usdg,
    usdtAddress: d.usdt,
    pmAddress: d.pm,
    routerAddress: d.router,
    quoterAddress: d.quoter,
  };
}

// Dibangun MALAS dan bisa dibangun ulang: dompet baru ada setelah /connect,
// dan kontrak menyimpan signer-nya di dalam. Proxy dipakai supaya ~100 titik
// pemakaian `CHAINS[...]` / `Object.values(CHAINS)` tak perlu diubah sama sekali.
let ctxCache: Record<string, ChainCtx> | null = null;
function chains(): Record<string, ChainCtx> {
  if (!ctxCache) ctxCache = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, build(k, d)]));
  return ctxCache;
}

/** Panggil setelah connect/disconnect: kontrak lama masih memegang signer lama. */
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
export const getChain = (key?: string): ChainCtx => CHAINS[key ?? DEFAULT_CHAIN] ?? CHAINS[DEFAULT_CHAIN];

/** Deteksi di chain mana alamat token ini ADA (punya kode kontrak). */
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

/** Ekspor ABI ERC20 untuk pemakaian lintas modul. */
export { ERC20_ABI };
