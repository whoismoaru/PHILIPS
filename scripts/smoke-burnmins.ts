/**
 * A withdrawal floor has to SURVIVE ordinary price movement while still REJECTING
 * a real shove. This exercises the maths directly — no RPC, no live position.
 *
 * What used to break: narrow ranges. Each side's amount moves much faster than
 * price, so the old per-side 0.5% floor turned a 0.2% move into
 * MinimumAmountInsufficient.
 */
import assert from 'node:assert/strict';
import { withdrawFloors, amountsForLiquidity, isqrt } from '../src/lpmath.js';
import { sqrtAtTick } from '../src/uniswapV4.js';

const Q96 = 1n << 96n;
/** sqrtPriceX96 at a given tick. */
const sqrtAt = (tick: number) => sqrtAtTick(tick);
/** Move price by `bps` (may be negative) and return the new sqrtPriceX96. */
const geser = (sqrtP: bigint, bps: number) => (sqrtP * isqrt((BigInt(10_000 + bps) * 10n ** 12n) / 10_000n)) / 10n ** 6n;

const L = 10n ** 18n;
let diuji = 0;

// Narrow ranges, the concentrated-LP norm, tested across many price positions:
// far below, right on the lower edge, mid-range, upper edge, far above.
for (const [lo, hi] of [[-60000, -30000], [-6000, -3000], [-600, 600], [0, 60], [3000, 9000]] as const) {
  const sqrtA = sqrtAt(lo);
  const sqrtB = sqrtAt(hi);
  for (const tick of [lo - 600, lo, lo + 1, Math.round((lo + hi) / 2), hi - 1, hi, hi + 600]) {
    const sqrtP = sqrtAt(tick);
    const { min0, min1 } = withdrawFloors(sqrtP, sqrtA, sqrtB, L);

    // 1) Ordinary movement (+/-0.4%, inside the band) must PASS. This is exactly
    //    what used to fail.
    for (const bps of [-40, -20, -5, 0, 5, 20, 40]) {
      const a = amountsForLiquidity(geser(sqrtP, bps), sqrtA, sqrtB, L);
      assert.ok(
        a.amount0 >= min0 && a.amount1 >= min1,
        `rentang [${lo},${hi}] tick ${tick}: gerak ${bps}bp DITOLAK (a0=${a.amount0} min0=${min0} · a1=${a.amount1} min1=${min1})`,
      );
      diuji++;
    }

    // 2) A big shove (+/-5%) must be REJECTED on the side it hurts. That is the
    //    protection. Only applies where that side actually has a floor (> 0). Right
    //    at a range edge the minor side is already zero, so nothing there can be
    //    stolen; a zero floor is not a leak, and demanding rejection would only be
    //    testing zero against zero.
    if (sqrtP > sqrtA && sqrtP < sqrtB) {
      const naik = amountsForLiquidity(geser(sqrtP, 500), sqrtA, sqrtB, L);
      const turun = amountsForLiquidity(geser(sqrtP, -500), sqrtA, sqrtB, L);
      if (min0 > 0n) {
        assert.ok(naik.amount0 < min0, `rentang [${lo},${hi}] tick ${tick}: dorongan +5% lolos (amount0 tak terjaga)`);
        diuji++;
      }
      if (min1 > 0n) {
        assert.ok(turun.amount1 < min1, `rentang [${lo},${hi}] tick ${tick}: dorongan -5% lolos (amount1 tak terjaga)`);
        diuji++;
      }
    }
  }
}

// A floor must never exceed the amount at the current price, or EVERY burn fails.
for (const tick of [-1200, 0, 1200]) {
  const sqrtP = sqrtAt(tick), sqrtA = sqrtAt(-1800), sqrtB = sqrtAt(1800);
  const now = amountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
  const f = withdrawFloors(sqrtP, sqrtA, sqrtB, L);
  assert.ok(f.min0 <= now.amount0 && f.min1 <= now.amount1, `lantai di atas jumlah saat ini (tick ${tick})`);
}

// Zero liquidity gives a zero floor, not a division by zero.
const nol = withdrawFloors(sqrtAt(0), sqrtAt(-600), sqrtAt(600), 0n);
assert.equal(nol.min0, 0n);
assert.equal(nol.min1, 0n);

// Both protocols MUST share one floor. If either drifts back to a per-side
// percentage, the old bug returns there with no test turning red.
const fs = await import('node:fs');
for (const [nama, berkas] of [
  ['v4 (burnMinsV4)', 'src/uniswapV4.ts'],
  ['v3 (withdrawMins)', 'src/uniswap.ts'],
] as const) {
  const src = fs.readFileSync(berkas, 'utf8');
  assert.match(src, /withdrawFloors\(/, `${nama} tak lagi memakai lantai pita bersama`);
  assert.ok(
    !/\(10000n - WITHDRAW_SLIPPAGE_BPS\)|\(10000n - BURN_SLIPPAGE_BPS\)/.test(src),
    `${nama} masih memakai potongan per sisi yang lama`,
  );
}

console.log(`ok — ${diuji} skenario: gerak ±0,4% lolos, dorongan ±5% ditolak; v3 & v4 pakai lantai yang sama`);
