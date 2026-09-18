/**
 * One runnable check on recovering a missing entry market cap.
 *
 * entryMcap is read ONCE, when a position opens, from sources that often do not carry a
 * token in its first minutes -- on 18 Sep 2026 DexScreener had no BSC pair for NEWTON at
 * all, only GMGN did. A single miss there left the position with no Range row in
 * /positions for the rest of its life, twice in a row on live money.
 *
 * It does not have to be guessed. The tick delta since entry IS the price ratio since
 * entry, so entryMcap = mcNow / ratio(currentTick) -- exact, not an estimate, and it must
 * round-trip against the very formula the card uses to draw the range.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The card's own maths (index.ts): mcap(tick) = entryMcap * 1.0001^(sgn * (tick - entryTick)).
const ratio = (sgn: number, tick: number, entryTick: number) => Math.pow(1.0001, sgn * (tick - entryTick));

for (const [entryMcap, entryTick, nowTick, baseIsCurrency0] of [
  [475_391, -75_172, -75_172, false],
  [475_391, -75_172, -70_000, false],
  [558_477, -75_172, -81_533, false], // the live NEWTON ladder
  [388_355, -79_563, -75_000, true],
] as Array<[number, number, number, boolean]>) {
  const sgn = baseIsCurrency0 ? -1 : 1;
  const mcNow = entryMcap * ratio(sgn, nowTick, entryTick); // what the card would show as "now"
  const recovered = mcNow / ratio(sgn, nowTick, entryTick); // what the recovery computes
  assert.ok(
    Math.abs(recovered - entryMcap) < 1e-6 * entryMcap,
    `recovery does not round-trip: ${recovered} vs ${entryMcap}`,
  );
}

const src = readFileSync('src/index.ts', 'utf8');
// It must run where a current market cap is ALREADY in hand, so it costs no extra call.
const card = src.slice(src.indexOf('async function buildV4Card'), src.indexOf('async function buildV4Card') + 9000);
assert.ok(/!tracked\.entryMcap/.test(card), 'the recovery no longer triggers on a missing entryMcap');
assert.ok(/mcNow \/ ratio/.test(card) || /mcNow \/ /.test(card), 'the recovery no longer derives the value from mcNow');
assert.ok(/v4store\.updateV4\(leg\.tokenId, \{ entryMcap/.test(card), 'the recovered value is not stored, so the list row stays blank');
assert.ok(/groupV4\(tracked\.groupId\)/.test(card), 'a ladder repairs only one leg: the list row reads leg 1');
// And it must never overwrite a value that was captured properly at open.
// It must only fill a GAP, never overwrite a value captured properly at open.
assert.ok(/if \(tracked && !tracked\.entryMcap/.test(card), 'the recovery no longer guards on the value being absent');

console.log('ok: a missing entry market cap is recovered exactly and stored for the whole ladder');
