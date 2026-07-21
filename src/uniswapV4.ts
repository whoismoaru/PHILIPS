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
};

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
): Promise<{ dryRun?: boolean; txHash?: string; sym0: string; sym1: string; base: 'ETH' | 'USDG' | null; cashedOut?: string; leftover?: string }> {
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
  if (opts.dryRun) return { dryRun: true, sym0, sym1, base };

  const tx = await pm.modifyLiquidities(unlockData, deadline);
  const rc = await tx.wait();
  const out: { txHash: string; sym0: string; sym1: string; base: 'ETH' | 'USDG' | null; cashedOut?: string; leftover?: string } = {
    txHash: rc?.hash ?? tx.hash,
    sym0,
    sym1,
    base,
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
        return {
          tokenId: id,
          sym0,
          sym1,
          fee,
          dynamicFee: fee === DYNAMIC_FEE_FLAG,
          hasHooks: pk.hooks !== ethers.ZeroAddress,
          tickLower: signExt24((info >> 8n) & 0xffffffn),
          tickUpper: signExt24((info >> 32n) & 0xffffffn),
          liquidity,
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

/** Tick harga sekarang pool v4 (via PoolManager.extsload slot0, POOLS_SLOT=6). */
async function readPoolTick(cc: ChainCtx, pk: PoolKeyV4): Promise<number> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
  const slot = ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)]));
  const raw = BigInt(await mgr.extsload(slot));
  let tick = Number((raw >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;
  return tick;
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
): Promise<{ dryRun?: boolean; txHash?: string; tickLower: number; tickUpper: number; liquidity: bigint }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || !V4_POOL_MANAGER[cc.key]) throw new Error(`Uniswap v4 tak didukung di ${cc.label}.`);
  const spacing = poolKey.tickSpacing;
  const width = (opts.widthSpacings ?? 50) * spacing;
  const gap = (opts.gapSpacings ?? 1) * spacing;
  const current = await readPoolTick(cc, poolKey);
  const aligned = nearestUsableTick(current, spacing);
  let tickLower: number;
  let tickUpper: number;
  if (baseIsCurrency0) {
    tickLower = aligned + gap;
    if (tickLower <= current) tickLower += spacing;
    tickUpper = tickLower + width;
  } else {
    tickUpper = aligned - gap;
    if (tickUpper >= current) tickUpper -= spacing;
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

  await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address, value });
  if (opts.dryRun) return { dryRun: true, tickLower, tickUpper, liquidity };
  const tx = await pm.modifyLiquidities(unlockData, deadline, { value });
  const rc = await tx.wait();
  return { txHash: rc?.hash ?? tx.hash, tickLower, tickUpper, liquidity };
}
