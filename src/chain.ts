import { ethers } from 'ethers';
import { config } from './config.js';

/**
 * Lapisan koneksi ke Robinhood Chain: provider, dompet, dan kontrak.
 * ABI di sini sengaja minimal — hanya fungsi yang benar-benar kita pakai.
 */

export const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId);
// Dompet TIDAK lagi dibuat di sini: sumbernya walletStore (lihat chains.ts).
// Modul ini tinggal provider + kumpulan ABI.

export const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export const WETH_ABI = [
  ...ERC20_ABI,
  'function deposit() payable',
  'function withdraw(uint256 wad)',
];

export const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

// ── Velodrome Slipstream (CL) — fork Uniswap v3 dgn `fee`→`tickSpacing` (int24) ──
// Pool diidentifikasi tickSpacing, bukan fee-tier. Kita simpan tickSpacing di
// slot `fee` yang sama (nama param sengaja tetap `fee`), jadi seluruh pipeline
// getPool/positions/mint pass-through tanpa ubah. Beda nyata: tipe int24 & mint
// punya trailing `sqrtPriceX96` (diisi 0 untuk pool yang sudah ada).
export const FACTORY_ABI_SLIP = [
  'function getPool(address tokenA, address tokenB, int24 fee) view returns (address)',
];

export const POSITION_MANAGER_ABI_SLIP = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, int24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
];

export const POSITION_MANAGER_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
];

// Instance kontrak default-chain sengaja TIDAK dibuat di sini: semua jalur sudah
// chain-aware lewat chains.ts (cc.factory/cc.positionManager/cc.weth), dan
// `new Contract('')` saat env kosong dulu meledak di import-time.

/**
 * Approve SEBESAR YANG DIPAKAI, bukan MaxUint256.
 *
 * Approve tak terbatas berarti tiap router/PM yang pernah kita sentuh boleh
 * menarik SELURUH saldo token itu selamanya — kalau salah satunya kompromis,
 * yang hilang bukan cuma nominal transaksinya. LI.FI di repo ini sudah memakai
 * pola exact-amount; ini menyamakan sisanya.
 *
 * Sebagian token gaya USDT menolak mengubah allowance bukan-nol ke bukan-nol
 * lain, jadi sisa allowance dinolkan dulu sebelum diisi ulang.
 *
 * @returns hash tx approve yang benar-benar dikirim (kosong bila allowance cukup).
 */
export async function approveExact(
  token: string,
  spender: string,
  amountWei: bigint,
  wallet: ethers.Signer,
): Promise<string[]> {
  const c = new ethers.Contract(token, ERC20_ABI, wallet);
  const owner = await wallet.getAddress();
  const current: bigint = await c.allowance(owner, spender);
  if (current >= amountWei) return [];
  const hashes: string[] = [];
  if (current > 0n) {
    const zero = await c.approve(spender, 0n);
    await zero.wait();
    hashes.push(zero.hash);
  }
  const tx = await c.approve(spender, amountWei);
  await tx.wait();
  hashes.push(tx.hash);
  return hashes;
}
