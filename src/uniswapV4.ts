import { ethers } from 'ethers';
import v3sdk from '@uniswap/v3-sdk';
import type { ChainCtx } from './chains.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust } from './relay.js';

const { TickMath, nearestUsableTick } = v3sdk;
const Q96 = 2n ** 96n;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// PoolManager singleton v4 per chain.
const V4_POOL_MANAGER: Record<string, string> = {
  robinhood: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
};
// v4 Actions tambahan (add).
const MINT_POSITION = 0x02;
const SETTLE_PAIR = 0x0d;
const SWEEP = 0x14;

/**
 * Baca-saja posisi Uniswap **v4** (arsitektur beda dari v3: PoolManager singleton
 * + PositionManager NFT). PHILIPS mengelola v3; modul ini hanya MENAMPILKAN posisi
 * v4 yang dipegang wallet (mis. dibuka via UI/CLI) agar /positions cermin on-chain.
 * Enumerasi tokenId lewat Blockscout (v4 PM bukan ERC721Enumerable → tak ada
 * tokenOfOwnerByIndex); detail dibaca via RPC.
 */

// PositionManager Uniswap v4 per chain. Kosong = v4 tak didukung di chain itu.
const V4_PM: Record<string, string> = {
  robinhood: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
};

const DYNAMIC_FEE_FLAG = 0x800000; // v4: fee bertanda dynamic

const V4_ABI = [
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
];
const ERC20_SYM = ['function symbol() view returns (string)'];

export type V4Position = {
  tokenId: string;
  sym0: string;
  sym1: string;
  fee: number; // raw; 0x800000 = dynamic
  dynamicFee: boolean;
  hasHooks: boolean;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  base: 'ETH' | 'USDG' | null; // aset dasar pasangan (utk add/cash-out)
  poolKey: PoolKeyV4;
  valueBaseWei: bigint | null; // nilai posisi dlm base (null bila gagal baca harga)
  rangePctHigh: number | null; // % ujung terdekat dari harga sekarang
  rangePctLow: number | null;
  inRange: boolean | null;
};

/** Tentukan aset dasar pasangan + apakah base = currency0. */
function pairBase(cc: ChainCtx, cur0: string, cur1: string): { base: 'ETH' | 'USDG' | null; baseIsCurrency0: boolean } {
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
  if (isEth(cur0)) return { base: 'ETH', baseIsCurrency0: true };
  if (isEth(cur1)) return { base: 'ETH', baseIsCurrency0: false };
  if (isUsdg(cur0)) return { base: 'USDG', baseIsCurrency0: true };
  if (isUsdg(cur1)) return { base: 'USDG', baseIsCurrency0: false };
  return { base: null, baseIsCurrency0: true };
}

export function v4Supported(cc: ChainCtx): boolean {
  return !!V4_PM[cc.key] && !!cc.blockscout;
}

async function tokenSymbol(addr: string, cc: ChainCtx): Promise<string> {
  if (!addr || addr === ethers.ZeroAddress) return 'ETH'; // native currency0
  try {
    return await new ethers.Contract(addr, ERC20_SYM, cc.provider).symbol();
  } catch {
    return addr.slice(0, 6);
  }
}

/** tokenId NFT v4 yang dipegang wallet (via Blockscout). */
async function walletV4TokenIds(cc: ChainCtx): Promise<string[]> {
  const pm = V4_PM[cc.key];
  if (!pm || !cc.blockscout) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${cc.blockscout}/addresses/${cc.wallet.address}/nft?type=ERC-721`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) return [];
    const j: any = await res.json();
    return (j.items || [])
      .filter((x: any) => ((x.token?.address_hash || x.token?.address || '').toLowerCase() === pm.toLowerCase()))
      .map((x: any) => String(x.id));
  } catch {
    return [];
  }
}

const signExt24 = (v: bigint): number => Number(v >= 1n << 23n ? v - (1n << 24n) : v);

// v4 Actions (v4-periphery libraries/Actions.sol)
const BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;
const V4_WRITE_ABI = [
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
  'function ownerOf(uint256) view returns (address)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
];

/**
 * Tutup (burn) posisi v4: tarik SELURUH likuiditas + fee, terima kedua token ke
 * wallet, burn NFT — dalam satu modifyLiquidities (BURN_POSITION + TAKE_PAIR).
 * WAJIB simulasi (staticCall) dulu; revert → batal (tak kirim). Tidak meng-swap
 * (v4 close mengembalikan kedua token apa adanya). dryRun → hanya simulasi.
 */
export async function closePositionV4(
  tokenId: string,
  cc: ChainCtx,
  opts: { dryRun: boolean },
): Promise<{
  dryRun?: boolean;
  txHash?: string;
  sym0: string;
  sym1: string;
  base: 'ETH' | 'USDG' | null;
  other?: string; // token non-base → jurnal & kandidat sweep
  cashedOut?: string;
  leftover?: string;
}> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 tak didukung di ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);
  const owner: string = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() !== cc.wallet.address.toLowerCase()) {
    throw new Error(`Posisi v4 #${tokenId} bukan milik wallet ini.`);
  }
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.concat([Uint8Array.of(BURN_POSITION), Uint8Array.of(TAKE_PAIR)]);
  // amount0Min/amount1Min = 0: burn = tarik dana sendiri (bukan swap) → risiko MEV rendah.
  const pBurn = coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [tokenId, 0, 0, '0x']);
  const pTake = coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, cc.wallet.address]);
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, [pBurn, pTake]]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);

  // Tentukan aset dasar (cash-out): pair ber-ETH → ETH; ber-USDG → USDG; lainnya → tak ada.
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
  let base: 'ETH' | 'USDG' | null = null;
  let other: string | null = null;
  if (isEth(pk.currency0) || isEth(pk.currency1)) {
    base = 'ETH';
    other = isEth(pk.currency0) ? pk.currency1 : pk.currency0;
  } else if (isUsdg(pk.currency0) || isUsdg(pk.currency1)) {
    base = 'USDG';
    other = isUsdg(pk.currency0) ? pk.currency1 : pk.currency0;
  }

  // Simulasi WAJIB (burn+take) — revert di sini = batalkan sebelum kirim tx.
  await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address });
  if (opts.dryRun) return { dryRun: true, sym0, sym1, base, other: other ?? undefined };

  const tx = await pm.modifyLiquidities(unlockData, deadline);
  const rc = await tx.wait();
  const out: {
    txHash: string;
    sym0: string;
    sym1: string;
    base: 'ETH' | 'USDG' | null;
    other?: string; // alamat token non-base → dipakai jurnal & kandidat sweep
    cashedOut?: string;
    leftover?: string;
  } = {
    txHash: rc?.hash ?? tx.hash,
    sym0,
    sym1,
    base,
    other: other ?? undefined,
  };

  // Cash-out: swap token "receh" → base (best-effort; gagal → biarkan sbg leftover, tak hilang).
  if (base && other && other !== ethers.ZeroAddress) {
    try {
      const erc = new ethers.Contract(other, ['function balanceOf(address) view returns (uint256)'], cc.provider);
      const bal: bigint = await erc.balanceOf(cc.wallet.address);
      if (bal > 0n) {
        const r = base === 'ETH'
          ? await swapTokenToEthRobust(other, bal, cc)
          : await swapTokenToUsdgRobust(other, bal, cc.usdgAddress!, cc);
        out.cashedOut = `${base} via ${r.route}`;
      }
    } catch (e) {
      out.leftover = (e as Error).message.slice(0, 100); // token receh tetap di wallet (aman)
    }
  }

  // Base ETH: jalur fallback Uniswap menghasilkan WETH (wrapped) → unwrap ke ETH
  // native supaya benar-benar "semua ke ETH" (samakan dgn v3 stopAndCashOut).
  if (base === 'ETH') {
    try {
      const wbal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (wbal > 0n) {
        await (await cc.weth.withdraw(wbal)).wait();
        out.cashedOut = out.cashedOut ? `${out.cashedOut} + unwrap WETH` : 'ETH (unwrap WETH)';
      }
    } catch {
      /* WETH tetap di wallet — tak fatal, bisa unwrap manual */
    }
  }
  return out;
}

/** Daftar posisi v4 wallet. onlyLive=true → hanya yang liquidity > 0. */
export async function listPositionsV4(cc: ChainCtx, { onlyLive = true }: { onlyLive?: boolean } = {}): Promise<V4Position[]> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) return [];
  const ids = await walletV4TokenIds(cc);
  if (ids.length === 0) return [];
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  const rows = await Promise.all(
    ids.map(async (id): Promise<V4Position | null> => {
      try {
        const [pk, info] = await pm.getPoolAndPositionInfo(id);
        const liquidity: bigint = await pm.getPositionLiquidity(id);
        if (onlyLive && liquidity === 0n) return null;
        const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);
        const fee = Number(pk.fee);
        const tickLower = signExt24((info >> 8n) & 0xffffffn);
        const tickUpper = signExt24((info >> 32n) & 0xffffffn);
        const poolKey: PoolKeyV4 = {
          currency0: pk.currency0,
          currency1: pk.currency1,
          fee,
          tickSpacing: Number(pk.tickSpacing),
          hooks: pk.hooks,
        };
        // Valuasi (nilai + range %); gagal baca harga → null (kartu tetap tampil).
        let val: Awaited<ReturnType<typeof valuePositionV4>> | null = null;
        try {
          val = await valuePositionV4(cc, poolKey, tickLower, tickUpper, liquidity);
        } catch {
          /* biarkan null */
        }
        return {
          tokenId: id,
          sym0,
          sym1,
          fee,
          dynamicFee: fee === DYNAMIC_FEE_FLAG,
          hasHooks: pk.hooks !== ethers.ZeroAddress,
          tickLower,
          tickUpper,
          liquidity,
          poolKey,
          valueBaseWei: val ? val.valueBaseWei : null,
          rangePctHigh: val ? val.rangePctHigh : null,
          rangePctLow: val ? val.rangePctLow : null,
          inRange: val ? val.inRange : null,
          base: pairBase(cc, pk.currency0, pk.currency1).base,
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((r): r is V4Position => r !== null);
}

// ── Add (mint) posisi v4 single-sided ──────────────────────────────────────
const sqrtAtTick = (tick: number): bigint => BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
function liqForAmount0(a: bigint, b: bigint, amt0: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (amt0 * ((a * b) / Q96)) / (b - a);
}
function liqForAmount1(a: bigint, b: bigint, amt1: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (amt1 * Q96) / (b - a);
}

export type PoolKeyV4 = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };

/**
 * PoolKey gateway sering meleset: currency belum terurut, dan pool ETH-native
 * dilaporkan memakai alamat WETH. poolId keccak → salah → modifyLiquidities
 * revert PoolNotInitialized di langkah terakhir (dead-end 4 tap). Coba varian
 * yang masuk akal, kembalikan yang slot0-nya HIDUP; null = pool tak ada.
 */
export async function resolvePoolKeyV4(
  cc: ChainCtx,
  pk: PoolKeyV4,
  baseIsCurrency0: boolean,
): Promise<{ poolKey: PoolKeyV4; baseIsCurrency0: boolean } | null> {
  if (!V4_POOL_MANAGER[cc.key]) return null;
  const baseAddr = baseIsCurrency0 ? pk.currency0 : pk.currency1;
  const otherAddr = baseIsCurrency0 ? pk.currency1 : pk.currency0;
  const isWeth = baseAddr.toLowerCase() === cc.wethAddress.toLowerCase();
  const bases = isWeth ? [baseAddr, ethers.ZeroAddress] : [baseAddr];
  for (const b of bases) {
    const [c0, c1] = b.toLowerCase() < otherAddr.toLowerCase() ? [b, otherAddr] : [otherAddr, b];
    const cand: PoolKeyV4 = { ...pk, currency0: c0, currency1: c1 };
    const { sqrtPriceX96 } = await readPoolState(cc, cand).catch(() => ({ sqrtPriceX96: 0n }));
    if (sqrtPriceX96 > 0n) return { poolKey: cand, baseIsCurrency0: c0 === b };
  }
  return null;
}

async function ensurePermit2(cc: ChainCtx, token: string, spender: string, amount: bigint): Promise<void> {
  const erc = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], cc.wallet);
  if ((await erc.allowance(cc.wallet.address, PERMIT2)) < amount) {
    await (await erc.approve(PERMIT2, ethers.MaxUint256)).wait();
  }
  const p2 = new ethers.Contract(PERMIT2, ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)'], cc.wallet);
  const [amt] = await p2.allowance(cc.wallet.address, token, spender);
  if (BigInt(amt) < amount) {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await (await p2.approve(token, spender, (1n << 160n) - 1n, exp)).wait();
  }
}

/**
 * Buka posisi v4 single-sided: deposit HANYA base ke range di satu sisi harga
 * (base=currency0 → range di atas; base=currency1 → range di bawah), sehingga
 * cuma base yang ditarik. Simulasi WAJIB sebelum kirim. ERC20 base → Permit2.
 */
export async function openPositionV4(
  cc: ChainCtx,
  poolKey: PoolKeyV4,
  baseIsCurrency0: boolean,
  baseAmountWei: bigint,
  opts: { widthSpacings?: number; gapSpacings?: number; dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; tokenId?: string; tickLower: number; tickUpper: number; liquidity: bigint; baseIsCurrency0: boolean }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || !V4_POOL_MANAGER[cc.key]) throw new Error(`Uniswap v4 tak didukung di ${cc.label}.`);
  const spacing = poolKey.tickSpacing;
  const width = (opts.widthSpacings ?? 50) * spacing;
  // gap default 0 → tepi-dekat MENEMPEL harga sekarang supaya posisi mulai terisi
  // sejak pergerakan pertama ke arah kita (bukan menunggu turun berspasi dulu).
  const gap = (opts.gapSpacings ?? 0) * spacing;
  const state = await readPoolState(cc, poolKey);
  // slot0 kosong = poolKey tak cocok pool mana pun. Tanpa cek ini, revert-nya baru
  // muncul sebagai 'unknown custom error' (PoolNotInitialized) di preview rencana.
  if (state.sqrtPriceX96 === 0n) throw new Error('Pool v4 tak terinisialisasi (poolKey tak cocok) — pilih pool lain.');
  const current = state.tick;
  const aligned = nearestUsableTick(current, spacing);
  let tickLower: number;
  let tickUpper: number;
  if (baseIsCurrency0) {
    // Deposit currency0 → range di ATAS harga. Tick naik = harga token turun → terisi.
    // Tepi-dekat = tick usable TERKECIL yang strictly > current (nempel), lalu +gap opsional.
    tickLower = (aligned > current ? aligned : aligned + spacing) + gap;
    tickUpper = tickLower + width;
  } else {
    // Deposit currency1 → range di BAWAH harga. Tick turun = harga token turun → terisi.
    // Tepi-dekat = tick usable TERBESAR yang strictly < current (nempel), lalu -gap opsional.
    tickUpper = (aligned < current ? aligned : aligned - spacing) - gap;
    tickLower = tickUpper - width;
  }
  const sqrtL = sqrtAtTick(tickLower);
  const sqrtU = sqrtAtTick(tickUpper);
  const liquidity = baseIsCurrency0 ? liqForAmount0(sqrtL, sqrtU, baseAmountWei) : liqForAmount1(sqrtL, sqrtU, baseAmountWei);
  if (liquidity <= 0n) throw new Error('Likuiditas terhitung 0 — nominal terlalu kecil.');

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const amount0Max = baseIsCurrency0 ? baseAmountWei : 0n;
  const amount1Max = baseIsCurrency0 ? 0n : baseAmountWei;
  const baseCurrency = baseIsCurrency0 ? poolKey.currency0 : poolKey.currency1;
  const isNative = baseCurrency === ethers.ZeroAddress;

  const mintParam = coder.encode(
    ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], tickLower, tickUpper, liquidity, amount0Max, amount1Max, cc.wallet.address, '0x'],
  );
  const settleParam = coder.encode(['address', 'address'], [poolKey.currency0, poolKey.currency1]);
  let actions: string;
  let params: string[];
  if (isNative) {
    actions = ethers.hexlify(new Uint8Array([MINT_POSITION, SETTLE_PAIR, SWEEP]));
    params = [mintParam, settleParam, coder.encode(['address', 'address'], [ethers.ZeroAddress, cc.wallet.address])];
  } else {
    actions = ethers.hexlify(new Uint8Array([MINT_POSITION, SETTLE_PAIR]));
    params = [mintParam, settleParam];
  }
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const value = isNative ? baseAmountWei : 0n;
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);

  if (!isNative && !opts.dryRun) await ensurePermit2(cc, baseCurrency, pmAddr, baseAmountWei);

  // staticCall memvalidasi mint sebelum kirim. Utk base non-native saat DRY-RUN,
  // Permit2 belum diset → staticCall pasti revert; lewati (validasi tetap jalan di
  // jalur live: ensurePermit2 dulu, lalu staticCall di bawah, baru tx).
  if (isNative || !opts.dryRun) {
    await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address, value });
  }
  if (opts.dryRun) return { dryRun: true, tickLower, tickUpper, liquidity, baseIsCurrency0 };
  const tx = await pm.modifyLiquidities(unlockData, deadline, { value });
  const rc = await tx.wait();
  // tokenId NFT baru = event Transfer(from=0x0, to=wallet) dari PositionManager.
  let tokenId: string | undefined;
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const toPadded = ethers.zeroPadValue(cc.wallet.address, 32).toLowerCase();
  for (const log of rc?.logs ?? []) {
    if (
      log.address.toLowerCase() === pmAddr.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[1] === ethers.ZeroHash &&
      (log.topics[2] ?? '').toLowerCase() === toPadded
    ) {
      tokenId = BigInt(log.topics[3]).toString();
      break;
    }
  }
  return { txHash: rc?.hash ?? tx.hash, tokenId, tickLower, tickUpper, liquidity, baseIsCurrency0 };
}

/** PoolKey + info base sebuah posisi v4 (untuk add ke pool yg sama). */
export async function getPoolKeyV4(cc: ChainCtx, tokenId: string): Promise<{ poolKey: PoolKeyV4; baseIsCurrency0: boolean; base: 'ETH' | 'USDG' | null }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 tak didukung di ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const poolKey: PoolKeyV4 = { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks };
  const { base, baseIsCurrency0 } = pairBase(cc, pk.currency0, pk.currency1);
  return { poolKey, baseIsCurrency0, base };
}

// ── Valuasi posisi v4 (nilai dalam base + range %) ──────────────────────────
/** Baca slot0 pool v4: tick + sqrtPriceX96 sekarang. */
async function readPoolState(cc: ChainCtx, pk: PoolKeyV4): Promise<{ tick: number; sqrtPriceX96: bigint }> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
  const slot = ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)]));
  const raw = BigInt(await mgr.extsload(slot));
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  let tick = Number((raw >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;
  return { tick, sqrtPriceX96 };
}

function amount0Delta(a: bigint, b: bigint, L: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  if (a === 0n) return 0n;
  return (L * Q96 * (b - a)) / b / a;
}
function amount1Delta(a: bigint, b: bigint, L: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (L * (b - a)) / Q96;
}
function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, L: bigint): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return { amount0: amount0Delta(sqrtA, sqrtB, L), amount1: 0n };
  if (sqrtP < sqrtB) return { amount0: amount0Delta(sqrtP, sqrtB, L), amount1: amount1Delta(sqrtA, sqrtP, L) };
  return { amount0: 0n, amount1: amount1Delta(sqrtA, sqrtB, L) };
}

export type V4Valuation = {
  amount0: bigint;
  amount1: bigint;
  base: 'ETH' | 'USDG' | null;
  baseIsCurrency0: boolean;
  valueBaseWei: bigint; // nilai posisi dalam unit base (raw, desimal base)
  rangePctHigh: number; // % ujung terdekat dari harga sekarang
  rangePctLow: number;
  inRange: boolean;
  currentTick: number;
};

/** Nilai posisi v4 (token amounts, nilai dalam base, range %). */
export async function valuePositionV4(cc: ChainCtx, pk: PoolKeyV4, tickLower: number, tickUpper: number, liquidity: bigint): Promise<V4Valuation> {
  const { tick, sqrtPriceX96 } = await readPoolState(cc, pk);
  const sqrtL = sqrtAtTick(tickLower);
  const sqrtU = sqrtAtTick(tickUpper);
  const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, sqrtL, sqrtU, liquidity);
  const { base, baseIsCurrency0 } = pairBase(cc, pk.currency0, pk.currency1);
  // sqrtPriceX96 = sqrt(token1/token0)*Q96 (rasio raw). Nilai dlm base:
  const p2 = sqrtPriceX96 * sqrtPriceX96; // (token1/token0)*Q96^2
  let valueBaseWei = 0n;
  if (baseIsCurrency0) {
    valueBaseWei = amount0 + (p2 === 0n ? 0n : (amount1 * Q96 * Q96) / p2);
  } else {
    valueBaseWei = amount1 + (amount0 * p2) / (Q96 * Q96);
  }
  const sgn = baseIsCurrency0 ? -1 : 1;
  const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - tick)) - 1) * 100;
  const pcts = [pctOf(tickUpper), pctOf(tickLower)].sort((a, b) => b - a);
  return {
    amount0,
    amount1,
    base,
    baseIsCurrency0,
    valueBaseWei,
    rangePctHigh: pcts[0],
    rangePctLow: pcts[1],
    inRange: tick >= tickLower && tick < tickUpper,
    currentTick: tick,
  };
}

/** Status ringkas posisi v4 untuk monitor: masih ada? dalam range? */
export async function checkV4Status(
  cc: ChainCtx,
  tokenId: string,
): Promise<{ exists: boolean; inRange: boolean | null }> {
  // inRange null = TAK TAHU (RPC gagal / chain tanpa PM). Jangan dipetakan ke false:
  // itu memicu alert "OUT OF RANGE" palsu yang mendorong keputusan uang.
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) return { exists: true, inRange: null };
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  try {
    const [pk, info] = await pm.getPoolAndPositionInfo(tokenId);
    const liquidity: bigint = await pm.getPositionLiquidity(tokenId);
    if (liquidity === 0n || (pk.currency0 === ethers.ZeroAddress && pk.currency1 === ethers.ZeroAddress)) {
      return { exists: false, inRange: false };
    }
    const tickLower = signExt24((info >> 8n) & 0xffffffn);
    const tickUpper = signExt24((info >> 32n) & 0xffffffn);
    const poolKey: PoolKeyV4 = { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks };
    const { tick } = await readPoolState(cc, poolKey);
    return { exists: true, inRange: tick >= tickLower && tick < tickUpper };
  } catch {
    return { exists: true, inRange: null }; // error transien → jangan hapus & jangan alert
  }
}
