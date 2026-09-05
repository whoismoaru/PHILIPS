/**
 * Lantai burn v4 harus SELAMAT dari gerak harga wajar, dan tetap MENOLAK dorongan
 * harga besar. Cek ini menguji matematikanya langsung — tanpa RPC, tanpa posisi.
 *
 * Kasus yang dulu gagal: posisi dekat TEPI rentang. Sisi minornya tinggal remah,
 * dan lantai per-sisi 0,5% membuat gerak 0,2% pun memicu MinimumAmountInsufficient.
 */
import assert from 'node:assert/strict';
import { burnFloors, amountsForLiquidity, sqrtAtTick } from '../src/uniswapV4.js';

const Q96 = 1n << 96n;
/** sqrtPriceX96 pada harga `p` (rasio token1/token0), lewat tick terdekat. */
const sqrtAt = (tick: number) => sqrtAtTick(tick);
/** Geser harga sebesar `bps` (bisa negatif) → sqrtPriceX96 baru. */
const isqrt = (n: bigint): bigint => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const geser = (sqrtP: bigint, bps: number) => (sqrtP * isqrt((BigInt(10_000 + bps) * 10n ** 12n) / 10_000n)) / 10n ** 6n;

const L = 10n ** 18n;
let diuji = 0;

// Rentang sempit (tipikal LP terkonsentrasi) diuji di banyak posisi harga: jauh di
// bawah, tepat di tepi bawah, tengah, tepi atas, jauh di atas.
for (const [lo, hi] of [[-60000, -30000], [-6000, -3000], [-600, 600], [0, 60], [3000, 9000]] as const) {
  const sqrtA = sqrtAt(lo);
  const sqrtB = sqrtAt(hi);
  for (const tick of [lo - 600, lo, lo + 1, Math.round((lo + hi) / 2), hi - 1, hi, hi + 600]) {
    const sqrtP = sqrtAt(tick);
    const { min0, min1 } = burnFloors(sqrtP, sqrtA, sqrtB, L);

    // 1) Gerak WAJAR (±0,4%, di dalam pita) harus LOLOS — inilah yang dulu gagal.
    for (const bps of [-40, -20, -5, 0, 5, 20, 40]) {
      const a = amountsForLiquidity(geser(sqrtP, bps), sqrtA, sqrtB, L);
      assert.ok(
        a.amount0 >= min0 && a.amount1 >= min1,
        `rentang [${lo},${hi}] tick ${tick}: gerak ${bps}bp DITOLAK (a0=${a.amount0} min0=${min0} · a1=${a.amount1} min1=${min1})`,
      );
      diuji++;
    }

    // 2) Dorongan BESAR (±5%) harus DITOLAK di sisi yang dirugikan — itu proteksinya.
    //    Hanya berlaku saat sisi itu MEMANG punya lantai (> 0). Persis di tepi rentang
    //    sisi minornya sudah nol — tak ada yang bisa dicuri di sana, jadi lantai nol
    //    bukan kebocoran, dan menuntut penolakan di situ hanya menguji nol lawan nol.
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

// Lantai tak boleh melebihi jumlah pada harga sekarang — kalau ya, SETIAP burn gagal.
for (const tick of [-1200, 0, 1200]) {
  const sqrtP = sqrtAt(tick), sqrtA = sqrtAt(-1800), sqrtB = sqrtAt(1800);
  const now = amountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
  const f = burnFloors(sqrtP, sqrtA, sqrtB, L);
  assert.ok(f.min0 <= now.amount0 && f.min1 <= now.amount1, `lantai di atas jumlah saat ini (tick ${tick})`);
}

// Likuiditas 0 → lantai 0, bukan pembagian nol.
const nol = burnFloors(sqrtAt(0), sqrtAt(-600), sqrtAt(600), 0n);
assert.equal(nol.min0, 0n);
assert.equal(nol.min1, 0n);

console.log(`ok — ${diuji} skenario: gerak ±0,4% lolos, dorongan ±5% ditolak`);
