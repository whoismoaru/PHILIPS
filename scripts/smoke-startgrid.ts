import assert from 'node:assert/strict';

/**
 * The /start grid promises a working command behind every button. Two ways that breaks:
 * a button whose callback has no handler, and a money button that skips the wallet guard.
 */
const src = await import('node:fs').then((fs) => fs.readFileSync('src/index.ts', 'utf8'));

const grid = [...src.matchAll(/\['[^']*',\s*'(cmd:[a-z_]+|portfolio|positions|pnl|help|howto:add)'\]/g)].map((m) => m[1]);
assert.equal(grid.length, 15, `grid harus 15 tombol, terbaca ${grid.length}`);

// Every cmd:* button must appear as a key in GRID_ACTIONS.
const actions = new Set([...src.matchAll(/^\s{2}([a-z_]+): (?:cmd[A-Za-z]+|async)/gm)].map((m) => m[1]));
for (const b of grid.filter((g) => g.startsWith('cmd:'))) {
  assert.ok(actions.has(b.slice(4)), `tombol ${b} tak punya handler di GRID_ACTIONS`);
}

// Money buttons must sit behind the same guard that protects the typed command.
const guard = src.match(/const NEEDS_WALLET_CB =\s*([\s\S]*?);/)![1];
for (const m of ['stop', 'claim_fees', 'buy', 'sell', 'unwrap', 'bridge', 'send']) {
  assert.ok(guard.includes(m), `cmd:${m} memindahkan uang tapi tak dijaga NEEDS_WALLET_CB`);
}

console.log('ok: 15 tombol /start punya handler, dan tombol uang dijaga sama seperti command-nya');

// --- the wallet a card shows must be the wallet the keyboard branches on ---
// These drifted apart once already: the card read the chain context (a VoidSigner
// frozen at 0x0 when the cache was built before the keystore loaded) while the
// keyboard read walletStore, so /start greeted a connected user as 0x0000…0000.
assert.ok(
  /walletShort: walletStore\.address\(\)/.test(src),
  'kartu /start harus baca alamat dari walletStore, bukan dari konteks chain',
);
const chainsSrc = await import('node:fs').then((fs) => fs.readFileSync('src/chains.ts', 'utf8'));
assert.ok(
  /ctxCache && walletStore\.isConnected\(\)[\s\S]{0,300}ctxCache = null/.test(chainsSrc),
  'cache chain harus dibangun ulang bila dompet muncul setelah cache jadi',
);
console.log('ok: alamat di kartu & tombol berasal dari satu sumber, cache chain sembuh sendiri');
