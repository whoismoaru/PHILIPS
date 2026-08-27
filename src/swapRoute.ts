import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';
import { approveExact } from './chain.js';
import { NATIVE, relayQuoteOut, slipLadder, swapTokenViaRelay } from './relay.js';
import { lifiQuoteOut, swapViaLifi } from './lifi.js';

/**
 * Swap generik EXACT-IN `from`→`to` (ERC20→ERC20) lewat RUTE TERBAIK:
 *   1. Quote Uniswap (pool ter-likuid) & Relay (agregator) → pilih output tertinggi.
 *   2. Eksekusi rute terpilih; bila gagal, fallback ke rute lain.
 * Invariant keselamatan §8: minOut dari quoter (floor slippage, TAK pernah minOut=0),
 * verifikasi saldo benar-benar berubah, fallback penuh. Dipakai fitur /swap (sisi BELI
 * base→token). Sisi JUAL token→base tetap pakai swapTokenTo{Eth,Usdg}Robust yang teruji.
 */

// Bentuk struct ikut chain: PancakeSwap (SwapRouter v3 asli) memakai `deadline`,
// SwapRouter02 Uniswap tidak. Bentuk salah = revert tanpa data.
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const ROUTER_ABI_DEADLINE = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];

const bal = (token: string, ctx: ChainCtx): Promise<bigint> =>
  new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], ctx.provider)
    .balanceOf(ctx.wallet.address) as Promise<bigint>;

// LI.FI = router UTAMA. Dipakai selama rate-nya tak lebih jelek dari alternatif
// terbaik lebih dari LIFI_TOL, dan quote-nya tak kelamaan (LIFI_TIMEOUT_MS).
// Kalau jelek/lambat → mundur ke Relay/Uniswap (best-of).
const LIFI_TOL = 0.015; // 1.5%
const LIFI_TIMEOUT_MS = 12_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
/** LI.FI dipilih duluan bila quote-nya ≥ (1 − tol) × alternatif terbaik. */
const lifiPreferred = (lifi: bigint, bestOther: bigint): boolean =>
  lifi > 0n && lifi * 1000n >= bestOther * BigInt(Math.floor((1 - LIFI_TOL) * 1000));

/** Quote Uniswap exact-in di pool from/to ter-likuid. null bila tak ada pool/quoter gagal. */
export async function quoteUniswap(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ out: bigint; fee: number } | null> {
  // Pilih fee-tier dgn reserve `to` terbesar (paling likuid).
  const toC = new ethers.Contract(toAddr, ['function balanceOf(address) view returns (uint256)'], ctx.provider);
  let bestFee = 0;
  let bestReserve = -1n;
  await Promise.all(
    ctx.feeTiers.map(async (fee) => {
      try {
        const pool: string = await ctx.factory.getPool(fromAddr, toAddr, fee);
        if (!pool || pool === ethers.ZeroAddress) return;
        const r: bigint = await toC.balanceOf(pool);
        if (r > bestReserve) {
          bestReserve = r;
          bestFee = fee;
        }
      } catch {
        /* pool tak ada di fee ini */
      }
    }),
  );
  if (bestReserve < 0n) return null;
  try {
    const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, ctx.wallet);
    const q = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: fromAddr,
      tokenOut: toAddr,
      amountIn: amountInWei,
      fee: bestFee,
      sqrtPriceLimitX96: 0n,
    });
    const out = BigInt(q[0]);
    return out > 0n ? { out, fee: bestFee } : null;
  } catch {
    return null;
  }
}

/** Output terbaik antar Uniswap, Relay & LI.FI (untuk kartu konfirmasi). null bila semua kosong. */
export async function previewSwapOut(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ route: 'uniswap' | 'relay' | 'lifi'; out: bigint } | null> {
  const [uni, relay, lifi] = await Promise.all([
    quoteUniswap(fromAddr, toAddr, amountInWei, ctx),
    relayQuoteOut(fromAddr, toAddr, amountInWei, ctx),
    withTimeout(lifiQuoteOut(fromAddr, toAddr, amountInWei, ctx), LIFI_TIMEOUT_MS),
  ]);
  const uniOut = uni?.out ?? 0n;
  const rOut = relay ?? 0n;
  const lOut = lifi ?? 0n;
  const bestOther = uniOut > rOut ? uniOut : rOut;
  // LI.FI utama: dipakai selama rate-nya tak jelek. Kalau jelek/lambat → best-of lain.
  if (lifiPreferred(lOut, bestOther)) return { route: 'lifi', out: lOut };
  const cands: Array<{ route: 'uniswap' | 'relay' | 'lifi'; out: bigint }> = [
    { route: 'uniswap' as const, out: uniOut },
    { route: 'relay' as const, out: rOut },
    { route: 'lifi' as const, out: lOut },
  ].sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  return cands[0].out > 0n ? cands[0] : null;
}

async function uniExec(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  fee: number,
  minOut: bigint,
  ctx: ChainCtx,
): Promise<{ outWei: bigint; txHashes: string[] }> {
  if (minOut <= 0n) throw new Error('quoter returned 0 — swap cancelled (sandwich protection)');
  const txHashes: string[] = [];
  txHashes.push(...(await approveExact(fromAddr, ctx.routerAddress, amountInWei, ctx.wallet)));
  const router = new ethers.Contract(
    ctx.routerAddress,
    ctx.routerHasDeadline ? ROUTER_ABI_DEADLINE : ROUTER_ABI,
    ctx.wallet,
  );
  const before = await bal(toAddr, ctx);
  const tx = await router.exactInputSingle({
    tokenIn: fromAddr,
    tokenOut: toAddr,
    fee,
    recipient: ctx.wallet.address,
    ...(ctx.routerHasDeadline ? { deadline: BigInt(Math.floor(Date.now() / 1000) + 600) } : {}),
    amountIn: amountInWei,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  });
  await tx.wait();
  txHashes.push(tx.hash);
  const outWei = (await bal(toAddr, ctx)) - before;
  return { outWei, txHashes };
}

async function relayExec(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx,
): Promise<{ outWei: bigint; txHashes: string[] }> {
  const beforeFrom = await bal(fromAddr, ctx);
  const beforeTo = await bal(toAddr, ctx);
  const r = await swapTokenViaRelay(fromAddr, amountInWei, ethers.getAddress(toAddr), ctx);
  const afterFrom = await bal(fromAddr, ctx);
  if (beforeFrom - afterFrom < (amountInWei * 9n) / 10n) {
    throw new Error('relay did not reduce the input balance');
  }
  const outWei = (await bal(toAddr, ctx)) - beforeTo;
  return { outWei, txHashes: r.txHashes };
}

async function lifiExec(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx,
  slipPct: number,
): Promise<{ outWei: bigint; txHashes: string[] }> {
  const beforeFrom = await bal(fromAddr, ctx);
  const beforeTo = await bal(toAddr, ctx);
  const r = await swapViaLifi(fromAddr, toAddr, amountInWei, ctx, slipPct);
  const afterFrom = await bal(fromAddr, ctx);
  if (beforeFrom - afterFrom < (amountInWei * 9n) / 10n) {
    throw new Error('LI.FI did not reduce the input balance');
  }
  const outWei = (await bal(toAddr, ctx)) - beforeTo;
  return { outWei, txHashes: r.txHashes };
}

/**
 * Eksekusi swap `from`→`to` (ERC20→ERC20) rute terbaik. slip% floor dari quoter Uniswap.
 * Keduanya diverifikasi (saldo). Lempar hanya bila SEMUA rute gagal.
 */
export async function swapExactInBest(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
  slipPct = 5,
  maxSlipPct?: number,
): Promise<{ outWei: bigint; route: string; txHashes: string[] }> {
  const [uni, relayOut, lifiOut] = await Promise.all([
    quoteUniswap(fromAddr, toAddr, amountInWei, ctx),
    relayQuoteOut(fromAddr, toAddr, amountInWei, ctx),
    withTimeout(lifiQuoteOut(fromAddr, toAddr, amountInWei, ctx), LIFI_TIMEOUT_MS),
  ]);
  const uniOut = uni?.out ?? 0n;
  const rOut = relayOut ?? 0n;
  const lOut = lifiOut ?? 0n;
  const errors: string[] = [];

  const tryUni = async (slip: number) => {
    if (!uni) throw new Error('no Uniswap pool for this pair');
    const minOut = (uni.out * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
    return { ...(await uniExec(fromAddr, toAddr, amountInWei, uni.fee, minOut, ctx)), route: `uniswap(slip ${slip}%)` };
  };
  const tryRelay = async () => ({ ...(await relayExec(fromAddr, toAddr, amountInWei, ctx)), route: 'relay' });
  const tryLifi = async () => ({ ...(await lifiExec(fromAddr, toAddr, amountInWei, ctx, maxSlipPct ?? slipPct)), route: 'lifi' });

  // Tangga slippage Uniswap dijepit `maxSlipPct` (/buy & /sell mengirim 3): tanpa cap
  // percobaan kedua memakai 15% — jauh di atas yang kamu setujui di kartu konfirmasi.
  const uniSlips = maxSlipPct === undefined ? [slipPct, 15] : slipLadder(maxSlipPct);
  const uniSteps = uniSlips.map((s) => () => tryUni(s));
  // Urutkan penyedia menurut output quote (tertinggi dulu = likuiditas terdalam).
  // Rute yg quote-nya 0/null dibuang: tak ada gunanya dicoba. Uniswap dgn quote>0
  // membawa seluruh tangga slipp-nya; Relay & LI.FI satu percobaan masing-masing.
  const providers: Array<{ out: bigint; steps: Array<() => Promise<{ outWei: bigint; txHashes: string[]; route: string }>> }> = [
    { out: uniOut, steps: uniOut > 0n ? uniSteps : [] },
    { out: rOut, steps: rOut > 0n ? [tryRelay] : [] },
    { out: lOut, steps: lOut > 0n ? [tryLifi] : [] },
  ].sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  // LI.FI = router UTAMA: kalau rate-nya tak jelek (dalam toleransi) & sempat quote,
  // dahulukan di depan urutan; sisanya jadi cadangan. Kalau jelek/lambat → best-of biasa.
  const bestOther = uniOut > rOut ? uniOut : rOut;
  if (lifiPreferred(lOut, bestOther)) {
    const idx = providers.findIndex((p) => p.out === lOut && p.steps.length && p.steps[0] === tryLifi);
    if (idx > 0) providers.unshift(providers.splice(idx, 1)[0]);
  }
  const order = providers.flatMap((p) => p.steps);
  if (order.length === 0) throw new Error('no route quoted a positive output for this pair');

  for (const step of order) {
    try {
      return await step();
    } catch (e) {
      const why = (e as Error).message.slice(0, 70);
      // Rute yang gagal lalu ditambal rute berikutnya tetap harus terlihat — kalau
      // hanya dilaporkan saat SEMUA gagal, kegagalan berulang yang "tertolong"
      // fallback tak pernah muncul di journal sampai jadi kegagalan total.
      console.log(`[swap] rute gagal, coba berikutnya: ${why}`);
      errors.push(why);
    }
  }
  throw new Error('All swap routes failed:\n' + errors.join('\n'));
}
