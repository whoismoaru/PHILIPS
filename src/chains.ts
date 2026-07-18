import { ethers } from 'ethers';
import { config } from './config.js';
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
  key: string; // id internal ('robinhood' | 'ethereum' | 'base' | 'bsc')
  label: string; // tampilan
  chainId: number;
  nativeSymbol: string; // ETH / BNB
  dexKey: string; // chainId versi DexScreener
  blockscout: string | null; // base URL API explorer (null = tak tersedia)
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  factory: ethers.Contract;
  positionManager: ethers.Contract;
  weth: ethers.Contract;
  wethAddress: string;
  usdgAddress?: string; // hanya chain yg punya USDG (Global Dollar). undefined = tak ada.
  pmAddress: string;
  routerAddress: string;
  quoterAddress: string;
};

// --- Base asset (aset pasangan LP): WETH selalu ada; USDG opsional per chain. ---
export type BaseKind = 'weth' | 'usdg';
export type BaseAsset = {
  kind: BaseKind;
  address: string;
  decimals: number; // WETH 18, USDG 6 — KRITIS untuk parseUnits, JANGAN parseEther utk USDG
  symbol: string; // 'WETH' | 'USDG'
  wrappable: boolean; // WETH: bisa wrap dari ETH native. USDG: ERC20 biasa, harus sudah dipegang.
};

/** Daftar base asset yang tersedia di chain ini (WETH + USDG bila ada). */
export function basesFor(ctx: ChainCtx): BaseAsset[] {
  const out: BaseAsset[] = [
    { kind: 'weth', address: ctx.wethAddress, decimals: 18, symbol: 'WETH', wrappable: true },
  ];
  if (ctx.usdgAddress)
    out.push({ kind: 'usdg', address: ctx.usdgAddress, decimals: 6, symbol: 'USDG', wrappable: false });
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
const alchemyKey = /alchemy\.com\/v2\/([A-Za-z0-9_-]+)/.exec(config.chain.rpcUrl)?.[1] ?? '';

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
  ethereum: {
    label: 'Ethereum',
    chainId: 1,
    nativeSymbol: 'ETH',
    dexKey: 'ethereum',
    blockscout: 'https://eth.blockscout.com/api/v2',
    rpc:
      process.env.RPC_URL_ETHEREUM ||
      (alchemyKey ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://eth.llamarpc.com'),
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    pm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  base: {
    label: 'Base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    dexKey: 'base',
    blockscout: 'https://base.blockscout.com/api/v2',
    rpc:
      process.env.RPC_URL_BASE ||
      (alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://mainnet.base.org'),
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    pm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    weth: '0x4200000000000000000000000000000000000006',
  },
  bsc: {
    label: 'BSC',
    chainId: 56,
    nativeSymbol: 'BNB',
    dexKey: 'bsc',
    blockscout: null, // tidak ada Blockscout resmi — screening pakai DexScreener saja
    rpc:
      process.env.RPC_URL_BSC ||
      (alchemyKey ? `https://bnb-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://bsc-dataseed.binance.org'),
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    pm: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
    router: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  },
};

function build(key: string, d: Def): ChainCtx {
  const provider = new ethers.JsonRpcProvider(d.rpc, d.chainId);
  const wallet = new ethers.Wallet(config.wallet.privateKey, provider);
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
    usdgAddress: d.usdg,
    pmAddress: d.pm,
    routerAddress: d.router,
    quoterAddress: d.quoter,
  };
}

export const CHAINS: Record<string, ChainCtx> = Object.fromEntries(
  Object.entries(DEFS).map(([k, d]) => [k, build(k, d)]),
);

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
