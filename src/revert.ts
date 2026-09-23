/**
 * Custom revert selectors, turned into something an owner can act on.
 *
 * ethers decodes a revert only when the error is in the ABI it was given. Permit2 and the
 * v4 periphery are not, so their reverts arrive as "unknown custom error" with the reason
 * sitting in hex that nobody reads -- and the hex is then truncated to fit the card.
 *
 * On 23 Sep 2026 every v4 add on Robinhood failed with
 * data="0xd81b2f2e00000000…6ab30c50". That is AllowanceExpired(1790118992): the Permit2
 * approval had run out at 06:16 WIB. The card said "unknown custom error" and the number
 * that explained everything was right there in the payload.
 *
 * Selectors are keccak of the signature, first four bytes. They are hardcoded rather than
 * computed at import so this module pulls in nothing.
 */

/** True when a revert is DETERMINISTIC: the same call will fail the same way every time. */
export type RevertInfo = { text: string; deterministic: boolean };

const SELECTORS: Record<string, (arg: bigint | null) => RevertInfo> = {
  // Permit2
  '0xd81b2f2e': (arg) => ({
    text: `Permit2 approval expired${arg === null ? '' : ` at ${new Date(Number(arg) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`}. It is renewed automatically on the next attempt.`,
    // Deterministic until the approval is renewed, which a retry of the SAME call does not do.
    deterministic: true,
  }),
  '0xf96fb071': () => ({ text: 'Permit2 allowance is too small for this amount.', deterministic: true }),
  // v4 periphery
  '0x5bf6f916': () => ({ text: 'The transaction deadline passed before it landed.', deterministic: false }),
  '0x8b063d73': () => ({ text: 'Price moved past the slippage limit before the transaction landed.', deterministic: false }),
};

/**
 * Read a revert payload out of an error message and explain it. Null when the payload is
 * absent or not one we know.
 */
export function explainRevert(message: string): RevertInfo | null {
  const m = /data="(0x[0-9a-fA-F]{8,})"/.exec(message);
  if (!m) return null;
  const data = m[1].toLowerCase();
  const fn = SELECTORS[data.slice(0, 10)];
  if (!fn) return null;
  // One uint argument, when there is one: enough for a deadline or an amount.
  const word = data.slice(10, 74);
  const arg = word.length === 64 ? BigInt(`0x${word}`) : null;
  return fn(arg);
}
