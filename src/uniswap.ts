import { ethers } from 'ethers';
import sdkCore from '@uniswap/sdk-core';
import v3sdk, { type FeeAmount } from '@uniswap/v3-sdk';
import type { Token as TToken } from '@uniswap/sdk-core';
import type { Pool as TPool, Position as TPosition } from '@uniswap/v3-sdk';
// SDK Uniswap masih CommonJS → impor default lalu ambil isinya.
const { Token, Percent, CurrencyAmount } = sdkCore;
const { Pool, Position, TICK_SPACINGS, nearestUsableTick, tickToPrice } = v3sdk;
import { ERC20_ABI } from './chain.js';
import { getChain, baseOf, basesFor, detectBase, type ChainCtx, type BaseAsset, type BaseKind } from './chains.js';

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
  baseIsToken0: boolean;
  tokenOther: TToken; // token selain base (WETH/USDG)
  sdkBase: TToken;
  currentTick: number;
};

/** Baca kondisi pool base/token dari on-chain lalu bangun objek Pool milik SDK. */
export async function loadPool(
  tokenAddress: string,
  fee: number,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<PoolState> {
  if (!VALID_FEES.includes(fee)) {
    throw new Error(`Fee tier ${fee} tidak valid. Pilihan: ${VALID_FEES.join(', ')}`);
  }
  const poolAddress: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new Error(`Pool ${base.symbol}/token fee ini belum ada di Uniswap.`);
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
  const baseIsToken0 = token0.toLowerCase() === base.address.toLowerCase();

  const [sdkToken0, sdkToken1] = await Promise.all([toSdkToken(token0, ctx), toSdkToken(token1, ctx)]);
  const sdkPool = new Pool(
    sdkToken0,
    sdkToken1,
    fee as FeeAmount,
    sqrtPriceX96.toString(),
    liquidity.toString(),
    currentTick,
  );

  const sdkBase = baseIsToken0 ? sdkToken0 : sdkToken1;
  const tokenOther = baseIsToken0 ? sdkToken1 : sdkToken0;

  return {
    poolAddress,
    sdkPool,
    token0,
    token1,
    baseIsToken0,
    tokenOther,
    sdkBase,
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
  baseKind: BaseKind;
  baseSymbol: string;
  baseDecimals: number;
  baseIsToken0: boolean;
  tickLower: number;
  tickUpper: number;
  priceLower: string;
  priceUpper: string;
  baseAmountWei: bigint; // pokok base (WETH 18-dec / USDG 6-dec)
  otherAmountWei: bigint; // idealnya ~0 (single-sided)
  otherSymbol: string;
  currentPrice: string; // harga token sekarang dalam base
  pctLow: number; // % ujung terjauh dari harga sekarang (paling negatif)
  pctHigh: number; // % ujung terdekat dari harga sekarang
  position: TPosition;
};

/**
 * Hitung rencana posisi SINGLE-SIDED (hanya base = WETH atau USDG):
 *  - Kalau base = token0 → rentang harus DI ATAS harga sekarang.
 *  - Kalau base = token1 → rentang harus DI BAWAH harga sekarang.
 * Dengan begitu token yang lain dibutuhkan ~0. Jumlah base memakai
 * parseUnits(base.decimals) — WAJIB (USDG 6-dec ≠ WETH 18-dec).
 */
export async function planAddSingleSided(
  tokenAddress: string,
  fee: number,
  amount: string,
  rangePercent: number,
  base: BaseAsset,
  ctx: ChainCtx = getChain(),
): Promise<AddPlan> {
  const st = await loadPool(tokenAddress, fee, base, ctx);
  const spacing = TICK_SPACINGS[fee as FeeAmount];
  const width = widthInTicks(rangePercent, spacing);
  const baseWei = ethers.parseUnits(amount, base.decimals);

  let tickLower: number;
  let tickUpper: number;
  let position: TPosition;

  if (st.baseIsToken0) {
    // Rentang di ATAS tick sekarang → butuh hanya token0 (base).
    // Ambil kelipatan spacing TERDEKAT di atas current (ceil) biar mepet harga.
    let lower = Math.ceil(st.currentTick / spacing) * spacing;
    if (lower <= st.currentTick) lower += spacing;
    tickLower = lower;
    tickUpper = lower + width;
    position = Position.fromAmount0({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount0: baseWei.toString(),
      useFullPrecision: true,
    });
  } else {
    // Rentang di BAWAH tick sekarang → butuh hanya token1 (base).
    let upper = Math.floor(st.currentTick / spacing) * spacing;
    if (upper >= st.currentTick) upper -= spacing;
    tickUpper = upper;
    tickLower = upper - width;
    position = Position.fromAmount1({
      pool: st.sdkPool,
      tickLower,
      tickUpper,
      amount1: baseWei.toString(),
    });
  }

  const mint = position.mintAmounts;
  const amount0 = BigInt(mint.amount0.toString());
  const amount1 = BigInt(mint.amount1.toString());
  const baseAmountWei = st.baseIsToken0 ? amount0 : amount1;
  const otherAmountWei = st.baseIsToken0 ? amount1 : amount0;

  // Harga token (dalam base) di kedua ujung rentang, untuk ditampilkan.
  const pLower = tickToPrice(st.tokenOther, st.sdkBase, tickLower).toSignificant(6);
  const pUpper = tickToPrice(st.tokenOther, st.sdkBase, tickUpper).toSignificant(6);
  const [priceLower, priceUpper] =
    Number(pLower) <= Number(pUpper) ? [pLower, pUpper] : [pUpper, pLower];

  // Rentang dalam persen relatif terhadap harga token sekarang.
  const currentPrice = st.sdkPool.priceOf(st.tokenOther).toSignificant(8);
  const cur = Number(currentPrice);
  const pctLow = cur > 0 ? (Number(priceLower) / cur - 1) * 100 : 0;
  const pctHigh = cur > 0 ? (Number(priceUpper) / cur - 1) * 100 : 0;

  return {
    baseKind: base.kind,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    baseIsToken0: st.baseIsToken0,
    tickLower,
    tickUpper,
    priceLower,
    priceUpper,
    baseAmountWei,
    otherAmountWei,
    otherSymbol: st.tokenOther.symbol!,
    currentPrice,
    pctLow,
    pctHigh,
    position,
  };
}

/** Pastikan saldo BASE cukup & izin (approve) ke Position Manager.
 *  WETH (wrappable): bungkus ETH native seperlunya. USDG (non-wrappable):
 *  wajib sudah dipegang — tak bisa di-wrap. Semua format pakai base.decimals. */
/** Estimasi unit gas buka LP (wrap + approve + mint). Dipakai juga oleh preview biaya. */
export const ADD_GAS_UNITS = 700_000n;

/**
 * Cadangan gas saat wrap: dulu datar 0.0005 ETH — di chain gas mahal itu 10× terlalu
 * kecil, ETH habis ke wrap lalu mint gagal "insufficient funds" & dana terjebak
 * sebagai WETH. Hitung dari harga gas nyata (+20% headroom), dengan lantai lama.
 */
async function gasBuffer(ctx: ChainCtx): Promise<bigint> {
  try {
    const fee = await ctx.provider.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice;
    if (price) {
      const est = (price * ADD_GAS_UNITS * 12n) / 10n;
      return est > MIN_GAS_BUFFER ? est : MIN_GAS_BUFFER;
    }
  } catch {
    /* pakai lantai */
  }
  return MIN_GAS_BUFFER;
}
const MIN_GAS_BUFFER = ethers.parseEther('0.0005'); // lantai cadangan gas L2

async function ensureBaseReady(base: BaseAsset, amountWei: bigint, ctx: ChainCtx): Promise<string[]> {
  const { wallet, provider } = ctx;
  const notes: string[] = [];
  const baseC = base.wrappable ? ctx.weth : new ethers.Contract(base.address, ERC20_ABI, wallet);
  let bal: bigint = await baseC.balanceOf(wallet.address);

  if (bal < amountWei) {
    if (!base.wrappable) {
      // USDG dsb: ERC20 biasa, harus SUDAH ada di wallet.
      throw new Error(
        `Saldo ${base.symbol} di ${ctx.label} kurang: butuh ${ethers.formatUnits(amountWei, base.decimals)}, ` +
          `tersedia ${ethers.formatUnits(bal, base.decimals)}. ${base.symbol} tak bisa di-wrap dari ETH — ` +
          `isi wallet dgn ${base.symbol} dulu atau kecilkan nominal.`,
      );
    }
    // WETH: wrap ETH native seperlunya, jaga cadangan gas.
    const native = ctx.nativeSymbol;
    const need = amountWei - bal;
    const ethBal = await provider.getBalance(wallet.address);
    const buffer = await gasBuffer(ctx);
    if (ethBal < need + buffer) {
      throw new Error(
        `Saldo ${native} di ${ctx.label} kurang: butuh ~${ethers.formatEther(need + buffer)} ` +
          `(wrap + gas), tersedia ${ethers.formatEther(ethBal)}. Isi wallet dulu atau kecilkan nominal.`,
      );
    }
    const tx = await ctx.weth.deposit({ value: need });
    await tx.wait();
    notes.push(`Bungkus ${ethers.formatEther(need)} ${native} (tx ${tx.hash})`);
    bal = await baseC.balanceOf(wallet.address);
    if (bal < amountWei) {
      const tx2 = await ctx.weth.deposit({ value: amountWei - bal });
      await tx2.wait();
      notes.push(`Wrap tambahan ${ethers.formatEther(amountWei - bal)} ${native} (tx ${tx2.hash})`);
      bal = await baseC.balanceOf(wallet.address);
      if (bal < amountWei) throw new Error('Wrap tetap kurang setelah retry — coba lagi.');
    }
  }
  const allowance: bigint = await baseC.allowance(wallet.address, ctx.pmAddress);
  if (allowance < amountWei) {
    const tx = await baseC.approve(ctx.pmAddress, ethers.MaxUint256);
    await tx.wait();
    notes.push(`Setujui ${base.symbol} untuk Position Manager (tx ${tx.hash})`);
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
  const base = baseOf(ctx, plan.baseKind);
  const notes = await ensureBaseReady(base, plan.baseAmountWei, ctx);

  const withSlip = plan.position.mintAmountsWithSlippage(SLIPPAGE);
  const params = {
    token0: plan.baseIsToken0 ? base.address : tokenAddress,
    token1: plan.baseIsToken0 ? tokenAddress : base.address,
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
    // STF = transfer base gagal (saldo/allowance). Pulihkan sekali lalu retry.
    if (/STF/i.test((e as Error).message)) {
      notes.push(`Mint kena STF — verifikasi ulang ${base.symbol} & retry...`);
      notes.push(...(await ensureBaseReady(base, plan.baseAmountWei, ctx)));
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
  token0: string; // alamat (untuk deteksi base/ca saat sinkron)
  token1: string;
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
      token0: p.token0,
      token1: p.token1,
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
  base: BaseKind; // 'weth' | 'usdg'
  baseSymbol: string;
  baseDecimals: number;
  baseReserve: bigint; // base tersimpan di pool (proksi kedalaman likuiditas)
};

/** Pool base/token di seluruh fee tier, urut kedalaman (base reserve) terbesar. */
async function poolsForBase(
  tokenAddress: string,
  base: BaseAsset,
  ctx: ChainCtx,
): Promise<PoolOption[]> {
  const baseC = base.wrappable ? ctx.weth : new ethers.Contract(base.address, ERC20_ABI, ctx.provider);
  // Semua fee tier diperiksa serentak (round-trip RPC diparalel + auto-batch ethers).
  const perFee = await Promise.all(
    VALID_FEES.map(async (fee): Promise<PoolOption | null> => {
      const poolAddress: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) return null;
      // Dulu ikut memanggil priceInfo (= loadPool penuh) per fee tier hanya untuk
      // mengisi field yang tak pernah dibaca siapa pun: ~55 RPC terbuang tiap discovery.
      const baseReserve: bigint = await baseC.balanceOf(poolAddress);
      return {
        fee,
        poolAddress,
        base: base.kind,
        baseSymbol: base.symbol,
        baseDecimals: base.decimals,
        baseReserve,
      };
    }),
  );
  const out = perFee.filter((p): p is PoolOption => p !== null);
  out.sort((a, b) => (b.baseReserve > a.baseReserve ? 1 : b.baseReserve < a.baseReserve ? -1 : 0));
  return out;
}

/** Pool WETH/token — dipakai jalur uang (swap fallback & valuasi USD holdings). */
export async function discoverPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  return poolsForBase(tokenAddress, baseOf(ctx, 'weth'), ctx);
}

/** Pool untuk SEMUA base (WETH + USDG bila tersedia) — dipakai wizard /add. */
export async function discoverAllPools(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<PoolOption[]> {
  const perBase = await Promise.all(basesFor(ctx).map((b) => poolsForBase(tokenAddress, b, ctx)));
  return perBase.flat();
}


/** Info harga & sisi base untuk sebuah pool. */
export async function priceInfo(tokenAddress: string, fee: number, base: BaseAsset, ctx: ChainCtx = getChain()) {
  const st = await loadPool(tokenAddress, fee, base, ctx);
  const priceTokenInBase = st.sdkPool.priceOf(st.tokenOther).toSignificant(6);
  return {
    otherSymbol: st.tokenOther.symbol!,
    baseIsToken0: st.baseIsToken0,
    currentTick: st.currentTick,
    priceTokenInBase,
    poolAddress: st.poolAddress,
  };
}

export type PositionDetail = {
  tokenId: string;
  fee: number;
  otherSymbol: string;
  inRange: boolean;
  liquidity: bigint;
  baseKind: BaseKind;
  baseSymbol: string;
  baseDecimals: number;
  currentPrice: string; // harga token sekarang dalam base (formula sama dgn AddPlan.currentPrice → basis alert anjlok)
  priceLower: string; // batas bawah rentang (harga token dalam base)
  priceUpper: string; // batas atas rentang
  valueBaseWei: bigint; // nilai pokok posisi (dalam base: WETH/USDG)
  feesBaseWei: bigint; // fee belum diklaim (dalam base)
  side: 'above' | 'in' | 'below'; // harga token vs rentang (above=belum mulai, below=terkonversi penuh)
  baseAmountWei: bigint; // komposisi pokok: sisi base
  otherAmountWei: bigint; // komposisi pokok: sisi token (raw, desimal token)
  otherDecimals: number;
  otherAddress: string; // alamat token non-base
  baseIsToken0: boolean;
  currentTick: number; // tick pool saat ini (utk hitung jarak range live)
  tickLower: number;
  tickUpper: number;
};

/** Hitung nilai pokok + fee belum diklaim sebuah posisi, dalam base-nya (auto-deteksi
 *  WETH/USDG dari token pool). Posisi lama (token pasangan = WETH) → base = WETH. */
export async function getPositionDetail(
  tokenId: string,
  ctx: ChainCtx = getChain(),
): Promise<PositionDetail> {
  const { positionManager, wallet } = ctx;
  const p = await positionManager.positions(tokenId);
  const fee = Number(p.fee);
  const base = detectBase(ctx, p.token0, p.token1) ?? baseOf(ctx, 'weth');
  const baseIsToken0 = p.token0.toLowerCase() === base.address.toLowerCase();
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

  const tokenOther = baseIsToken0 ? sdkToken1 : sdkToken0;
  const priceOther = sdkPool.priceOf(tokenOther);

  // Nilai pokok dalam base.
  const amt0 = position.amount0;
  const amt1 = position.amount1;
  const baseAmt = baseIsToken0 ? amt0 : amt1;
  const otherAmt = baseIsToken0 ? amt1 : amt0;
  const baseAmountWei = BigInt(baseAmt.quotient.toString());
  const otherAmountWei = BigInt(otherAmt.quotient.toString());
  const valueBaseWei = baseAmountWei + BigInt(priceOther.quote(otherAmt).quotient.toString());

  // Fee belum diklaim: collect.staticCall memicu update fee lalu mengembalikan jumlahnya.
  let feesBaseWei = 0n;
  try {
    const owed = await positionManager.collect.staticCall({
      tokenId,
      recipient: wallet.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    const owedBase = baseIsToken0 ? BigInt(owed[0]) : BigInt(owed[1]);
    const owedOther = baseIsToken0 ? BigInt(owed[1]) : BigInt(owed[0]);
    feesBaseWei = owedBase;
    if (owedOther > 0n) {
      const oa = CurrencyAmount.fromRawAmount(tokenOther, owedOther.toString());
      feesBaseWei += BigInt(priceOther.quote(oa).quotient.toString());
    }
  } catch {
    /* biarkan fee 0 kalau simulasi gagal */
  }

  // Arah dalam istilah HARGA TOKEN: tergantung sisi base di pool.
  const inR = currentTick >= tickLower && currentTick < tickUpper;
  let side: 'above' | 'in' | 'below' = 'in';
  if (!inR) {
    if (baseIsToken0) side = currentTick < tickLower ? 'above' : 'below';
    else side = currentTick >= tickUpper ? 'above' : 'below';
  }

  return {
    tokenId,
    fee,
    otherSymbol: tokenOther.symbol!,
    inRange: inR,
    side,
    liquidity,
    baseKind: base.kind,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    currentPrice: priceOther.toSignificant(8),
    // Batas rentang dalam harga token (kartu /positions menampilkan target range).
    priceLower: tickToPrice(tokenOther, baseIsToken0 ? sdkToken0 : sdkToken1, tickLower).toSignificant(6),
    priceUpper: tickToPrice(tokenOther, baseIsToken0 ? sdkToken0 : sdkToken1, tickUpper).toSignificant(6),
    valueBaseWei,
    feesBaseWei,
    baseAmountWei,
    otherAmountWei,
    otherDecimals: tokenOther.decimals,
    otherAddress: baseIsToken0 ? p.token1 : p.token0,
    baseIsToken0,
    currentTick,
    tickLower,
    tickUpper,
  };
}
