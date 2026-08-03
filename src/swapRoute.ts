import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';
import { ERC20_ABI } from './chain.js';
import { NATIVE, relayQuoteOut, slipLadder, swapTokenViaRelay } from './relay.js';

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

/** Output terbaik antara Uniswap & Relay (untuk kartu konfirmasi). null bila keduanya kosong. */
export async function previewSwapOut(
  fromAddr: string,
  toAddr: string,
  amountInWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ route: 'uniswap' | 'relay'; out: bigint } | null> {
  const [uni, relay] = await Promise.all([
    quoteUniswap(fromAddr, toAddr, amountInWei, ctx),
    relayQuoteOut(fromAddr, toAddr, amountInWei, ctx),
  ]);
  const uniOut = uni?.out ?? 0n;
  const relayOut = relay ?? 0n;
  if (uniOut <= 0n && relayOut <= 0n) return null;
  return relayOut > uniOut ? { route: 'relay', out: relayOut } : { route: 'uniswap', out: uniOut };
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
  const from = new ethers.Contract(fromAddr, ERC20_ABI, ctx.wallet);
  const allowance: bigint = await from.allowance(ctx.wallet.address, ctx.routerAddress);
  if (allowance < amountInWei) {
    const atx = await from.approve(ctx.routerAddress, ethers.MaxUint256);
    await atx.wait();
    txHashes.push(atx.hash);
  }
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
  const [uni, relayOut] = await Promise.all([
    quoteUniswap(fromAddr, toAddr, amountInWei, ctx),
    relayQuoteOut(fromAddr, toAddr, amountInWei, ctx),
  ]);
  const uniOut = uni?.out ?? 0n;
  const rOut = relayOut ?? 0n;
  const errors: string[] = [];
  // Rute utama = output tertinggi.
  const uniFirst = uniOut >= rOut;

  const tryUni = async (slip: number) => {
    if (!uni) throw new Error('no Uniswap pool for this pair');
    const minOut = (uni.out * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
    return { ...(await uniExec(fromAddr, toAddr, amountInWei, uni.fee, minOut, ctx)), route: `uniswap(slip ${slip}%)` };
  };
  const tryRelay = async () => ({ ...(await relayExec(fromAddr, toAddr, amountInWei, ctx)), route: 'relay' });

  // Tangga slippage Uniswap dijepit `maxSlipPct` (/buy & /sell mengirim 3): tanpa cap
  // percobaan kedua memakai 15% — jauh di atas yang kamu setujui di kartu konfirmasi.
  const uniSlips = maxSlipPct === undefined ? [slipPct, 15] : slipLadder(maxSlipPct);
  const uniSteps = uniSlips.map((s) => () => tryUni(s));
  const order: Array<() => Promise<{ outWei: bigint; txHashes: string[]; route: string }>> = uniFirst
    ? [...uniSteps, tryRelay]
    : [tryRelay, ...uniSteps];

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
