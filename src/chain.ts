import { ethers } from 'ethers';
import { config } from './config.js';

/**
 * Lapisan koneksi ke Robinhood Chain: provider, dompet, dan kontrak.
 * ABI di sini sengaja minimal — hanya fungsi yang benar-benar kita pakai.
 */

export const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId);
export const wallet = new ethers.Wallet(config.wallet.privateKey, provider);

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

export const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
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

export const factory = new ethers.Contract(config.uniswap.factory, FACTORY_ABI, wallet);
export const positionManager = new ethers.Contract(
  config.uniswap.positionManager,
  POSITION_MANAGER_ABI,
  wallet,
);
export const weth = new ethers.Contract(config.uniswap.weth, WETH_ABI, wallet);

/** Cache metadata token (symbol & decimals) supaya tidak query berulang. */
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

export async function getTokenMeta(address: string): Promise<{ symbol: string; decimals: number }> {
  const key = address.toLowerCase();
  const cached = tokenMetaCache.get(key);
  if (cached) return cached;
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  const meta = { symbol: symbol as string, decimals: Number(decimals) };
  tokenMetaCache.set(key, meta);
  return meta;
}
