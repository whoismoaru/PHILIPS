import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';

/**
 * Swap token → ETH native di chain yang sama lewat Relay (relay.link).
 * Relay mengembalikan daftar langkah transaksi; kita eksekusi berurutan
 * (termasuk approve bila perlu).
 */

const RELAY_API = 'https://api.relay.link/quote';
export const NATIVE = '0x0000000000000000000000000000000000000000';

/**
 * Bridge CROSS-CHAIN via Relay: aset origin (native/ERC20) → currency tujuan di
 * chain lain (mis. WETH/USDG @Robinhood → USDT @Stable). Dua tahap: getBridgeQuote
 * (preview, tanpa tx) → executeBridge (kirim langkah approve+deposit).
 */
export type BridgeQuote = {
  raw: any; // quote penuh Relay (dipakai executeBridge)
  inLabel: string; // "0.01 WETH"
  outLabel: string; // "19.29 USDT0"
  outUsd: string | null;
  feeUsd: string | null;
  impactPct: string | null;
};

export async function getBridgeQuote(opts: {
  originCtx: ChainCtx;
  originCurrency: string; // NATIVE (0x0) atau alamat ERC20
  amountWei: bigint;
  destChainId: number;
  destCurrency: string;
  recipient: string;
}): Promise<BridgeQuote> {
  const { originCtx, originCurrency, amountWei, destChainId, destCurrency, recipient } = opts;
  const body = {
    user: originCtx.wallet.address,
    recipient,
    originChainId: originCtx.chainId,
    destinationChainId: destChainId,
    originCurrency: originCurrency === NATIVE ? NATIVE : ethers.getAddress(originCurrency),
    destinationCurrency: ethers.getAddress(destCurrency),
    amount: amountWei.toString(),
    tradeType: 'EXACT_INPUT',
  };
  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Relay quote gagal (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const q: any = await res.json();
  if (!Array.isArray(q.steps)) throw new Error(`Relay: ${q.message ?? 'quote tak berisi langkah'}`);
  const det = q.details ?? {};
  const ci = det.currencyIn ?? {};
  const co = det.currencyOut ?? {};
  const feeGas = q.fees?.gas?.amountUsd;
  const feeRel = q.fees?.relayer?.amountUsd;
  const feeUsd = feeGas != null || feeRel != null ? (Number(feeGas ?? 0) + Number(feeRel ?? 0)).toFixed(2) : null;
  return {
    raw: q,
    inLabel: `${ci.amountFormatted ?? '?'} ${ci.currency?.symbol ?? ''}`.trim(),
    outLabel: `${co.amountFormatted ?? '?'} ${co.currency?.symbol ?? ''}`.trim(),
    outUsd: co.amountUsd != null ? Number(co.amountUsd).toFixed(2) : null,
    feeUsd,
    impactPct: det.totalImpact?.percent != null ? String(det.totalImpact.percent) : null,
  };
}

/** Eksekusi langkah bridge (approve bila ERC20, lalu deposit). Return tx hashes. */
export async function executeBridge(quote: BridgeQuote, originCtx: ChainCtx): Promise<{ txHashes: string[] }> {
  const wallet = originCtx.wallet;
  const txHashes: string[] = [];
  for (const step of quote.raw.steps ?? []) {
    for (const item of step.items ?? []) {
      const d = item?.data;
      if (!d?.to) continue;
      const tx = await wallet.sendTransaction({
        to: d.to,
        data: d.data,
        value: d.value ? BigInt(d.value) : 0n,
      });
      const rc = await tx.wait();
      if (rc) txHashes.push(rc.hash);
    }
  }
  return { txHashes };
}

export async function swapTokenToEthViaRelay(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const wallet = ctx.wallet;
  const body = {
    user: wallet.address,
    recipient: wallet.address,
    originChainId: ctx.chainId,
    destinationChainId: ctx.chainId,
    originCurrency: ethers.getAddress(tokenAddress),
    destinationCurrency: NATIVE,
    amount: amountWei.toString(),
    tradeType: 'EXACT_INPUT',
  };

  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Relay quote gagal (${res.status}): ${await res.text()}`);
  }
  const quote: any = await res.json();

  const txHashes: string[] = [];
  for (const step of quote.steps ?? []) {
    for (const item of step.items ?? []) {
      const d = item?.data;
      if (!d?.to) continue;
      const tx = await wallet.sendTransaction({
        to: d.to,
        data: d.data,
        value: d.value ? BigInt(d.value) : 0n,
      });
      const rc = await tx.wait();
      if (rc) txHashes.push(rc.hash);
    }
  }

  // Estimasi ETH keluar dari quote (kalau tersedia).
  let outEthWei = 0n;
  try {
    const raw = quote?.details?.currencyOut?.amount;
    if (raw) outEthWei = BigInt(raw);
  } catch {
    /* abaikan */
  }

  return { txHashes, outEthWei };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];

/** Fallback: swap token → WETH langsung via Uniswap SwapRouter02 (pool ter-likuid). */
async function swapViaUniswap(
  tokenAddress: string,
  amountWei: bigint,
  slippagePct: number,
  ctx: ChainCtx,
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const { ethers: e } = await import('ethers');
  const { discoverPools } = await import('./uniswap.js');
  const { ERC20_ABI } = await import('./chain.js');
  const { wallet, weth } = ctx;

  const pools = (await discoverPools(tokenAddress, ctx)).filter((p) => p.baseReserve > 0n);
  if (pools.length === 0) throw new Error('tidak ada pool WETH untuk fallback swap');
  const fee = pools[0].fee;

  const txHashes: string[] = [];
  const token = new e.Contract(tokenAddress, ERC20_ABI, wallet);
  const routerAddr = ctx.routerAddress;
  const allowance: bigint = await token.allowance(wallet.address, routerAddr);
  if (allowance < amountWei) {
    const atx = await token.approve(routerAddr, e.MaxUint256);
    await atx.wait();
    txHashes.push(atx.hash);
  }

  // minOut dari quoter, dikurangi slippage. Quoter gagal / kembali 0 → BATALKAN
  // route ini (JANGAN swap dgn minOut=0 — itu umpan sandwich). swapTokenToEthRobust
  // akan coba jalur lain; bila semua gagal, token ditahan (leftover/STOPPED) & sweep
  // mencoba lagi nanti — jauh lebih baik daripada dijual di harga berapa pun.
  let minOut: bigint;
  try {
    const quoter = new e.Contract(ctx.quoterAddress, QUOTER_ABI, wallet);
    const q = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenAddress,
      tokenOut: ctx.wethAddress,
      amountIn: amountWei,
      fee,
      sqrtPriceLimitX96: 0n,
    });
    minOut = (BigInt(q[0]) * BigInt(Math.floor((100 - slippagePct) * 100))) / 10000n;
  } catch (err) {
    throw new Error(`quoter gagal (${(err as Error).message.slice(0, 60)}) — swap dibatalkan, hindari minOut=0`);
  }
  if (minOut <= 0n) {
    throw new Error('quoter mengembalikan 0 — swap dibatalkan (hindari sandwich)');
  }

  const router = new e.Contract(routerAddr, ROUTER_ABI, wallet);
  const beforeWeth: bigint = await weth.balanceOf(wallet.address);
  const tx = await router.exactInputSingle({
    tokenIn: tokenAddress,
    tokenOut: ctx.wethAddress,
    fee,
    recipient: wallet.address,
    amountIn: amountWei,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  });
  await tx.wait();
  txHashes.push(tx.hash);

  // Unwrap WETH hasil swap → ETH native.
  const gotWeth: bigint = (await weth.balanceOf(wallet.address)) - beforeWeth;
  if (gotWeth > 0n) {
    const wtx = await weth.withdraw(gotWeth);
    await wtx.wait();
    txHashes.push(wtx.hash);
  }
  return { txHashes, outEthWei: gotWeth };
}

/**
 * Swap token → ETH TAHAN BANTING:
 *  1. Relay, retry 3x (backoff 2s/5s) — kuat saat jaringan/API ramai.
 *  2. Fallback Uniswap router: slippage 5%, lalu 15% bila revert (volume ramai).
 * Lempar error hanya kalau SEMUA jalur gagal.
 */
async function tokenBalance(tokenAddress: string, ctx: ChainCtx): Promise<bigint> {
  const c = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    ctx.provider,
  );
  return (await c.balanceOf(ctx.wallet.address)) as bigint;
}

/** Relay + VERIFIKASI saldo token benar-benar berkurang (Relay kadang "sukses" tanpa swap). */
async function relayVerified(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx,
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const before = await tokenBalance(tokenAddress, ctx);
  const r = await swapTokenToEthViaRelay(tokenAddress, amountWei, ctx);
  const after = await tokenBalance(tokenAddress, ctx);
  // Harus berkurang ≥90% dari yang diminta; kalau tidak, anggap Relay no-op.
  if (before - after < (amountWei * 9n) / 10n) {
    throw new Error(`relay tak mengurangi saldo token (before=${before} after=${after})`);
  }
  return r;
}

export async function swapTokenToEthRobust(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outEthWei: bigint; route: string }> {
  const errors: string[] = [];

  // Jalur 1: Relay (agregator, hasil ETH native langsung) — terverifikasi.
  try {
    const r = await relayVerified(tokenAddress, amountWei, ctx);
    return { ...r, route: 'relay' };
  } catch (e) {
    errors.push(`relay: ${(e as Error).message.slice(0, 80)}`);
  }

  // Jalur 2: langsung Uniswap router (exactInputSingle → swap FULL amountIn), slippage naik.
  for (const slip of [5, 15]) {
    try {
      const r = await swapViaUniswap(tokenAddress, amountWei, slip, ctx);
      return { ...r, route: `uniswap(slip ${slip}%)` };
    } catch (e) {
      errors.push(`uniswap${slip}%: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Jalur 3: Relay sekali lagi (siapa tahu gangguan tadi transien).
  await sleep(2000);
  try {
    const r = await relayVerified(tokenAddress, amountWei, ctx);
    return { ...r, route: 'relay(retry)' };
  } catch (e) {
    errors.push(`relay-retry: ${(e as Error).message.slice(0, 80)}`);
  }
  throw new Error('Semua jalur swap gagal:\n' + errors.join('\n'));
}

/**
 * Swap token → USDG (untuk close posisi pasangan USDG). Pilih pool USDG/token
 * terlikuid, exactInputSingle via Uniswap router dgn minOut dari quoter (floor,
 * sama seperti jalur WETH — quoter gagal/0 → BATALKAN, hindari sandwich).
 * Slippage 5% lalu 15% bila revert. USDG TIDAK di-unwrap (tetap stablecoin).
 */
export async function swapTokenToUsdgRobust(
  tokenAddress: string,
  amountWei: bigint,
  usdgAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outWei: bigint; route: string }> {
  const { wallet } = ctx;
  const usdg = new ethers.Contract(
    usdgAddress,
    ['function balanceOf(address) view returns (uint256)'],
    ctx.provider,
  );
  const token = new ethers.Contract(
    tokenAddress,
    [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
    ],
    wallet,
  );

  // Pool USDG/token terlikuid (USDG reserve terbesar).
  let bestFee = 0;
  let bestReserve = -1n;
  for (const fee of [100, 500, 3000, 10000]) {
    const pool: string = await ctx.factory.getPool(usdgAddress, tokenAddress, fee);
    if (!pool || pool === ethers.ZeroAddress) continue;
    const r: bigint = await usdg.balanceOf(pool);
    if (r > bestReserve) {
      bestReserve = r;
      bestFee = fee;
    }
  }
  if (bestReserve < 0n) throw new Error('tidak ada pool USDG untuk swap token→USDG');

  const routerAddr = ctx.routerAddress;
  const txHashes: string[] = [];
  const allowance: bigint = await token.allowance(wallet.address, routerAddr);
  if (allowance < amountWei) {
    const atx = await token.approve(routerAddr, ethers.MaxUint256);
    await atx.wait();
    txHashes.push(atx.hash);
  }

  const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, wallet);
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, wallet);
  let lastErr = '';
  for (const slip of [5, 15]) {
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenAddress,
        tokenOut: usdgAddress,
        amountIn: amountWei,
        fee: bestFee,
        sqrtPriceLimitX96: 0n,
      });
      const minOut = (BigInt(q[0]) * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      if (minOut <= 0n) throw new Error('quoter mengembalikan 0 (hindari sandwich)');
      const before: bigint = await usdg.balanceOf(wallet.address);
      const tx = await router.exactInputSingle({
        tokenIn: tokenAddress,
        tokenOut: usdgAddress,
        fee: bestFee,
        recipient: wallet.address,
        amountIn: amountWei,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      });
      await tx.wait();
      txHashes.push(tx.hash);
      const outWei = (await usdg.balanceOf(wallet.address)) - before;
      return { txHashes, outWei, route: `uniswap-usdg(slip ${slip}%)` };
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 80);
    }
  }
  throw new Error(`swap token→USDG gagal: ${lastErr}`);
}
