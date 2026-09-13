import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * v3 and v4, on every chain, must behave the same.
 *
 * The bot grew v4 support later, so every card and every button has two implementations
 * that drift apart one edit at a time. These asserts pin the places where they must not.
 */
const idx = readFileSync('src/index.ts', 'utf8');
const m = readFileSync('src/messages.ts', 'utf8');
const fees = readFileSync('src/commands/feesAndRemove.ts', 'utf8');

// --- both position cards use the same header, tree fields and footer shape ---
for (const [name, fn] of [
  ['v3', m.slice(m.indexOf('export function msgPositionCard'), m.indexOf('export function msgPositionDetail'))],
  ['v4', m.slice(m.indexOf('export function msgV4Position'), m.indexOf('export function msgV4Position') + 6000)],
] as Array<[string, string]>) {
  assert.ok(/posPair\(/.test(fn), `${name}: judul kartu harus memakai posPair`);
  for (const field of ['Fee:', 'TVL:', 'Fills:', 'Volume:', 'Liquidity:', 'Range:'])
    assert.ok(fn.includes(field), `${name}: baris "${field}" hilang dari kartu posisi`);
  assert.ok(/fields\.map\(\(f, i\) =>/.test(fn), `${name}: kartu harus dirender sbg blok pohon`);
}

// --- Add Liquidity reaches both, and the v4 lookup covers EVERY v4 chain ---
assert.equal((idx.match(/posadd:\$\{/g) ?? []).length, 2, 'tombol Add Liquidity harus ada di kartu v3 DAN v4');
// Bounded to the handler itself: the next bot.action after it is a different flow, and
// letting the slice run past it made this assert read that flow's code instead.
const posaddAt = idx.indexOf("bot.action(/^posadd:");
const posadd = idx.slice(posaddAt, idx.indexOf('bot.action(', posaddAt + 20));
assert.ok(/Object\.values\(CHAINS\)\.filter\(\(x\) => v4Supported\(x\)\)/.test(posadd),
  'pencarian posisi v4 harus melintasi semua chain, bukan chain aktif saja');
// Pool, side and range are all fixed by the position being added to, so the button asks
// only for the amount -- no rediscovery, no wizard.
assert.ok(!/continueAddlp/.test(posadd), 'Add Liquidity dari posisi tak boleh memindai pool ulang');
assert.ok(!/renderStrategyStep/.test(posadd), 'Add Liquidity tak boleh melewati langkah strategi lagi');
assert.equal((posadd.match(/renderTopUpAmount\(ctx, ctx\.from!\.id\)/g) ?? []).length, 2,
  'kedua protokol harus langsung menanyakan nominal');
// The deposit lands in the SAME position, which is what increaseLiquidity means.
assert.ok(/increaseLiquidityV4\(t\.id/.test(idx) && /increaseLiquidityV3\(t\.id/.test(idx),
  'kedua protokol harus menambah ke posisi yang sama, bukan membuka posisi baru');
// Single-sided only works outside the range; in range it must refuse, not revert on chain.
const v4src = readFileSync('src/uniswapV4.ts', 'utf8');
const v3src = readFileSync('src/uniswap.ts', 'utf8');
for (const [name, src] of [['v4', v4src], ['v3', v3src]] as Array<[string, string]>)
  assert.ok(/is in range, so adding needs BOTH tokens/.test(src), `${name}: posisi in-range harus ditolak dgn alasan`);

// --- unclaimed fees see both protocols, across every chain ---
assert.ok(/listPositionsV4/.test(fees) && /store\.active\(\)/.test(fees), '/claim_fees harus membaca v3 dan v4');
assert.ok(/Object\.values\(CHAINS\)/.test(fees), '/claim_fees v4 harus dipindai di semua chain');

// --- the positions list carries the chain of the position, not the active one ---
assert.ok(/chain: rcc\.label/.test(idx), 'baris v3 harus memakai chain posisinya sendiri');
assert.ok(/chain: pcc\.label/.test(idx), 'baris v4 harus memakai chain posisinya sendiri');

// --- the deposit flow is protocol-agnostic: one executor, both paths inside it ---
assert.equal((idx.match(/async function execAdd\(/g) ?? []).length, 1, 'execAdd harus tunggal');
const exec = idx.slice(idx.indexOf('async function execAdd('), idx.indexOf('async function execAdd(') + 4000);
assert.ok(/protocol === 'v4'/.test(exec), 'execAdd harus menangani v4');
assert.ok(/renderPlanStepV4/.test(idx), 'rencana v4 harus punya jalurnya sendiri');

// --- the top-up accepts BOTH a percentage tap and a typed amount ---
// It shipped with only the buttons wired, so typing a number did nothing at all while the
// card invited exactly that.
assert.ok(/bot\.action\(\/\^tup:/.test(idx), 'tombol persen top-up hilang');
assert.ok(/const t = topUps\.get\(ctx\.from\.id\);/.test(idx), 'ketikan nominal harus ditangani juga');
assert.ok(/return execTopUp\(ctx, ctx\.from\.id, wei\)/.test(idx), 'nominal yang diketik harus dieksekusi');
// Both paths must respect the gas reserve on a native base.
assert.equal((idx.match(/t\.base\.wrappable \? held - \(await gasBuffer\(cc\)\)|t\.base\.wrappable \? raw - \(await gasBuffer\(cc\)\)/g) ?? []).length, 2,
  'kedua jalur nominal harus menyisihkan cadangan gas');

// --- v4 increase must CLOSE each currency, not settle both ---
// Increasing an existing position also pays out its accrued fees, so one side ends up
// owed TO the wallet. SETTLE_PAIR demands a debt on both and reverted with
// DeltaNotNegative(0x3351b260) on the credited side; CLOSE_CURRENCY handles either sign.
const inc = v4src.slice(v4src.indexOf('export async function increaseLiquidityV4'), v4src.indexOf('export async function increaseLiquidityV4') + 3600);
assert.ok(/CLOSE_CURRENCY, CLOSE_CURRENCY/.test(inc), 'increase v4 harus menutup tiap currency satu per satu');
assert.ok(!/SETTLE_PAIR/.test(inc), 'increase v4 tak boleh memakai SETTLE_PAIR — sisi berpiutang akan revert');
assert.ok(/staticCall/.test(inc), 'increase v4 wajib disimulasikan sebelum dikirim');

console.log('ok: kartu, tombol, dan alur setara antara v3 & v4 di semua chain');
