import assert from 'node:assert/strict';
import { goplusInfo } from '../src/goplus.js';

/**
 * GoPlus sends every field as a string and OMITS the ones it cannot determine.
 * Reading a missing field as 0 is how the card ends up printing '✅ No' with no
 * evidence behind it. So: absent must become null ('?'), '0' must become false.
 */
const asli = globalThis.fetch;
const jawab = (r: unknown) =>
  ((async () => new Response(JSON.stringify({ code: 1, result: r }), { status: 200 })) as typeof fetch);
const CA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

try {
  // Full payload -> parsed, tax scaled by 100, owner 0x0 means renounced.
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
  assert.equal(v.buyTaxPct, 2, 'a 0.02 tax reads as 2%');
  assert.equal(v.renounced, true);

  // MISSING field -> null, not false. This is the whole point of the test.
  globalThis.fetch = jawab({ [CA.replace('a', 'b')]: { is_open_source: '1', holder_count: '10', token_name: 'x' } });
  const w = await goplusInfo(CA.replace('a', 'b'), 'bsc');
  assert.ok(w);
  assert.equal(w.isProxy, null, 'a missing is_proxy reads "?", never "no"');
  assert.equal(w.honeypot, null, 'a missing is_honeypot reads "?"');
  assert.equal(w.renounced, null, 'a missing owner_address reads "?"');

  // Robinhood is unmapped -> no call goes out at all.
  globalThis.fetch = (() => assert.fail('robinhood must never call GoPlus')) as unknown as typeof fetch;
  assert.equal(await goplusInfo(CA, 'robinhood'), null);
} finally {
  globalThis.fetch = asli;
}
console.log('smoke-goplus: OK');
