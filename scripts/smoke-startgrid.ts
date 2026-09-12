import assert from 'node:assert/strict';

/**
 * The /start grid promises a working command behind every button. Two ways that breaks:
 * a button whose callback has no handler, and a money button that skips the wallet guard.
 */
const src = await import('node:fs').then((fs) => fs.readFileSync('src/index.ts', 'utf8'));
// The grid and its keyboard live in core.ts so both /start and the post-connect card
// can build them without importing index.ts back into a cycle.
const core = await import('node:fs').then((fs) => fs.readFileSync('src/core.ts', 'utf8'));

const grid = [...core.matchAll(/\['[^']*',\s*'(cmd:[a-z_]+|portfolio|positions|pnl|help|howto:add)'\]/g)].map((m) => m[1]);
assert.equal(grid.length, 13, `grid harus 13 tombol, terbaca ${grid.length}`);
// Add LP and Close LP are deliberately absent: opening starts from a pasted CA, and
// closing belongs to the position it closes, inside /positions.
assert.ok(!grid.includes('howto:add') && !grid.includes('cmd:stop'),
  'Add LP / Close LP tak boleh kembali ke grid — jalurnya sudah ada di tempat lain');

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

console.log('ok: 13 tombol /start punya handler, dan tombol uang dijaga sama seperti command-nya');

// --- the wallet a card shows must be the wallet the keyboard branches on ---
// These drifted apart once already: the card read the chain context (a VoidSigner
// frozen at 0x0 when the cache was built before the keystore loaded) while the
// keyboard read walletStore, so /start greeted a connected user as 0x0000…0000.
assert.ok(
  /walletShort: addr \? msg\.shortAddr\(addr\) : null/.test(core) && /const addr = walletStore\.address\(\)/.test(core),
  'kartu menu harus baca alamat dari walletStore, bukan dari konteks chain',
);
const chainsSrc = await import('node:fs').then((fs) => fs.readFileSync('src/chains.ts', 'utf8'));
assert.ok(
  /ctxCache && walletStore\.isConnected\(\)[\s\S]{0,300}ctxCache = null/.test(chainsSrc),
  'cache chain harus dibangun ulang bila dompet muncul setelah cache jadi',
);
console.log('ok: alamat di kartu & tombol berasal dari satu sumber, cache chain sembuh sendiri');

// --- /start with no wallet must ARM the connect flow, not just print its card ---
// Printing msgConnectPrompt() directly leaves awaitingSecret empty, so the key the user
// then pastes is read as an ordinary message and ignored.
assert.ok(
  /if \(!walletStore\.isConnected\(\)\) return cmdConnect\(ctx\);/.test(src),
  '/start tanpa dompet harus memanggil cmdConnect, bukan mencetak kartunya sendiri',
);
const wsrc = await import('node:fs').then((fs) => fs.readFileSync('src/commands/wallet.ts', 'utf8'));
assert.ok(/export function cmdConnect[\s\S]{0,400}awaitingSecret\.add/.test(wsrc),
  'cmdConnect harus memasang awaitingSecret sebelum meminta kunci');
console.log('ok: /start tanpa dompet benar-benar menunggu kunci yang ditempel');

// --- a fresh connect must land on the same card a returning user sees ---
// It used to end on a three-button stub, so the command grid was reachable only by
// typing /start again right after connecting.
const w2 = await import('node:fs').then((fs) => fs.readFileSync('src/commands/wallet.ts', 'utf8'));
assert.ok(/msgConnected\(addr\)[\s\S]{0,400}startCard\(\)[\s\S]{0,80}startKeyboard\(\)/.test(w2),
  'setelah connect sukses harus menyusul kartu WELCOME beserta grid-nya');
const msrc = await import('node:fs').then((fs) => fs.readFileSync('src/messages.ts', 'utf8'));
assert.ok(/msgConnected\(_addr: string\): string \{[\s\S]{0,600}return `[^`]*Wallet Successfully Connected!/.test(msrc),
  'kartu sukses connect harus satu baris saja');
console.log('ok: connect sukses → satu baris konfirmasi, lalu WELCOME + grid');

// --- every route to "the menu" must render the same card ---
// Back to Menu used to open the old /help card while /start showed the WELCOME grid,
// so the bot had two different things called the menu.
assert.ok(/export function startCard\(/.test(core), 'kartu menu harus hidup di satu fungsi (core.startCard)');
for (const [file, body] of [['index.ts', src], ['wallet.ts', w2]] as Array<[string, string]>) {
  assert.ok(!/msgStarted\(\{/.test(body), `${file} masih menyusun kartu menu sendiri, bukan lewat startCard()`);
}
const backBody = src.slice(src.indexOf("bot.action('positions_back'"), src.indexOf("bot.action('positions_back'") + 400);
assert.ok(backBody.includes('startCard()') && backBody.includes('startKeyboard()'),
  'tombol Back to Menu harus mendarat di kartu WELCOME beserta grid-nya');
console.log('ok: /start, connect sukses, dan Back to Menu mendarat di kartu yang sama');
