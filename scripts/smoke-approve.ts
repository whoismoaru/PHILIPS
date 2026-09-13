import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An unlimited approval is standing permission for a router or position manager to
 * drain the ENTIRE token balance. The one place MaxUint256 belongs is ERC20 to Permit2,
 * where Permit2 itself is the guard (its allowances expire) and this is the standard
 * pattern. Everything else goes through approveExact().
 */
const SRC = join(process.cwd(), 'src');
const ALLOWED = new Set(['uniswapV4.ts']); // ERC20 → Permit2

const offenders: string[] = [];
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
  if (ALLOWED.has(f)) continue;
  const src = readFileSync(join(SRC, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/\.approve\b/.test(line) && /MaxUint256|MAX_UINT256/.test(line)) offenders.push(`${f}:${i + 1}`);
  });
}
assert.deepEqual(offenders, [], `unlimited approvals remain in: ${offenders.join(', ')}`);

// And the helper is actually used on the swap and LP mint paths, not merely present.
for (const f of ['swapRoute.ts', 'relay.ts', 'uniswap.ts']) {
  assert.ok(
    readFileSync(join(SRC, f), 'utf8').includes('approveExact('),
    `${f} does not use approveExact, so this path went back to approving by hand`,
  );
}

console.log('ok: exact-amount approvals on every swap and LP mint path; MaxUint256 only for Permit2.');
