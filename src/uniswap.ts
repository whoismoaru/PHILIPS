import { ethers } from 'ethers';
import sdkCore from '@uniswap/sdk-core';
import v3sdk, { type FeeAmount } from '@uniswap/v3-sdk';
import type { Token as TToken } from '@uniswap/sdk-core';
import type { Pool as TPool, Position as TPosition } from '@uniswap/v3-sdk';
// SDK Uniswap masih CommonJS → impor default lalu ambil isinya.
const { Token, Percent, CurrencyAmount } = sdkCore;
const { Pool, Position, TICK_SPACINGS, nearestUsableTick, tickToPrice } = v3sdk;
import { ERC20_ABI } from './chain.js';
import { getChain, type ChainCtx } from './chains.js';

const MAX_UINT128 = (1n << 128n) - 1n;
const SLIPPAGE = new Percent(50, 10_000); // 0.5%

/** Fee tier yang valid di Uniswap v3. */
export const VALID_FEES = [100, 500, 3000, 10000];

// Cache metadata token per chain (alamat sama bisa ada di banyak chain).
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

export async function getTokenMeta(
  address: string,
  ctx: ChainCtx = getChain(),
): Promise<{ symbol: string; decimals: number }> {
  const key = `${ctx.key}:${address.toLowerCase()}`;
  const cached = tokenMetaCache.get(key);
  if (cached) return cached;
  const c = new ethers.Contract(address, ERC20_ABI, ctx.provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  const meta = { symbol: symbol as string, decimals: Number(decimals) };
  tokenMetaCache.set(key, meta);
  return meta;
}

/** Ubah alamat token jadi objek Token milik SDK (butuh decimals & symbol). */
async function toSdkToken(address: string, ctx: ChainCtx): Promise<TToken> {
  const meta = await getTokenMeta(address, ctx);
  return new Token(ctx.chainId, ethers.getAddress(address), meta.decimals, meta.symbol);
}

type PoolState = {
  poolAddress: string;
  sdkPool: TPool;
  token0: string;
  token1: string;
  wethIsToken0: boolean;
  tokenOther: TToken; // token selain WETH
  sdkWeth: TToken;
  currentTick: number;
};

/** Baca kondisi pool dari on-chain lalu bangun objek Pool milik SDK. */
export async function loadPool(
  tokenAddress: string,
  fee: number,
  ctx: ChainCtx = getChain(),
): Promise<PoolState> {
  if (!VALID_FEES.includes(fee)) {
    throw new Error(`Fee tier ${fee} tidak valid. Pilihan: ${VALID_FEES.join(', ')}`);
  }
  const poolAddress: string = await ctx.factory.getPool(ctx.wethAddress, tokenAddress, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new Error('Pool untuk pasangan & fee ini belum ada di Uniswap.');
  }

  const poolAbi = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
  ];
  const pool = new ethers.Contract(poolAddress, poolAbi, ctx.provider);
  const [slot0, liquidity, token0, token1] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
    pool.token1(),
  ]);

  const sqrtPriceX96: bigint = slot0[0];
  const currentTick = Number(slot0[1]);
  const wethIsToken0 = token0.toLowerCase() === ctx.wethAddress.toLowerCase();

  const sdkToken0 = await toSdkToken(token0, ctx);
  const sdkToken1 = await toSdkToken(token1, ctx);
  const sdkPool = new Pool(
    sdkToken0,
    sdkToken1,
    fee as FeeAmount,
    sqrtPriceX96.toString(),
    liquidity.toString(),
    currentTick,
  );

  const sdkWeth = wethIsToken0 ? sdkToken0 : sdkToken1;
  const tokenOther = wethIsToken0 ? sdkToken1 : sdkToken0;

  return {
    poolAddress,
    sdkPool,
    token0,
    token1,
    wethIsToken0,
    tokenOther,
    sdkWeth,
    currentTick,
  };
}

/** Ubah lebar rentang (persen PENURUNAN harga token) menjadi jumlah tick.
 *  Target: ujung terjauh = harga turun tepat X%. faktor = 1 - X/100 →
 *  width = |ln(1-X/100)| / ln(1.0001). Dibulatkan KELUAR (ceil) ke kelipatan
 *  spacing supaya rentang minimal menutup X% yang diminta. */
function widthInTicks(rangePercent: number, spacing: number): number {
  const frac = Math.min(Math.max(rangePercent, 0.1), 95) / 100;
  const raw = Math.abs(Math.log(1 - frac)) / Math.log(1.0001);
  return Math.max(spacing, Math.ceil(raw / spacing) * spacing);
}

export type AddPlan = {
  wethIsToken0: boolean;
  tickLower: number;
  tickUpper: number;
  priceLower: string;
  priceUpper: string;
  wethAmountWei: bigint;
  otherAmountWei: bigint; // idealnya ~0 (single-sided)
  otherSymbol: string;
  currentPrice: string; // harga token sekarang dalam WETH
  pctLow: number; // % ujung terjauh dari harga sekarang (paling negatif)
  pctHigh: number; // % ujung terdekat dari harga sekarang
  position: TPosition;
};

/**
 * Hitung rencana posisi SINGLE-SIDED (hanya WETH):
 *  - Kalau WETH = token0 → rentang harus DI ATAS harga sekarang.
 *  - Kalau WETH = token1 → rentang harus DI BAWAH harga sekarang.
 * Dengan begitu token yang lain dibutuhkan ~0.
 */
export async function planAddSingleSided(
  tokenAddress: string,
  fee: number,
  ethAmount: string,
  rangePercent: number,
  ctx: ChainCtx = getChain(),
): Promise<AddPlan> {
  const st = await loadPool(tokenAddress, fee, ctx);
  const spacing = TICK_SPACINGS[fee as FeeAmount];
  const width = widthInTicks(rangePercent, spacing);
  const ethWei = ethers.parseEther(ethAmount);

  let tickLower: number;
  let tickUpper: number;
  let position: TPosition;

  if (st.wethIsToken0) {
    // Rentang di ATAS tick sekarang → butuh hanya token0 (WETH).
    // Ambil kelipatan spacing TERDEKAT di atas current (ceil) biar mepet harga.
    let lower = Math.ceil(st.currentTick / spacing) * spacing;
    if (lower <= st.currentTick) lower += spacing;
    tickLower = lower;
    tickUpper = lower + width;
    position = Position.fromAmount0({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount0: ethWei.toString(),
      useFullPrecision: true,
    });
  } else {
    // Rentang di BAWAH tick sekarang → butuh hanya token1 (WETH).
    let upper = Math.floor(st.currentTick / spacing) * spacing;
    if (upper >= st.currentTick) upper -= spacing;
    tickUpper = upper;
    tickLower = upper - width;
    position = Position.fromAmount1({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount1: ethWei.toString(),
    });
  }

  const mint = position.mintAmounts;
  const amount0 = BigInt(mint.amount0.toString());
  const amount1 = BigInt(mint.amount1.toString());
  const wethAmountWei = st.wethIsToken0 ? amount0 : amount1;
  const otherAmountWei = st.wethIsToken0 ? amount1 : amount0;

  // Harga token (dalam WETH) di kedua ujung rentang, untuk ditampilkan.
  const pLower = tickToPrice(st.tokenOther, st.sdkWeth, tickLower).toSignificant(6);
  const pUpper = tickToPrice(st.tokenOther, st.sdkWeth, tickUpper).toSignificant(6);
  const [priceLower, priceUpper] =
    Number(pLower) <= Number(pUpper) ? [pLower, pUpper] : [pUpper, pLower];

  // Rentang dalam persen relatif terhadap harga token sekarang.
  const currentPrice = st.sdkPool.priceOf(st.tokenOther).toSignificant(8);
  const cur = Number(currentPrice);
  const pctLow = cur > 0 ? (Number(priceLower) / cur - 1) * 100 : 0;
  const pctHigh = cur > 0 ? (Number(priceUpper) / cur - 1) * 100 : 0;

  return {
    wethIsToken0: st.wethIsToken0,
    tickLower,
    tickUpper,
    priceLower,
    priceUpper,
    wethAmountWei,
    otherAmountWei,
    otherSymbol: st.tokenOther.symbol!,
    currentPrice,
    pctLow,
    pctHigh,
    position,
  };
}

/** Pastikan saldo WETH cukup (bungkus ETH bila perlu) & izin (approve) ke Position Manager. */
const GAS_BUFFER = ethers.parseEther('0.0005'); // cadangan gas L2

async function ensureWethReady(amountWei: bigint, ctx: ChainCtx): Promise<string[]> {
  const { weth, wallet, provider } = ctx;
  const native = ctx.nativeSymbol;
  const notes: string[] = [];
  let bal: bigint = await weth.balanceOf(wallet.address);

  // Pre-flight: pastikan saldo native cukup untuk wrap + gas, dengan pesan jelas.
  if (bal < amountWei) {
    const need = amountWei - bal;
    const ethBal = await provider.getBalance(wallet.address);
    if (ethBal < need + GAS_BUFFER) {
      throw new Error(
        `Saldo ${native} di ${ctx.label} kurang: butuh ~${ethers.formatEther(need + GAS_BUFFER)} ` +
          `(wrap + gas), tersedia ${ethers.formatEther(ethBal)}. Isi wallet dulu atau kecilkan nominal.`,
      );
    }
    const tx = await weth.deposit({ value: need });
    await tx.wait();
    notes.push(`Bungkus ${ethers.formatEther(need)} ${native} (tx ${tx.hash})`);
    // Verifikasi hasil wrap; kalau masih kurang (kondisi balapan), wrap ulang sekali.
    bal = await weth.balanceOf(wallet.address);
    if (bal < amountWei) {
      const tx2 = await weth.deposit({ value: amountWei - bal });
      await tx2.wait();
      notes.push(`Wrap tambahan ${ethers.formatEther(amountWei - bal)} ${native} (tx ${tx2.hash})`);
      bal = await weth.balanceOf(wallet.address);
      if (bal < amountWei) throw new Error('Wrap tetap kurang setelah retry — coba lagi.');
    }
  }
  const allowance: bigint = await weth.allowance(wallet.address, ctx.pmAddress);
  if (allowance < amountWei) {
    const tx = await weth.approve(ctx.pmAddress, ethers.MaxUint256);
    await tx.wait();
    notes.push(`Setujui WETH untuk Position Manager (tx ${tx.hash})`);
  }
  return notes;
}

/** Eksekusi penambahan LP single-sided. Mengembalikan tokenId posisi baru + catatan. */
export async function executeAdd(
  plan: AddPlan,
  tokenAddress: string,
  fee: number,
  ctx: ChainCtx = getChain(),
): Promise<{ tokenId: string; notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const notes = await ensureWethReady(plan.wethAmountWei, ctx);

  const withSlip = plan.position.mintAmountsWithSlippage(SLIPPAGE);
  const params = {
    token0: plan.wethIsToken0 ? ctx.wethAddress : tokenAddress,
    token1: plan.wethIsToken0 ? tokenAddress : ctx.wethAddress,
    fee,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    amount0Desired: BigInt(plan.position.mintAmounts.amount0.toString()),
    amount1Desired: BigInt(plan.position.mintAmounts.amount1.toString()),
    amount0Min: BigInt(withSlip.amount0.toString()),
    amount1Min: BigInt(withSlip.amount1.toString()),
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600,
  };

  let receipt;
  try {
    const tx = await positionManager.mint(params);
    receipt = await tx.wait();
  } catch (e) {
    // STF = transfer WETH gagal (saldo/allowance). Pulihkan sekali lalu retry.
    if (/STF/i.test((e as Error).message)) {
      notes.push('Mint kena STF — verifikasi ulang WETH & retry...');
      notes.push(...(await ensureWethReady(plan.wethAmountWei, ctx)));
      const tx = await positionManager.mint({ ...params, deadline: Math.floor(Date.now() / 1000) + 600 });
      receipt = await tx.wait();
    } else {
      throw e;
    }
  }
  notes.push(`Mint posisi terkirim (tx ${receipt.hash})`);

  // tokenId dibaca dari event Transfer(0x0 -> wallet) di receipt mint sendiri.
  // JANGAN pakai tokenOfOwnerByIndex(bal-1): urutan index ERC721 berubah-ubah
  // saat ada NFT lain di-burn — pernah menyebabkan record menunjuk NFT lama.
  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const pmAddr = String(positionManager.target).toLowerCase();
  let tokenId: bigint | null = null;
  for (const log of receipt.logs ?? []) {
    if (
      log.address.toLowerCase() === pmAddr &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics.length === 4 &&
      BigInt(log.topics[1]) === 0n && // from = 0x0 (mint)
      BigInt(log.topics[2]) === BigInt(wallet.address)
    ) {
      tokenId = BigInt(log.topics[3]);
      break;
    }
  }
  if (tokenId === null) {
    // Fallback terakhir (seharusnya tak pernah terjadi).
    notes.push('⚠️ Event mint tak ditemukan di receipt — pakai index terakhir.');
    const bal: bigint = await positionManager.balanceOf(wallet.address);
    tokenId = BigInt(await positionManager.tokenOfOwnerByIndex(wallet.address, bal - 1n));
  }
  return { tokenId: tokenId!.toString(), notes };
}

export type PositionInfo = {
  tokenId: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  inRange: boolean;
};

/** Daftar semua posisi LP milik dompet bot (per chain). */
export async function listPositions(ctx: ChainCtx = getChain()): Promise<PositionInfo[]> {
  const { positionManager, wallet } = ctx;
  const n: bigint = await positionManager.balanceOf(wallet.address);
  const out: PositionInfo[] = [];
  for (let i = 0n; i < n; i++) {
    const tokenId: bigint = await positionManager.tokenOfOwnerByIndex(wallet.address, i);
    const p = await positionManager.positions(tokenId);
    const [m0, m1] = await Promise.all([getTokenMeta(p.token0, ctx), getTokenMeta(p.token1, ctx)]);
    let inRange = false;
    try {
      const poolAddr: string = await ctx.factory.getPool(p.token0, p.token1, p.fee);
      const pool = new ethers.Contract(
        poolAddr,
        ['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)'],
        ctx.provider,
      );
      const slot0 = await pool.slot0();
      const cur = Number(slot0[1]);
      inRange = cur >= Number(p.tickLower) && cur < Number(p.tickUpper);
    } catch {
      /* biarkan inRange = false kalau pool tak terbaca */
    }
    out.push({
      tokenId: tokenId.toString(),
      token0Symbol: m0.symbol,
      token1Symbol: m1.symbol,
      fee: Number(p.fee),
      tickLower: Number(p.tickLower),
      tickUpper: Number(p.tickUpper),
      liquidity: BigInt(p.liquidity),
      inRange,
    });
  }
  return out;
}

/** Tarik SELURUH likuiditas, kumpulkan token, lalu burn NFT-nya.
 *  Menangani posisi kosong (likuiditas 0): skip decrease, langsung collect+burn. */
export async function executeRemove(
  tokenId: string,
  ctx: ChainCtx = getChain(),
): Promise<{ notes: string[] }> {
  const { positionManager, wallet } = ctx;
  const p = await positionManager.positions(tokenId);
  const liquidity: bigint = BigInt(p.liquidity);

  const iface = positionManager.interface;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const calls: string[] = [];
  if (liquidity > 0n) {
    calls.push(
      iface.encodeFunctionData('decreaseLiquidity', [
        { tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline },
      ]),
    );
  }
  calls.push(
    iface.encodeFunctionData('collect', [
      { tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
    ]),
  );
  calls.push(iface.encodeFunctionData('burn', [tokenId]));

  const tx = await positionManager.multicall(calls);
  const receipt = await tx.wait();
  return {
    notes: [`Tutup posisi #${tokenId}${liquidity === 0n ? ' (kosong → langsung burn)' : ''} (tx ${receipt.hash})`],
  };
}

export type PoolOption = {
  fee: number;
  poolAddress: string;
  wethReserve: bigint; // WETH tersimpan di pool (proksi kedalaman likuiditas)
  priceTokenInWeth: string | null;
};

/** Cari SEMUA pool WETH/token di seluruh fee tier, urut dari likuiditas terbesar. */
export async function discoverPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  const out: PoolOption[] = [];
  for (const fee of VALID_FEES) {
    const poolAddress: string = await ctx.factory.getPool(ctx.wethAddress, tokenAddress, fee);
    if (!poolAddress || poolAddress === ethers.ZeroAddress) continue;
    const wethReserve: bigint = await ctx.weth.balanceOf(poolAddress);
    let priceTokenInWeth: string | null = null;
    try {
      priceTokenInWeth = (await priceInfo(tokenAddress, fee, ctx)).priceTokenInWeth;
    } catch {
      /* abaikan bila harga tak terbaca */
    }
    out.push({ fee, poolAddress, wethReserve, priceTokenInWeth });
  }
  out.sort((a, b) => (b.wethReserve > a.wethReserve ? 1 : b.wethReserve < a.wethReserve ? -1 : 0));
  return out;
}

// Cache TTL pendek — HANYA untuk tampilan (mis. /status walletHoldings) agar
// tak spam RPC saat refresh berulang. JALUR UANG (swap fallback, /add) TETAP
// pakai discoverPools fresh: data lawas hanya memengaruhi nilai tampilan, bukan
// keamanan swap (minOut tetap dari quoter live).
const _poolsCache = new Map<string, { t: number; v: PoolOption[] }>();

export async function discoverPoolsCached(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
  ttlMs = 30_000,
): Promise<PoolOption[]> {
  const key = `${ctx.key}:${tokenAddress.toLowerCase()}`;
  const hit = _poolsCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await discoverPools(tokenAddress, ctx);
  _poolsCache.set(key, { t: Date.now(), v });
  return v;
}

/** Info harga & sisi WETH untuk sebuah pool. */
export async function priceInfo(tokenAddress: string, fee: number, ctx: ChainCtx = getChain()) {
  const st = await loadPool(tokenAddress, fee, ctx);
  const priceTokenInWeth = st.sdkPool.priceOf(st.tokenOther).toSignificant(6);
  return {
    otherSymbol: st.tokenOther.symbol!,
    wethIsToken0: st.wethIsToken0,
    currentTick: st.currentTick,
    priceTokenInWeth,
    poolAddress: st.poolAddress,
  };
}

export type PositionDetail = {
  tokenId: string;
  fee: number;
  otherSymbol: string;
  inRange: boolean;
  liquidity: bigint;
  valueWethWei: bigint; // nilai pokok posisi (dalam WETH)
  feesWethWei: bigint; // fee belum diklaim (dalam WETH)
  side: 'above' | 'in' | 'below'; // harga token vs rentang (above=belum mulai, below=terkonversi penuh)
  wethAmountWei: bigint; // komposisi pokok: sisi WETH
  otherAmountWei: bigint; // komposisi pokok: sisi token (raw, desimal token)
  otherDecimals: number;
  otherAddress: string; // alamat token non-WETH
  wethIsToken0: boolean;
  currentTick: number; // tick pool saat ini (utk hitung jarak range live)
  tickLower: number;
  tickUpper: number;
};

/** Hitung nilai pokok + fee belum diklaim sebuah posisi, semuanya dalam WETH. */
export async function getPositionDetail(
  tokenId: string,
  ctx: ChainCtx = getChain(),
): Promise<PositionDetail> {
  const { positionManager, wallet } = ctx;
  const p = await positionManager.positions(tokenId);
  const fee = Number(p.fee);
  const wethIsToken0 = p.token0.toLowerCase() === ctx.wethAddress.toLowerCase();
  const liquidity = BigInt(p.liquidity);
  const tickLower = Number(p.tickLower);
  const tickUpper = Number(p.tickUpper);

  const [m0, m1] = await Promise.all([getTokenMeta(p.token0, ctx), getTokenMeta(p.token1, ctx)]);
  const poolAddress: string = await ctx.factory.getPool(p.token0, p.token1, fee);
  const pool = new ethers.Contract(
    poolAddress,
    [
      'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
      'function liquidity() view returns (uint128)',
    ],
    ctx.provider,
  );
  const [slot0, poolLiq] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const sqrtPriceX96: bigint = slot0[0];
  const currentTick = Number(slot0[1]);

  const sdkToken0 = new Token(ctx.chainId, ethers.getAddress(p.token0), m0.decimals, m0.symbol);
  const sdkToken1 = new Token(ctx.chainId, ethers.getAddress(p.token1), m1.decimals, m1.symbol);
  const sdkPool = new Pool(sdkToken0, sdkToken1, fee as FeeAmount, sqrtPriceX96.toString(), poolLiq.toString(), currentTick);
  const position = new Position({ pool: sdkPool, liquidity: liquidity.toString(), tickLower, tickUpper });

  const tokenOther = wethIsToken0 ? sdkToken1 : sdkToken0;
  const priceOther = sdkPool.priceOf(tokenOther);

  // Nilai pokok dalam WETH.
  const amt0 = position.amount0;
  const amt1 = position.amount1;
  const wethAmt = wethIsToken0 ? amt0 : amt1;
  const otherAmt = wethIsToken0 ? amt1 : amt0;
  const wethAmountWei = BigInt(wethAmt.quotient.toString());
  const otherAmountWei = BigInt(otherAmt.quotient.toString());
  const valueWethWei = wethAmountWei + BigInt(priceOther.quote(otherAmt).quotient.toString());

  // Fee belum diklaim: collect.staticCall memicu update fee lalu mengembalikan jumlahnya.
  let feesWethWei = 0n;
  try {
    const owed = await positionManager.collect.staticCall({
      tokenId,
      recipient: wallet.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    const owedWeth = wethIsToken0 ? BigInt(owed[0]) : BigInt(owed[1]);
    const owedOther = wethIsToken0 ? BigInt(owed[1]) : BigInt(owed[0]);
    feesWethWei = owedWeth;
    if (owedOther > 0n) {
      const oa = CurrencyAmount.fromRawAmount(tokenOther, owedOther.toString());
      feesWethWei += BigInt(priceOther.quote(oa).quotient.toString());
    }
  } catch {
    /* biarkan fee 0 kalau simulasi gagal */
  }

  // Arah dalam istilah HARGA TOKEN: tergantung sisi WETH di pool.
  const inR = currentTick >= tickLower && currentTick < tickUpper;
  let side: 'above' | 'in' | 'below' = 'in';
  if (!inR) {
    if (wethIsToken0) side = currentTick < tickLower ? 'above' : 'below';
    else side = currentTick >= tickUpper ? 'above' : 'below';
  }

  return {
    tokenId,
    fee,
    otherSymbol: tokenOther.symbol!,
    inRange: inR,
    side,
    liquidity,
    valueWethWei,
    feesWethWei,
    wethAmountWei,
    otherAmountWei,
    otherDecimals: tokenOther.decimals,
    otherAddress: wethIsToken0 ? p.token1 : p.token0,
    wethIsToken0,
    currentTick,
    tickLower,
    tickUpper,
  };
}
