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
  dexLabel: string; // nama DEX tempat posisi dibuka ('Uniswap' | 'PancakeSwap')
  venue?: string; // DEX non-bawaan di chain ini (mis. 'uniswapv3' di BSC); kosong = bawaan
  blockscout: string | null; // base URL API explorer (null = tak tersedia)
  provider: ethers.Provider; // JsonRpcProvider, atau FallbackProvider bila ada RPC cadangan
  /** Signer aktif. VoidSigner (alamat 0x0) bila belum ada dompet terhubung. */
  wallet: ethers.Wallet | ethers.VoidSigner;
  factory: ethers.Contract;
  positionManager: ethers.Contract;
  weth: ethers.Contract;
  wethAddress: string; // WETH canonical; ZeroAddress bila chain tak punya WETH (stablecoin-native)
  hasWethBase: boolean; // apakah WETH boleh jadi base LP di chain ini
  usdgAddress?: string; // hanya chain yg punya USDG (Global Dollar). undefined = tak ada.
  usdtAddress?: string; // hanya chain yg punya USDT. undefined = tak ada.
  usdcAddress?: string; // hanya chain yg punya USDC (mis. Base). undefined = tak ada.
  /** Aset pasangan LP yang tersedia di chain ini — desimal & simbolnya milik CHAIN,
   *  bukan konstanta global: USDG di Robinhood 6 desimal, USDT di BSC 18. */
  bases: BaseAsset[];
  /** Fee tier yang benar-benar terdaftar di factory chain ini, dan tick-spacing-nya.
   *  Uniswap: 100/500/3000/10000. PancakeSwap: 100/500/2500/10000 (tanpa 3000). */
  feeTiers: number[];
  tickSpacing: Record<number, number>;
  pmAddress: string;
  routerAddress: string;
  quoterAddress: string;
  /** Router memakai struct exactInputSingle BER-`deadline` (SwapRouter v3 asli /
   *  PancakeSwap). SwapRouter02 Uniswap membuangnya — struct yang salah = revert
   *  tanpa data, terbukti lewat staticCall di kedua bentuk. */
  routerHasDeadline: boolean;
  /** Venue = Velodrome Slipstream (fork Uni v3): pool per-tickSpacing, mint ber-sqrtPriceX96.
   *  Swap/close dialihkan ke agregator (Relay/LI.FI); router/quoter DEX tak dipakai. */
  slipstream: boolean;
};

// --- Base asset (aset pasangan LP). Per chain: WETH (bila hasWethBase), USDG dan/atau
// USDT (stablecoin 6-desimal). Chain stablecoin-native (mis. Stable) = USDT saja. ---
export type BaseKind = 'weth' | 'usdg' | 'usdt' | 'usdc';
export type BaseAsset = {
  kind: BaseKind;
  address: string;
  decimals: number; // WETH 18, USDG/USDT 6 — KRITIS untuk parseUnits, JANGAN parseEther utk stablecoin
  symbol: string; // 'WETH' | 'USDG' | 'USDT'
  wrappable: boolean; // WETH: bisa wrap dari ETH native. Stablecoin: ERC20 biasa, harus sudah dipegang.
};

/** true bila base ini stablecoin dolar (USDG/USDT/USDC ≈ $1, non-wrappable). */
export const isStableBase = (kind: BaseKind): boolean =>
  kind === 'usdg' || kind === 'usdt' || kind === 'usdc';

/**
 * Simbol tampilan sebuah base kind. Beri `ctx` bila tersedia: simbol wrapped-native
 * berbeda antar chain (WETH di Robinhood, WBNB di BSC), dan menampilkan 'WETH' di
 * BSC berarti menyebut aset yang tak pernah dipegang user.
 */
export const baseSymbolOf = (kind: BaseKind | undefined, ctx?: ChainCtx): string => {
  if (ctx) {
    const b = ctx.bases.find((x) => x.kind === (kind ?? 'weth'));
    if (b) return b.symbol;
  }
  return kind === 'usdg' ? 'USDG' : kind === 'usdt' ? 'USDT' : kind === 'usdc' ? 'USDC' : 'WETH';
};

/** Daftar base asset yang tersedia di chain ini. */
export function basesFor(ctx: ChainCtx): BaseAsset[] {
  return ctx.bases;
}

/** Base asset berdasarkan kind (fallback ke WETH bila kind tak tersedia di chain). */
export function baseOf(ctx: ChainCtx, kind: BaseKind): BaseAsset {
  return basesFor(ctx).find((b) => b.kind === kind) ?? basesFor(ctx)[0];
}

/**
 * Desimal base pada sebuah chain — SATU-SATUNYA sumber kebenaran.
 *
 * JANGAN pernah menulis `isStableBase(k) ? 6 : 18` lagi. USDG di Robinhood memang
 * 6, tapi USDT di BSC 18; menyamakannya menggeser setiap nominal 10^12 — jurnal
 * dan kartu PnL sempat memperlihatkan "48.000.000.000.000 USDT" untuk 48 USDT.
 * Terima `chain` yang mungkin undefined (entri lama) → jatuh ke chain utama.
 */
export function baseDecimalsOf(chain: string | undefined, kind: BaseKind | undefined): number {
  return baseOf(getChain(chain), kind ?? 'weth').decimals;
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

/** Default Uniswap v3 — dipakai chain yang tak menyebut sendiri. */
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
  },
  ...(config.bsc.enabled
    ? {
        bsc: {
          label: 'BSC',
          chainId: 56,
          nativeSymbol: 'BNB',
          dexKey: 'bsc',
          dexLabel: 'PancakeSwap',
          // BSC tak punya Blockscout publik: holders/verified/top-10 diambil dari GMGN,
          // dan v4Supported() otomatis false (memang tak ada v4 di PancakeSwap).
          blockscout: null,
          rpc: config.bsc.rpcUrl,
          // PancakeSwap v3 — fork Uniswap v3, ABI position manager identik.
          // Semua alamat diverifikasi on-chain (PM.factory & PM.WETH9 cocok).
          factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
          pm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
          router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', // PancakeSwap v3 SwapRouter
          quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', // QuoterV2
          weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
          usdt: '0x55d398326f99059fF775485246999027B3197955',
          wrappedSymbol: 'WBNB',
          // USDT di BSC 18 desimal — BUKAN 6 seperti USDG di Robinhood. Memakai 6 di
          // sini menggeser setiap nominal 10^12.
          stableDecimals: 18,
          // Terdaftar di factory Pancake: 100/500/2500/10000. 3000 TIDAK ADA.
          feeTiers: [100, 500, 2500, 10000],
          tickSpacing: { 100: 1, 500: 10, 2500: 50, 10000: 200 },
          noBatch: true,
          routerHasDeadline: true, // PancakeSwap v3 SwapRouter (diverifikasi staticCall)
          // RPC utama = BSC_RPC_URL (Alchemy). Down → otomatis pakai publik; pulih →
          // otomatis balik ke utama (FallbackProvider mengevaluasi prioritas tiap request).
          fallbackRpc: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
          // Broadcast lewat relay privat 48 Club (anti-sandwich). Kosongkan
          // BSC_PRIVATE_RPC='' untuk matikan (kembali ke mempool publik).
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
          // Base tak punya Blockscout publik yang dipakai bot: screening holders
          // /verified jatuh ke GMGN + DexScreener seperti BSC.
          blockscout: null,
          rpc: config.base.rpcUrl,
          // Uniswap v3 di Base — SEMUA alamat diverifikasi on-chain:
          // PM.factory() & PM.WETH9() cocok, keenam kontrak punya bytecode.
          factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
          pm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
          router: '0x2626664c2603336E57B271c5C0b26F421741e481', // SwapRouter02
          quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // QuoterV2
          weth: '0x4200000000000000000000000000000000000006',
          // Stablecoin utama di Base adalah USDC (6 desimal, terverifikasi on-chain),
          // bukan USDT/USDG — likuiditasnya jauh lebih dalam.
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
          // HyperEVM tak punya Blockscout publik yang dipakai bot: screening
          // holders/verified jatuh ke GMGN + DexScreener seperti BSC/Base.
          blockscout: null,
          rpc: config.hyperevm.rpcUrl,
          // HyperSwap v3 (fork Uniswap v3) — SEMUA alamat diverifikasi on-chain:
          // NFPM.factory() = factory & NFPM.WETH9() = WHYPE; router = ISwapRouter
          // (selector exactInputSingle ber-deadline 0x414bf389); quoter = QuoterV2.
          factory: '0xB1c0fa0B789320044A6F623cFe5eBda9562602E3',
          pm: '0x6eDA206207c09e5428F281761DdC0D300851fBC8',
          router: '0x4e2960a8cd19b467b82d26d83facb0fae26b094d',
          quoter: '0x03A918028f22D9E1473B7959C927AD7425A45C7C',
          weth: '0x5555555555555555555555555555555555555555', // WHYPE (18 desimal)
          wrappedSymbol: 'WHYPE',
          // Stablecoin dominan di HyperEVM: USDT0 (USD₮0), 6 desimal — terverifikasi on-chain.
          usdt: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
          usdtSymbol: 'USDT0',
          // Fee tier factory: 100/500/3000/10000 dengan tick-spacing Uniswap standar
          // (dibaca dari feeAmountTickSpacing) → default UNI_FEES/UNI_SPACING cocok.
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
          // Ink punya Blockscout publik → screening holders/verified bisa jalan.
          blockscout: 'https://explorer.inkonchain.com/api/v2',
          rpc: config.ink.rpcUrl,
          // Velodrome SLIPSTREAM (CL) deployment v1.2 — LIVE & berisi likuiditas.
          // BUKAN alamat repo resmi (yg kosong). Semua diverifikasi on-chain:
          // NFPM.factory()=factory & WETH9()=WETH; NFPM = "Slipstream Position NFT v1.2".
          // `fee` di seluruh kode = tickSpacing (int24) untuk venue ini.
          factory: '0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F', // CLFactory
          pm: '0x991d5546C4B442B4c5fdc4c8B8b8d131DEB24702', // NonfungiblePositionManager v1.2
          // Router & quoter Velodrome TIDAK dipakai: swap/close lewat Relay/LI.FI
          // (keduanya dukung Ink). Diisi router liquid utk kelengkapan; quoter kosong.
          router: '0x63951637d667f23D5251DEdc0f9123D22d8595be',
          quoter: '0x0000000000000000000000000000000000000000',
          weth: '0x4200000000000000000000000000000000000006', // WETH (gas Ink = ETH)
          usdt: '0x0200C29006150606B650577BBE7B6248F58470c1', // USDT0 (6 desimal) — stable terdalam
          usdtSymbol: 'USDT0',
          slipstream: true,
          // tickSpacing yang aktif di CLFactory (bukan fee-tier). Map identitas:
          // "fee" di kode = tickSpacing itu sendiri.
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
  // staticNetwork: chainId sudah kita ketahui — jangan buang satu round-trip deteksi.
  // batchMaxCount 1: RPC publik BSC menolak batch JSON-RPC, dan ethers membatch
  // secara default → seluruh pembacaan gagal serentak ("failed to detect network").
  const jsonOpts = { staticNetwork: true, ...(d.noBatch ? { batchMaxCount: 1 } : {}) };
  const mkJson = (url: string) => new ethers.JsonRpcProvider(url, d.chainId, jsonOpts);
  // Satu RPC → JsonRpcProvider biasa. Ada cadangan → FallbackProvider: utama
  // (priority 1) dipakai selama sehat; down/stall → jatuh ke publik; begitu utama
  // pulih, request berikutnya otomatis balik ke utama (quorum 1, evaluasi per-panggilan).
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

  // Proteksi MEV: broadcast tx lewat relay PRIVAT (mempool tak publik → tak bisa
  // disandwich). HANYA broadcast yang dialihkan; nonce/gas/wait tetap via provider
  // utama (relay privat kadang tak melayani baca receipt). Privat gagal → fallback
  // broadcast publik supaya tx TAK PERNAH gagal mendarat. Aktif bila d.privateRpc diset.
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
      // Lacak receipt via provider utama (bukan relay privat).
      resp.wait = (confirms?: number, timeout?: number) =>
        provider.waitForTransaction(resp.hash, confirms, timeout) as ReturnType<typeof resp.wait>;
      return resp;
    };
  }

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
 * VENUE = DEX kedua di chain yang SAMA.
 *
 * ChainCtx menyimpan satu set kontrak per chain, jadi BSC hanya bisa "melihat"
 * PancakeSwap. Padahal Uniswap v3 juga hidup di BSC dengan factory sendiri, dan
 * pool-nya sering justru yang terdalam untuk token tertentu (mis. SAUCE/USDT:
 * PancakeSwap TIDAK punya pool sama sekali, Uniswap v3 punya TVL $14,7k & volume
 * $263k/24j). Membuangnya berarti menyembunyikan pool single-side yang nyata.
 *
 * Venue TIDAK dimasukkan ke CHAINS: `Object.values(CHAINS)` dipakai untuk sapu
 * saldo/WETH per chain, dan chain yang muncul dua kali akan diproses dua kali.
 * Sebagai gantinya venueCtx() mengkloning ChainCtx dan menukar KONTRAK-nya saja —
 * provider, wallet, base, dan RPC tetap satu (tak ada koneksi/nonce tambahan).
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

// Alamat diverifikasi on-chain: PM.factory() cocok & PM.WETH9() = WBNB.
export const VENUES: Record<string, Record<string, VenueDef>> = {
  bsc: {
    uniswapv3: {
      dexLabel: 'Uniswap',
      factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
      pm: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
      router: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
      quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
      // Uniswap memakai 3000, PancakeSwap 2500 — jangan diwarisi.
      feeTiers: UNI_FEES,
      tickSpacing: UNI_SPACING,
    },
  },
};

/** Nama venue non-default yang tersedia di sebuah chain. */
export const venuesFor = (key: string): string[] => Object.keys(VENUES[key] ?? {});

/**
 * ChainCtx untuk sebuah venue. venue kosong / tak dikenal → ctx aslinya (DEX bawaan
 * chain). Wallet & provider dipakai ulang, jadi nonce tetap satu antrean.
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
/**
 * ChainCtx untuk sebuah record posisi/jurnal: chain + venue-nya. Posisi yang dibuka
 * di DEX non-bawaan (mis. Uniswap v3 di BSC) HARUS ditutup/dibaca lewat kontrak DEX
 * itu juga — memakai cc.factory chain akan menunjuk pool yang salah (atau nol).
 */
export const ctxOf = (rec: { chain?: string; venue?: string }): ChainCtx =>
  venueCtx(getChain(rec.chain), rec.venue);

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
