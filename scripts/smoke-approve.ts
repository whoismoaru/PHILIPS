import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Approve tak terbatas adalah izin permanen bagi router/PM untuk menguras SELURUH
 * saldo token. Satu-satunya yang boleh MaxUint256 adalah ERC20 → Permit2: di sana
 * Permit2 sendiri yang jadi penjaga (allowance-nya ber-kedaluwarsa), dan itu memang
 * pola bakunya. Sisanya harus lewat approveExact().
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
assert.deepEqual(offenders, [], `approve tak terbatas tersisa di: ${offenders.join(', ')}`);

// Dan helper-nya memang dipakai di jalur swap & mint LP, bukan cuma ada.
for (const f of ['swapRoute.ts', 'relay.ts', 'uniswap.ts']) {
  assert.ok(
    readFileSync(join(SRC, f), 'utf8').includes('approveExact('),
    `${f} tak memakai approveExact — jalur ini kembali approve manual`,
  );
}

console.log('OK — approve: exact-amount di semua jalur swap & mint LP; MaxUint256 hanya utk Permit2.');
