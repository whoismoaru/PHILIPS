import assert from 'node:assert/strict';
import { goplusInfo } from '../src/goplus.js';

/**
 * GoPlus mengirim semua field sebagai string dan MENGHILANGKAN yang tak bisa ia
 * tentukan. Membaca field yang hilang sebagai 0 = kartu menulis '✅ No' tanpa
 * bukti. Tesnya: absen harus jadi null ('?'), '0' harus jadi false.
 */
const asli = globalThis.fetch;
const jawab = (r: unknown) =>
  ((async () => new Response(JSON.stringify({ code: 1, result: r }), { status: 200 })) as typeof fetch);
const CA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

try {
  // Payload penuh -> terbaca, tax dikali 100, owner 0x0 = renounced.
  globalThis.fetch = jawab({
    [CA]: {
      is_open_source: '1', is_proxy: '0', holder_count: '828', is_honeypot: '0',
      buy_tax: '0.02', sell_tax: '0.02', owner_address: '0x0000000000000000000000000000000000000000',
      is_mintable: '0', transfer_pausable: '0', creator_percent: '0.020905',
    },
  });
  const v = await goplusInfo(CA, 'bsc');
  assert.ok(v);
  assert.equal(v.verified, true);
  assert.equal(v.isProxy, false);
  assert.equal(v.holderCount, 828);
  assert.equal(v.buyTaxPct, 2, 'tax 0.02 harus jadi 2%');
  assert.equal(v.renounced, true);

  // Field HILANG -> null, bukan false. Ini inti tesnya.
  globalThis.fetch = jawab({ [CA.replace('a', 'b')]: { is_open_source: '1', holder_count: '10', token_name: 'x' } });
  const w = await goplusInfo(CA.replace('a', 'b'), 'bsc');
  assert.ok(w);
  assert.equal(w.isProxy, null, 'is_proxy absen harus "?" bukan "tidak"');
  assert.equal(w.honeypot, null, 'is_honeypot absen harus "?"');
  assert.equal(w.renounced, null, 'owner_address absen harus "?"');

  // Robinhood tak dipetakan -> tak memanggil apa pun.
  globalThis.fetch = (() => assert.fail('robinhood tak boleh memanggil GoPlus')) as unknown as typeof fetch;
  assert.equal(await goplusInfo(CA, 'robinhood'), null);
} finally {
  globalThis.fetch = asli;
}
console.log('smoke-goplus: OK');
