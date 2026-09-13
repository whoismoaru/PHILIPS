import { ethers } from 'ethers';
import { config } from './config.js';

/**
 * The connection layer: provider, wallet and contracts.
 * The ABIs here are deliberately minimal -- only the functions actually called.
 */

export const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId);
// The wallet is no longer built here: walletStore is its source (see chains.ts).
// What is left in this module is the provider plus the ABI collection.

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

// ── Velodrome Slipstream (CL): a Uniswap v3 fork where `fee` becomes `tickSpacing` ──
// Pools are identified by tick spacing rather than a fee tier. The tick spacing is kept in
// the same `fee` slot (the parameter keeps that name on purpose), so the whole
// getPool/positions/mint pipeline passes through unchanged. The real differences: the type
// is int24, and mint carries a trailing `sqrtPriceX96`, set to 0 for an existing pool.
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

// No default-chain contract instances are built here, on purpose: every path is already
// chain-aware through chains.ts (cc.factory, cc.positionManager, cc.weth), and
// `new Contract('')` with an empty env used to blow up at import time.

/**
 * Approve EXACTLY what is being spent, never MaxUint256.
 *
 * An unlimited approval lets every router and position manager we have ever touched pull
 * the entire balance of that token, for good -- and if one of them is ever compromised,
 * what is lost is not just the transaction's amount. LI.FI already used the exact-amount
 * pattern here; this brings the rest in line.
 *
 * Some USDT-style tokens refuse to move a non-zero allowance straight to another non-zero
 * value, so any remaining allowance is zeroed first.
 *
 * @returns the approve transaction hashes actually sent (empty when the allowance sufficed).
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

/**
 * Headers for the explorer API (Blockscout).
 *
 * Without a User-Agent, Robinhood's Blockscout answers 403 -- bot protection, not a slow
 * indexer. For months that read as "the indexer is struggling" and made /positions warn
 * that its list might be incomplete. Proven on 29 Aug 2026: the same request, one header
 * added, 403 became 200.
 */
export const EXPLORER_HEADERS = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};
