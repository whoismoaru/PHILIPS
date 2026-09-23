/** Price impact and slippage stop here, on every chain. Gas has no cap: see feeOracle.ts. */
export const TRADE_LIMIT_PCT = 3;
/**
 * Price impact allowed when SELLING, on every chain. Looser than a buy on purpose: refusing
 * a thin token's exit at 3% can trap the position (24 Sep 2026: a 5.4% sell was refused).
 * The owner set 10%.
 */
export const SELL_IMPACT_PCT = 10;
