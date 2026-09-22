/**
 * Decoding a Meteora DLMM pool account (LbPair), for the two numbers that decide whether a
 * pool is worth entering: bin step and base fee.
 *
 * Meteora's public API is gone -- dlmm-api.meteora.ag answers 404 for /pair/<address> as of
 * 20 Sep 2026 -- so these come off the chain or not at all. DexScreener carries TVL and
 * volume but neither bin step nor fee.
 *
 * The offsets are fixed, not guessed. LbPair is declared `repr(C)` with explicit padding
 * fields in the program IDL, so the layout is a plain cumulative sum:
 *
 *   8   discriminator
 *   8   parameters        StaticParameters, 32 bytes
 *   40  v_parameters      VariableParameters, 32 bytes
 *   72  bump_seed         [u8; 1]
 *   73  bin_step_seed     [u8; 2]
 *   75  pair_type         u8
 *   76  active_id         i32
 *   80  bin_step          u16
 *
 * and inside StaticParameters: base_factor at +0 (u16), base_fee_power_factor at +26 (u8).
 *
 * Verified against a live pool rather than trusted: 5TTHzu39... decoded to bin step 125 and
 * a 1.00% base fee, and the price implied by its active_id landed 1.18% under the price
 * DexScreener reported for the same pool. One bin is 1.25% wide at that bin step, so the
 * traded price sitting just inside the active bin is exactly the expected relationship.
 * A wrong offset could not produce that agreement.
 */
import { encodeBase58 } from './addr.js';
import { accountData } from './rpc.js';

const OFF_BASE_FACTOR = 8; // StaticParameters.base_factor, u16
const OFF_BASE_FEE_POWER = 8 + 26; // StaticParameters.base_fee_power_factor, u8
const OFF_ACTIVE_ID = 76; // i32
const OFF_BIN_STEP = 80; // u16
// ...then status(1) require_base_factor_seed(1) base_factor_seed(2) activation_type(1)
// creator_pool_on_off_control(1) lands the mints at 88 and 120. Verified against pool
// 5TTHzu39...: token_x decodes to the 91ryaCo5...pump mint and token_y to WSOL, which is
// exactly the pair DexScreener reports for it.
const OFF_TOKEN_X = 88; // pubkey
const OFF_TOKEN_Y = 120; // pubkey
const MIN_LEN = OFF_TOKEN_Y + 32;

/** Meteora prices in fee PRECISION of 1e9; see getBaseFee in @meteora-ag/dlmm. */
const FEE_PRECISION = 1e9;

export type LbPairInfo = {
  binStep: number;
  activeId: number;
  /** Mint of token X, the bin ladder's numerator side. */
  tokenX: string;
  tokenY: string;
  /** Base fee as a PERCENT (1 means 1%), before any dynamic/volatility component. */
  baseFeePct: number;
  /** Width of one bin as a percent, which is also the price resolution of the pool. */
  binWidthPct: number;
};

/**
 * Decode an LbPair account. Returns null when the account is absent or too short to be one,
 * which is the honest answer for an address that is not a DLMM pool at all.
 */
export function decodeLbPair(data: Uint8Array): LbPairInfo | null {
  if (data.length < MIN_LEN) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const binStep = v.getUint16(OFF_BIN_STEP, true);
  // A bin step of zero would make every price identical and divide the ladder by nothing.
  // It also means the decode landed on the wrong account.
  if (binStep === 0) return null;
  const baseFactor = v.getUint16(OFF_BASE_FACTOR, true);
  const powerFactor = v.getUint8(OFF_BASE_FEE_POWER);
  const activeId = v.getInt32(OFF_ACTIVE_ID, true);
  const b58 = (off: number) => encodeBase58(data.subarray(off, off + 32));
  // base_fee_rate = base_factor * bin_step * 10 * 10^base_fee_power_factor, over 1e9.
  const feeFraction = (baseFactor * binStep * 10 * Math.pow(10, powerFactor)) / FEE_PRECISION;
  return {
    binStep,
    activeId,
    tokenX: b58(OFF_TOKEN_X),
    tokenY: b58(OFF_TOKEN_Y),
    baseFeePct: feeFraction * 100,
    binWidthPct: binStep / 100,
  };
}

/** Fetch and decode one pool. null when the RPC has no such account. */
export async function lbPair(pool: string): Promise<LbPairInfo | null> {
  const data = await accountData(pool);
  return data ? decodeLbPair(data) : null;
}

/**
 * The price at a bin's lower edge: (1 + binStep/10000)^binId, in token Y per token X
 * BEFORE decimals are applied. The caller adjusts by 10^(decX - decY).
 */
export function binPrice(binStep: number, binId: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}
