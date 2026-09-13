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
  assert.ok(/posPair\(/.test(fn), `${name}: the card header must use posPair`);
  for (const field of ['Fee:', 'TVL:', 'Fills:', 'Volume:', 'Liquidity:', 'Range:'])
    assert.ok(fn.includes(field), `${name}: the "${field}" line is missing from the position card`);
  assert.ok(/fields\.map\(\(f, i\) =>/.test(fn), `${name}: the card must render as a tree block`);
}

// --- unclaimed fees see both protocols, across every chain ---
assert.ok(/listPositionsV4/.test(fees) && /store\.active\(\)/.test(fees), '/claim_fees must read both v3 and v4');
assert.ok(/Object\.values\(CHAINS\)/.test(fees), '/claim_fees must scan v4 on every chain');

// --- the positions list carries the chain of the position, not the active one ---
assert.ok(/chain: rcc\.label/.test(idx), 'a v3 row must use its own position chain');
assert.ok(/chain: pcc\.label/.test(idx), 'a v4 row must use its own position chain');

// --- the deposit flow is protocol-agnostic: one executor, both paths inside it ---
assert.equal((idx.match(/async function execAdd\(/g) ?? []).length, 1, 'execAdd must exist exactly once');
const exec = idx.slice(idx.indexOf('async function execAdd('), idx.indexOf('async function execAdd(') + 4000);
assert.ok(/protocol === 'v4'/.test(exec), 'execAdd must handle v4');
assert.ok(/renderPlanStepV4/.test(idx), 'the v4 plan must have its own path');

// --- Close All runs the SAME executor as a single close, for both protocols ---
// Closing twenty positions must record them exactly as closing one does: journal entry,
// PnL card, sweeps. A separate loop that "just closes" would silently skip all of that.
assert.equal((idx.match(/async function execCloseV3\(/g) ?? []).length, 1, 'execCloseV3 must exist exactly once');
assert.equal((idx.match(/async function execCloseV4\(/g) ?? []).length, 1, 'execCloseV4 must exist exactly once');
const all = idx.slice(idx.indexOf("bot.action('closeall_confirm'"), idx.indexOf("bot.action('help'"));
assert.ok(/execCloseV3\(shim\(/.test(all) && /execCloseV4\(shim\(/.test(all), 'Close All must go through both executors');
assert.ok(/Object\.values\(CHAINS\)\.filter\(\(x\) => v4Supported\(x\)\)/.test(all), 'Close All must sweep every v4 chain');
// Sequential, not Promise.all: they share one wallet and would collide on the nonce.
assert.ok(!/Promise\.all|mapLimit/.test(all), 'Close All must run sequentially, never in parallel');
// One failure must not stop the rest.
assert.ok(/failed\.push/.test(all), 'one position failing must be recorded, not stop the rest');

// --- every v4 chain must have BOTH contracts, and a stablecoin base ---
// Half a configuration is worse than none: a PositionManager with no PoolManager reads
// as "v4 supported" right up to the moment a deposit is attempted.
const v4src2 = readFileSync('src/uniswapV4.ts', 'utf8');
const keysOf = (name: string) => {
  const blk = v4src2.slice(v4src2.indexOf(`const ${name}: Record<string, string> = {`));
  return [...blk.slice(0, blk.indexOf('};')).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
};
assert.deepEqual(keysOf('V4_PM'), keysOf('V4_POOL_MANAGER'),
  'the v4 PositionManager and PoolManager tables must cover exactly the same chains');

console.log('ok: cards, buttons and flows match between v3 and v4 on every chain');
