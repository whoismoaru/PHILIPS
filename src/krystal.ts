import { ethers } from 'ethers';
import { config } from './config.js';
import type { ChainCtx } from './chains.js';
import type { TokenPool } from './explore.js';
import type { PoolKeyV4 } from './uniswapV4.js';

/**
 * Sumber pool via Krystal Cloud API. Gateway Uniswap (explore.poolsForToken)
 * SERING melewatkan pool nyata di Robinhood Chain (mis. pool ETH/token ber-TVL
 * puluhan ribu $ tak muncul, dan TVL yang dilaporkan ngawur). Krystal punya daftar
 * lengkap + TVL benar. TAPI Krystal mengembalikan fee EFEKTIF (bukan fee poolKey)
 * dan tickSpacing 0 di list — dua-duanya tak bisa dipakai untuk mint v4. Karena itu
 * poolKey (currency0/1, fee, tickSpacing, hooks) diambil dari event Initialize
 * on-chain via Blockscout, lalu DIVERIFIKASI keccak-nya == poolId. Cocok → aman
 * di-mint; tak cocok → dibuang (jangan kirim tx ke poolKey tebakan).
 */

const CHAIN_ID: Record<string, number> = { robinhood: 4663 };
const API = 'https://cloud-api.krystal.app/v1';
// event Initialize(bytes32 id, address currency0, address currency1, uint24 fee,
//                  int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
const INIT_SIG = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

export const krystalConfigured = (cc: ChainCtx): boolean => !!config.krystal.apiKey && CHAIN_ID[cc.key] !== undefined;

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { 'KC-APIKey': config.krystal.apiKey, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`krystal HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * poolKey PASTI dari event Initialize (difilter poolId), diverifikasi keccak==poolId.
 * Blockscout REST getLogs menelan rentang blok penuh (RPC getLogs 0→latest ditolak).
 */
async function poolKeyFromInitialize(cc: ChainCtx, poolManager: string, poolId: string): Promise<PoolKeyV4 | null> {
  if (!cc.blockscout) return null;
  const base = cc.blockscout.replace('/api/v2', '/api');
  const url = `${base}?module=logs&action=getLogs&fromBlock=1&toBlock=latest&address=${poolManager}&topic0=${INIT_SIG}&topic1=${poolId}&topic0_1_opr=and`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  let j: any;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  const log = Array.isArray(j?.result) ? j.result[0] : null;
  if (!log?.data || !log?.topics) return null;
  try {
    const [fee, tickSpacing, hooks] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'],
      log.data,
    );
    const currency0 = ethers.getAddress('0x' + String(log.topics[2]).slice(26));
    const currency1 = ethers.getAddress('0x' + String(log.topics[3]).slice(26));
    const pk: PoolKeyV4 = { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
    // Jangan percaya event mentah: buktikan keccak(poolKey) == poolId sebelum dipakai mint.
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const recomputed = ethers.keccak256(
      coder.encode(['tuple(address,address,uint24,int24,address)'], [[currency0, currency1, pk.fee, pk.tickSpacing, hooks]]),
    );
    if (recomputed.toLowerCase() !== poolId.toLowerCase()) return null;
    return pk;
  } catch {
    return null;
  }
}

/** base bot dari sepasang currency v4 (ETH-native/WETH atau USDG). null = bukan pair yang didukung. */
function baseOfPair(cc: ChainCtx, c0: string, c1: string): { base: 'weth' | 'usdg'; baseIsCurrency0: boolean } | null {
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
  if (isEth(c0)) return { base: 'weth', baseIsCurrency0: true };
  if (isEth(c1)) return { base: 'weth', baseIsCurrency0: false };
  if (isUsdg(c0)) return { base: 'usdg', baseIsCurrency0: true };
  if (isUsdg(c1)) return { base: 'usdg', baseIsCurrency0: false };
  return null;
}

/**
 * Pool v4 untuk 1 token via Krystal (poolKey diverifikasi on-chain). Hanya pair
 * yang base-nya ETH/USDG (yang bisa dibuka bot). Diurut TVL turun. Gagal / tak
 * dikonfigurasi → []. Pemanggil tetap menjalankan filter kesehatan (activeLiq>0).
 */
export async function krystalV4Pools(cc: ChainCtx, token: string): Promise<TokenPool[]> {
  if (!krystalConfigured(cc)) return [];
  const cid = CHAIN_ID[cc.key];
  const list = await fetchJson(`${API}/pools?chainId=${cid}&token=${token}&sortBy=0&limit=50`).catch(() => null);
  if (!Array.isArray(list)) return [];
  const out = await Promise.all(
    list.map(async (p: any): Promise<TokenPool | null> => {
      if (p?.protocol?.key !== 'uniswapv4' || !p.poolAddress) return null;
      const c0 = p.token0?.token?.address as string;
      const c1 = p.token1?.token?.address as string;
      if (!c0 || !c1) return null;
      const pk = await poolKeyFromInitialize(cc, p.protocol.factoryAddress, p.poolAddress);
      if (!pk) return null; // poolKey tak bisa dibuktikan → jangan tawarkan
      const b = baseOfPair(cc, pk.currency0, pk.currency1);
      if (!b) return null; // bukan pair ETH/USDG → bot tak bisa buka
      const baseSym = b.base === 'usdg' ? 'USDG' : 'ETH';
      const otherSym =
        (b.baseIsCurrency0 ? p.token1?.token?.symbol : p.token0?.token?.symbol) ?? '?';
      return {
        protocol: 'v4',
        base: b.base,
        baseSymbol: baseSym,
        otherSymbol: otherSym,
        fee: pk.fee, // fee POOLKEY on-chain (bukan feeTier efektif Krystal)
        tvlUsd: Number(p.tvl) || 0,
        aprPct: p.stats24h?.apr != null ? Number(p.stats24h.apr) : null,
        poolKey: pk,
        baseIsCurrency0: b.baseIsCurrency0,
      };
    }),
  );
  return out.filter((p): p is TokenPool => p !== null).sort((a, b) => b.tvlUsd - a.tvlUsd);
}
