/**
 * The LP bases in scope on Solana: SOL and USDC, and nothing else.
 *
 * Decimals belong to the ASSET, not to a global constant. That is the same rule the EVM
 * side learned expensively -- USDG on Robinhood has 6 decimals while USDT on BSC has 18,
 * and code that assumed one number was wrong on every other chain. Here SOL is 9 and USDC
 * is 6; neither is 18, and nothing on this side may fall back to 18.
 *
 * Both mints and both decimal counts were read off-chain rather than copied from memory:
 * getAccountInfo on each mint reports decimals 9 and 6 under the SPL Token program.
 */

export type SolBaseKind = 'sol' | 'usdc';

export type SolBase = {
  kind: SolBaseKind;
  mint: string;
  symbol: string;
  decimals: number;
  /** True for a dollar stablecoin, which prices at ~$1 and needs no conversion. */
  stable: boolean;
};

export const SOL: SolBase = {
  kind: 'sol',
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  decimals: 9,
  stable: false,
};

export const USDC: SolBase = {
  kind: 'usdc',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  decimals: 6,
  stable: true,
};

export const SOL_BASES: readonly SolBase[] = [SOL, USDC];

/** The base for a mint, or undefined when that asset is not one we pair against. */
export function baseOfMint(mint: string): SolBase | undefined {
  // Exact comparison: base58 is case-sensitive, so a fold here would silently match nothing.
  return SOL_BASES.find((b) => b.mint === mint);
}
