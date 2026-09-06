/**
 * One runnable check for the Serialized audit layer.
 *
 * Guards the two things that actually break: the parse (a shape change upstream
 * silently empties the section) and the BLOCKING verdict (an unsafe token must
 * reach `flags`, not just the card). Runs offline — the HTTP call is stubbed —
 * so it never spends credits.
 */
import assert from 'node:assert';

const PAYLOAD = {
  audit: {
    description: 'Token launched on PONS_V2.',
    vulnerabilities: [],
    isProxy: null,
    isSafe: false,
    isTokenSafe: true,
    isHookSafe: false,
    symbol: 'SHROOM',
    chain: 'ROBINHOOD',
    sourceType: 'none',
    hookAddress: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    hookAudit: {
      isSafe: false,
      description: 'Graduated meme hook.',
      vulnerabilities: [
        { type: 'HiddenFees', impact: 'warning', description: 'Hook skims up to 20%.' },
        { type: 'LiquidityDrain', impact: 'critical', description: 'Owner can rug.', mitigated: true, gateReason: 'Owner renounced' },
        { type: 'Other', impact: 'info', description: 'Cosmetic.' },
      ],
    },
  },
  billing: { type: 'fresh_no_decompile', credits: 4 },
};

process.env.SERIALIZED_API_KEY = 'sk_live_test';
globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => PAYLOAD })) as any;

const { serializedInfo, activeRisks } = await import('../src/serialized.js');

const info = await serializedInfo('0xab093dEF657F15dF31b33922A95e047aDd645B29', 'robinhood');
assert(info, 'audit terurai');
assert.equal(info.tokenSafe, true);
assert.equal(info.hookSafe, false, 'hook UNSAFE harus terbaca terpisah dari token');
assert.equal(info.hookRisks.length, 3, 'semua temuan tetap terurai');
// A renounced-owner rug and an info-level note must NOT reach the card: warning
// about code that cannot fire is how a card teaches its reader to ignore it.
const aktif = activeRisks(info.hookRisks);
assert.equal(aktif.length, 1);
assert.equal(aktif[0].type, 'HiddenFees');
assert.equal(info.hookRisks[1].gateReason, 'Owner renounced');
assert.equal(info.verified, false, "sourceType 'none' = tak terverifikasi");

// An unmapped chain must not call out at all — a wrong chain symbol is a billed 400.
assert.equal(await serializedInfo('0x0000000000000000000000000000000000000001', 'solana'), null);

// The card must carry the hook verdict, and the guard must see it as BLOCKING.
const src = await import('node:fs/promises').then((f) => f.readFile('src/screening.ts', 'utf8'));
assert(/V4 hook is UNSAFE/.test(src), 'hook tak aman wajib jadi flag BAHAYA, bukan sekadar baris kartu');
assert(/hookSafe === false/.test(src));

console.log('smoke-serialized OK');
