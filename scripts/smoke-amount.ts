import assert from 'node:assert/strict';
import { ethers } from 'ethers';

function parseAmt(raw: string, dec: number): bigint | null {
  const t = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  const wei = ethers.parseUnits(`${i}.${f.slice(0, dec) || '0'}`, dec);
  return wei > 0n ? wei : null;
}

assert.equal(parseAmt('0.05', 18), 50000000000000000n);
assert.equal(parseAmt('12,5', 6), 12500000n); 
assert.equal(parseAmt('0.1234567', 6), 123456n); 
assert.equal(parseAmt('100', 6), 100000000n);

for (const bad of ['1e-9', '0', '0.0', '-1', 'abc', '', '  ', '1.2.3', '0.0000001']) {
  assert.equal(parseAmt(bad, 6), null, `harus ditolak: ${JSON.stringify(bad)}`);
}
assert.equal(parseAmt('1e18', 18), null);

console.log('OK — parseAmt waras (potong desimal, tolak notasi ilmiah & nol)');
