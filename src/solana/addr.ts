/**
 * Solana address handling, and the one rule that governs it: NEVER normalise.
 *
 * An EVM address is hex, so case carries no meaning and the codebase lowercases addresses
 * freely -- 136 times across src/, six of them in gmgn.ts alone. A Solana address is
 * base58, where case IS the value: lowercasing "91ryaCo5..." yields a different key, or
 * no valid key at all. The corruption is silent. The call still goes out, the API answers
 * "not found", and the card reports a healthy token as missing.
 *
 * So this module exposes a test and nothing else. There is deliberately no normalise(),
 * no toChecksum(), no lowercase helper: a Solana address is passed through exactly as the
 * user typed it, or it is rejected.
 *
 * Validation is a full base58 decode to 32 bytes rather than a character-class regex.
 * Solana base58 carries no checksum, unlike Bitcoin's, so the byte length is the only real
 * check available -- and a regex alone accepts 44-character strings that decode to 33
 * bytes and are not addresses at all.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i] as const));

/** Decoded bytes, or null when the string is not base58 at all. */
function decodeBase58(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const v = INDEX.get(ch);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  // A leading '1' is a leading zero byte, and carries no value: the System Program is
  // thirty-two of them. Counting them back is what keeps such an address 32 bytes long.
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const tail: number[] = [];
  while (n > 0n) {
    tail.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...Array<number>(zeros).fill(0), ...tail]);
}

/**
 * True when this is a Solana address: base58 decoding to exactly 32 bytes.
 *
 * Also the chain detector at the paste site. An EVM address starts '0x', and neither '0'
 * nor 'x' after it survives the base58 alphabet, so the two forms can never be confused
 * and no network call is needed to tell them apart.
 *
 * Returns a plain boolean, NOT an `s is string` predicate. A predicate narrows the caller's
 * already-string variable to `never` on the false branch, which is the same trap the
 * ethers.isAddress call site carries a comment about.
 */
export function isSolAddress(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 32 || t.length > 44) return false;
  const b = decodeBase58(t);
  return b !== null && b.length === 32;
}
