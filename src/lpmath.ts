/**
 * Matematika likuiditas terkonsentrasi yang dipakai BERSAMA oleh v3 dan v4.
 *
 * Berdiri sendiri (tanpa RPC, tanpa ChainCtx) karena dua alasan: bisa diuji
 * langsung, dan supaya uniswap.ts tak perlu mengimpor uniswapV4.ts hanya untuk
 * rumus yang sebenarnya milik keduanya.
 */

const Q96 = 1n << 96n;

function amount0Delta(a: bigint, b: bigint, L: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  if (a === 0n) return 0n;
  return (((L << 96n) * (b - a)) / b) / a;
}

function amount1Delta(a: bigint, b: bigint, L: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (L * (b - a)) / Q96;
}

/** Jumlah token0/token1 sebuah posisi pada harga `sqrtP`. */
export function amountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  L: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return { amount0: amount0Delta(sqrtA, sqrtB, L), amount1: 0n };
  if (sqrtP < sqrtB) return { amount0: amount0Delta(sqrtP, sqrtB, L), amount1: amount1Delta(sqrtA, sqrtP, L) };
  return { amount0: 0n, amount1: amount1Delta(sqrtA, sqrtB, L) };
}

/** Lebar PITA HARGA yang ditoleransi saat menarik likuiditas (0,5%). */
export const WITHDRAW_BAND_BPS = 50n;

/** Bantalan pembulatan bilangan bulat — tanpa ini lantai bisa meleset 1 wei ke atas. */
const ROUNDING_BPS = 1n;

/** Akar kuadrat bilangan bulat (Newton). */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrtPriceX96 pada harga × (bps/10000). Harga bergerak → akarnya bergerak seakar. */
const SQRT_SCALE = 1_000_000n;
export const shiftSqrt = (sqrtP: bigint, bps: bigint): bigint =>
  (sqrtP * isqrt((bps * SQRT_SCALE * SQRT_SCALE) / 10_000n)) / SQRT_SCALE;

/**
 * amount0Min/amount1Min untuk penarikan likuiditas — v3 maupun v4.
 *
 * Cara LAMA (dan kenapa ia gagal): `min = jumlah_sekarang × 99,5%` diterapkan pada
 * KEDUA sisi sekaligus. Untuk likuiditas terkonsentrasi itu salah sasaran. Jumlah
 * tiap sisi berubah jauh lebih cepat daripada harga, jadi pada rentang sempit gerak
 * harga 0,2% yang sepenuhnya wajar sudah memangkas satu sisi lebih dari 0,5% —
 * `MinimumAmountInsufficient` terpicu tanpa ada serangan apa pun. Lebih buruk lagi,
 * lantai per-sisi menjaga KOMPOSISI, hal yang memang bergerak sendiri, bukan NILAI.
 *
 * Cara SEKARANG: jumlah token adalah fungsi deterministik dari harga selama
 * likuiditas tetap. Jadi lantainya diambil dari PITA HARGA ±0,5% — hitung jumlah di
 * kedua tepi pita, ambil yang terkecil per sisi. Karena amount0 turun saat harga
 * naik dan amount1 naik saat harga naik, hasilnya = amount0 di tepi atas dan
 * amount1 di tepi bawah. Gerak wajar di dalam pita lolos; dorongan harga di luar
 * pita — alat yang justru dipakai penyerang — tetap ditolak.
 */
export function withdrawFloors(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { min0: bigint; min1: bigint } {
  // Amounts monoton terhadap harga, jadi minimum tiap sisi pasti ada di salah satu
  // tepi pita — cukup hitung dua titik, tak perlu menyapu.
  const bawah = amountsForLiquidity(shiftSqrt(sqrtP, 10_000n - WITHDRAW_BAND_BPS), sqrtA, sqrtB, liquidity);
  const atas = amountsForLiquidity(shiftSqrt(sqrtP, 10_000n + WITHDRAW_BAND_BPS), sqrtA, sqrtB, liquidity);
  const kecil = (a: bigint, b: bigint) => (a < b ? a : b);
  const floor = (v: bigint) => (v * (10_000n - ROUNDING_BPS)) / 10_000n;
  return {
    min0: floor(kecil(bawah.amount0, atas.amount0)),
    min1: floor(kecil(bawah.amount1, atas.amount1)),
  };
}
