import { ethers } from 'ethers';
import { TickMath, nearestUsableTick } from '@uniswap/v3-sdk';
import { isStableBase, type ChainCtx } from './chains.js';
import { EXPLORER_HEADERS } from './chain.js';
import { swapTokenToEthRobust, swapTokenToUsdgRobust } from './relay.js';
import { sendTxNonceSafe, mapLimit } from './core.js';
import { allV4 } from './v4store.js';

const Q96 = 2n ** 96n;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// PoolManager singleton v4 per chain.
const V4_POOL_MANAGER: Record<string, string> = {
  robinhood: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  bsc: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF',
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
  bsc: '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b',
};

/**
 * Alamat kontrak dinormalkan SAAT MODUL DIMUAT.
 *
 * ethers menolak alamat yang checksum-nya salah, dan pembacaan pool dibungkus
 * `.catch(() => 0n)` — jadi satu huruf besar/kecil yang keliru tidak memunculkan
 * error, melainkan "likuiditas 0" yang membuat SETIAP pool di chain itu terbuang
 * diam-diam. Menormalkan di sini membuat salah ketik gagal keras saat start,
 * bukan menyamar sebagai pool mati.
 */
for (const table of [V4_PM, V4_POOL_MANAGER]) {
  for (const [k, v] of Object.entries(table)) table[k] = ethers.getAddress(v.toLowerCase());
}

/**
 * Base stablecoin chain ini. Modul ini dulu mematok USDG (satu-satunya chain v4
 * saat itu), jadi menyalakan v4 di BSC membuat pool USDT tak dikenali sebagai
 * pasangan yang bisa dibuka satu sisi. Diambil dari daftar base chain-nya sendiri.
 */
function stableOf(cc: ChainCtx): { addr: string; symbol: string; decimals: number } | null {
  const b = cc.bases.find((x) => isStableBase(x.kind));
  return b ? { addr: b.address, symbol: b.symbol, decimals: b.decimals } : null;
}
/** Simbol base yang BENAR untuk chain ini — dipakai kartu & label. */
export function v4BaseSymbol(cc: ChainCtx, base: 'ETH' | 'USDG' | null): string {
  if (base === 'ETH') return cc.nativeSymbol;
  return base === 'USDG' ? (stableOf(cc)?.symbol ?? 'USD') : '';
}
/** Desimal base v4 di chain ini (stable BSC 18, Robinhood 6 — jangan dipatok). */
export function v4BaseDecimals(cc: ChainCtx, base: 'ETH' | 'USDG' | null): number {
  return base === 'USDG' ? (stableOf(cc)?.decimals ?? 6) : 18;
}

const DYNAMIC_FEE_FLAG = 0x800000; // v4: fee bertanda dynamic

/**
 * Probe untuk retry otomatis: apakah sebuah operasi SUDAH mendarat di chain?
 * -1n = tak bisa dipastikan (v4 tak didukung / RPC gagal) → pemanggil WAJIB
 * memperlakukannya sebagai "mungkin sudah mendarat" dan tidak mengulang.
 */
export async function v4PositionCount(cc: ChainCtx): Promise<bigint> {
  const addr = V4_PM[cc.key];
  if (!addr) return -1n;
  const c = new ethers.Contract(addr, ['function balanceOf(address) view returns (uint256)'], cc.provider);
  return (await c.balanceOf(cc.wallet.address)) as bigint;
}

/** Likuiditas posisi v4. Berubah = decreaseLiquidity sudah mendarat. */
export async function v4Liquidity(cc: ChainCtx, tokenId: string): Promise<bigint> {
  const addr = V4_PM[cc.key];
  if (!addr) return -1n;
  const c = new ethers.Contract(addr, V4_ABI, cc.provider);
  return BigInt(await c.getPositionLiquidity(tokenId));
}

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
  valueBaseWei: bigint | null; // PRINSIPAL dlm base (null bila gagal baca harga)
  feesBaseWei: bigint | null; // fee belum diklaim, dlm base
  rangePctHigh: number | null; // % ujung terdekat dari harga sekarang
  rangePctLow: number | null;
  inRange: boolean | null;
  currentTick: number | null; // tick pool saat ini — kartu memakainya utk mcap "now"
  converted: boolean; // out-of-range & 100% token seberang (target tercapai)
  impliedTokenEthPrice: number | null; // harga token dlm ETH menurut slot0 pool INI (buat cek pool sekarat)
  // Jumlah token SEBERANG yang dipegang posisi ini. `valueBaseWei` menilainya pada
  // harga pool sekarang (mark-to-market) — dan itu BUKAN yang akan kamu terima:
  // menjualnya menggerakkan harga. Kartu memakai angka ini untuk meminta quote
  // nyata sebelum menyebutnya "nilai".
  otherAmountWei: bigint | null;
  otherAddress: string | null;
  otherDecimals: number | null;
  baseAmountWei: bigint | null; // sisi base yang dipegang — ini tak perlu dijual
};

/** Tentukan aset dasar pasangan + apakah base = currency0. */
function pairBase(cc: ChainCtx, cur0: string, cur1: string): { base: 'ETH' | 'USDG' | null; baseIsCurrency0: boolean } {
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const st = stableOf(cc);
  const isUsdg = (a: string) => !!st && a.toLowerCase() === st.addr.toLowerCase();
  if (isEth(cur0)) return { base: 'ETH', baseIsCurrency0: true };
  if (isEth(cur1)) return { base: 'ETH', baseIsCurrency0: false };
  if (isUsdg(cur0)) return { base: 'USDG', baseIsCurrency0: true };
  if (isUsdg(cur1)) return { base: 'USDG', baseIsCurrency0: false };
  return { base: null, baseIsCurrency0: true };
}

export function v4Supported(cc: ChainCtx): boolean {
  // Blockscout TAK lagi jadi syarat: enumerasi punya jalur tanpa indexer
  // (nextTokenId + ownerOf), dan posisi yang dibuka bot selalu tercatat lokal.
  // Tanpa indexer, yang hilang cuma posisi v4 yang dibuka DI LUAR bot — dan
  // /positions sudah menyebut daftarnya mungkin tak lengkap.
  return !!V4_PM[cc.key];
}

// Symbol & desimal token TAK PERNAH berubah → cache permanen. Tanpa ini, /positions
// dgn 69 leg satu pool memicu ~207 RPC berulang utk metadata yang sama → lambat.
const symCache = new Map<string, string>();
const decCache = new Map<string, number>();

async function tokenSymbol(addr: string, cc: ChainCtx): Promise<string> {
  if (!addr || addr === ethers.ZeroAddress) return 'ETH'; // native currency0
  const key = `${cc.key}:${addr.toLowerCase()}`;
  const hit = symCache.get(key);
  if (hit !== undefined) return hit;
  let v: string;
  try {
    v = await new ethers.Contract(addr, ERC20_SYM, cc.provider).symbol();
  } catch {
    v = addr.slice(0, 6);
  }
  symCache.set(key, v);
  return v;
}

async function tokenDecimals(addr: string, cc: ChainCtx): Promise<number> {
  if (!addr || addr === ethers.ZeroAddress) return 18; // native ETH
  const key = `${cc.key}:${addr.toLowerCase()}`;
  const hit = decCache.get(key);
  if (hit !== undefined) return hit;
  let v: number;
  try {
    v = Number(await new ethers.Contract(addr, ['function decimals() view returns (uint8)'], cc.provider).decimals());
  } catch {
    v = 18;
  }
  decCache.set(key, v);
  return v;
}

/** tokenId NFT v4 yang dipegang wallet (via Blockscout). */
/** true bila enumerasi indexer gagal di pemanggilan terakhir → daftar bisa tak lengkap. */
let enumDegraded = false;
export function v4ListDegraded(): boolean {
  return enumDegraded;
}

async function walletV4TokenIds(cc: ChainCtx): Promise<string[]> {
  const pm = V4_PM[cc.key];
  if (!pm) return [];
  // Posisi yang bot kelola SELALU disertakan: kalau Blockscout down/lag, posisi
  // v4-mu tak boleh lenyap dari /positions (dulu catch→[] bikin kedip "tak sinkron").
  const ids = new Set(allV4().filter((r) => r.chain === cc.key).map((r) => r.tokenId));
  if (!cc.blockscout) return [...ids];
  enumDegraded = false;
  // Dua percobaan: Blockscout Robinhood sering gagal SESAAT (abort 3 dtk, 500, 503)
  // lalu berhasil di detik berikutnya. Sekali gagal langsung dianggap rusak membuat
  // peringatan "indexer bermasalah" muncul hampir tiap /positions — dan peringatan
  // yang selalu menyala berhenti dibaca. Percobaan kedua diberi waktu lebih panjang.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Blockscout memberi ~50 item per halaman; wallet menimbun NFT v4 KOSONG tiap
      // tutup posisi, jadi tanpa paginasi posisi hidup bisa jatuh dari halaman 1.
      let url: string | null = `${cc.blockscout}/addresses/${cc.wallet.address}/nft?type=ERC-721`;
      for (let page = 0; url && page < 10; page++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), attempt === 0 ? 3000 : 8000);
        const res = await fetch(url, { headers: EXPLORER_HEADERS, signal: ctrl.signal }).finally(() =>
          clearTimeout(t),
        );
        if (!res.ok) throw new Error(`blockscout HTTP ${res.status}`);
        const j: any = await res.json();
        for (const x of j.items || []) {
          if ((x.token?.address_hash || x.token?.address || '').toLowerCase() === pm.toLowerCase()) ids.add(String(x.id));
        }
        const p = j.next_page_params;
        url = p ? `${cc.blockscout}/addresses/${cc.wallet.address}/nft?${new URLSearchParams(p as any)}` : null;
      }
      enumDegraded = false;
      break;
    } catch (e) {
      // Jangan diam-diam: kegagalan indexer yang "tertolong" v4store harus terlihat.
      // Jangan cuma di log server: user yang melihat /positions harus tahu daftarnya
      // mungkin tak lengkap — inilah yang dulu membuat posisi "hilang" tanpa sebab.
      enumDegraded = true;
      console.log(
        `[v4] enumerasi Blockscout gagal (percobaan ${attempt + 1}/2), pakai v4store saja:`,
        (e as Error).message.slice(0, 100),
      );
    }
  }
  return [...ids];
}

const signExt24 = (v: bigint): number => Number(v >= 1n << 23n ? v - (1n << 24n) : v);

// v4 Actions (v4-periphery libraries/Actions.sol)
const BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;
const V4_WRITE_ABI = [
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function ownerOf(uint256) view returns (address)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
];

/** Lantai slippage penarikan v4 — disamakan dengan v3 (WITHDRAW_SLIPPAGE_BPS). */
const BURN_SLIPPAGE_BPS = 50n; // 0.5%

/** Catatan yang ikut ke kartu close saat burn v4 terpaksa tanpa lantai harga. */
export const V4_UNPROTECTED_NOTE = (ids: string) =>
  `⚠️ #${ids} withdrawn WITHOUT a price floor — the pool could not be priced, so sandwich protection was off for this close.`;

/**
 * amount0Min/amount1Min untuk BURN_POSITION.
 *
 * Dulu keduanya 0 dengan alasan "burn = tarik dana sendiri, bukan swap". Alasan itu
 * TIDAK berlaku untuk likuiditas terkonsentrasi: harga bisa didorong ke tepi rentang,
 * posisi keluar ~100% sebagai aset yang sedang ditekan, lalu harga dikembalikan — dan
 * tx-nya tetap "sukses" sehingga tak ada yang menandai. v3 sudah dijaga sejak lama
 * (withdrawMins); ini menutup lubang yang sama di v4.
 *
 * Lantainya dihitung dari PRINSIPAL saja (harga pool sekarang, dikurangi 0.5%),
 * sedangkan cek slippage on-chain mengukur prinsipal + fee. Fee hanya menambah, jadi
 * lantai ini konservatif — tak akan menolak burn yang sehat.
 *
 * Tak bisa dihitung → {0,0} + tanda `unprotected` (dana user > risiko MEV), dan
 * tandanya DIBAWA KE ATAS supaya muncul di kartu, bukan cuma di log server.
 */
async function burnMinsV4(
  cc: ChainCtx,
  pm: ethers.Contract,
  tokenId: string,
  pk: PoolKeyV4,
): Promise<{ min0: bigint; min1: bigint; unprotected: boolean }> {
  try {
    const [, info] = await pm.getPoolAndPositionInfo(tokenId);
    const liquidity: bigint = await pm.getPositionLiquidity(tokenId);
    // Likuiditas 0 → tak ada prinsipal yang bisa dicuri lewat harga; bukan celah.
    if (liquidity === 0n) return { min0: 0n, min1: 0n, unprotected: false };
    const tickLower = signExt24((BigInt(info) >> 8n) & 0xffffffn);
    const tickUpper = signExt24((BigInt(info) >> 32n) & 0xffffffn);
    const { sqrtPriceX96 } = await readPoolState(cc, pk);
    const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, sqrtAtTick(tickLower), sqrtAtTick(tickUpper), liquidity);
    const floor = (v: bigint) => (v * (10000n - BURN_SLIPPAGE_BPS)) / 10000n;
    return { min0: floor(amount0), min1: floor(amount1), unprotected: false };
  } catch (e) {
    console.log(`[v4] ⚠️ lantai slippage TAK tersedia (#${tokenId}) — burn tanpa proteksi harga:`, (e as Error).message.slice(0, 80));
    return { min0: 0n, min1: 0n, unprotected: true };
  }
}

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
  unprotected?: boolean; // burn terpaksa tanpa lantai harga
}> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);
  const owner: string = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() !== cc.wallet.address.toLowerCase()) {
    throw new Error(`v4 position #${tokenId} is not owned by this wallet.`);
  }
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.concat([Uint8Array.of(BURN_POSITION), Uint8Array.of(TAKE_PAIR)]);
  const mins = await burnMinsV4(cc, pm, tokenId, pk);
  const pBurn = coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [tokenId, mins.min0, mins.min1, '0x']);
  const pTake = coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, cc.wallet.address]);
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, [pBurn, pTake]]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);

  // Tentukan aset dasar (cash-out): pair ber-ETH → ETH; ber-USDG → USDG; lainnya → tak ada.
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const st = stableOf(cc);
  const isUsdg = (a: string) => !!st && a.toLowerCase() === st.addr.toLowerCase();
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
  if (opts.dryRun) return { dryRun: true, sym0, sym1, base, other: other ?? undefined, unprotected: mins.unprotected };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline));
  const rc = await tx.wait();
  const out: {
    txHash: string;
    sym0: string;
    sym1: string;
    base: 'ETH' | 'USDG' | null;
    other?: string; // alamat token non-base → dipakai jurnal & kandidat sweep
    cashedOut?: string;
    leftover?: string;
    unprotected?: boolean;
  } = {
    txHash: rc?.hash ?? tx.hash,
    sym0,
    sym1,
    base,
    other: other ?? undefined,
    unprotected: mins.unprotected,
  };

  // Cash-out: swap token "receh" → base (best-effort; gagal → biarkan sbg leftover, tak hilang).
  if (base && other && other !== ethers.ZeroAddress) {
    try {
      const erc = new ethers.Contract(other, ['function balanceOf(address) view returns (uint256)'], cc.provider);
      const bal: bigint = await erc.balanceOf(cc.wallet.address);
      if (bal > 0n) {
        const r = base === 'ETH'
          ? await swapTokenToEthRobust(other, bal, cc)
          : await swapTokenToUsdgRobust(other, bal, stableOf(cc)!.addr, cc);
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

/**
 * BATCH close ladder v4: burn SEMUA leg + take (N×BURN_POSITION + 1×TAKE_PAIR)
 * dalam satu modifyLiquidities, lalu SATU swap token→base + unwrap. Mengembalikan
 * total baseOut terukur (delta saldo base) untuk dibagi ke tiap leg di pemanggil.
 */
export async function closeLadderV4(
  tokenIds: string[],
  cc: ChainCtx,
  opts: { dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; base: 'ETH' | 'USDG' | null; other?: string; sym0: string; sym1: string; baseOutWei: bigint; cashedOut?: string; unprotected?: string[]; gone?: string[] }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);
  const [pk] = await pm.getPoolAndPositionInfo(tokenIds[0]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [sym0, sym1] = await Promise.all([tokenSymbol(pk.currency0, cc), tokenSymbol(pk.currency1, cc)]);
  const isEth = (a: string) => a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase();
  const st = stableOf(cc);
  const isUsdg = (a: string) => !!st && a.toLowerCase() === st.addr.toLowerCase();
  let base: 'ETH' | 'USDG' | null = null;
  let other: string | null = null;
  if (isEth(pk.currency0) || isEth(pk.currency1)) { base = 'ETH'; other = isEth(pk.currency0) ? pk.currency1 : pk.currency0; }
  else if (isUsdg(pk.currency0) || isUsdg(pk.currency1)) { base = 'USDG'; other = isUsdg(pk.currency0) ? pk.currency1 : pk.currency0; }

  // Ukur saldo base SEBELUM (delta = hasil). ETH → native; USDG → token.
  const readBase = async (): Promise<bigint> =>
    base === 'USDG' && stableOf(cc)
      ? ((await new ethers.Contract(stableOf(cc)!.addr, ['function balanceOf(address) view returns (uint256)'], cc.provider).balanceOf(cc.wallet.address).catch(() => 0n)) as bigint)
      : ((await cc.provider.getBalance(cc.wallet.address).catch(() => 0n)) as bigint);
  const beforeWei = await readBase();

  // Leg yang SUDAH TAK ADA harus disaring dulu. BURN_POSITION pada id yang tak
  // pernah/tak lagi ter-mint me-revert 'NOT_MINTED', dan karena ini SATU multicall
  // seluruh batch ikut gagal — delapan leg tak bisa ditutup gara-gara satu id hantu.
  // Hanya revert kepemilikan yang dianggap "hilang"; gagal baca lain dilempar,
  // supaya RPC yang rewel tak pernah lagi terbaca sebagai "posisi tak ada".
  const alive: string[] = [];
  const gone: string[] = [];
  for (const id of tokenIds) {
    try {
      await pm.ownerOf(id);
      alive.push(id);
    } catch (e) {
      const m = (e as Error).message ?? '';
      if (/NOT_MINTED|invalid token id|nonexistent/i.test(m)) gone.push(id);
      else throw new Error(`Could not read v4 position #${id} (${m.slice(0, 80)}). Nothing was closed.`);
    }
  }
  if (alive.length === 0) {
    throw new Error(
      `None of these ${tokenIds.length} legs exist on-chain, so there was nothing to close. ` +
        'They no longer exist on-chain and have been dropped from tracking.',
    );
  }
  tokenIds = alive;

  const actionBytes = [...tokenIds.map(() => BURN_POSITION), TAKE_PAIR];
  // Tiap leg punya rentangnya sendiri → lantainya dihitung per leg, bukan sekali.
  const legMins = await Promise.all(tokenIds.map((id) => burnMinsV4(cc, pm, id, pk)));
  const unprotectedIds = tokenIds.filter((_, i) => legMins[i].unprotected);
  const params = [
    ...tokenIds.map((id, i) => coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [id, legMins[i].min0, legMins[i].min1, '0x'])),
    coder.encode(['address', 'address', 'address'], [pk.currency0, pk.currency1, cc.wallet.address]),
  ];
  const unlockData = coder.encode(['bytes', 'bytes[]'], [ethers.hexlify(new Uint8Array(actionBytes)), params]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address });
  if (opts.dryRun) return { dryRun: true, base, other: other ?? undefined, sym0, sym1, baseOutWei: 0n, unprotected: unprotectedIds, gone };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline));
  const rc = await tx.wait();
  let cashedOut: string | undefined;
  // Swap seluruh token hasil (agregat semua leg) → base sekali.
  if (base && other && other !== ethers.ZeroAddress) {
    try {
      const erc = new ethers.Contract(other, ['function balanceOf(address) view returns (uint256)'], cc.provider);
      const bal: bigint = await erc.balanceOf(cc.wallet.address);
      if (bal > 0n) {
        const r = base === 'ETH' ? await swapTokenToEthRobust(other, bal, cc) : await swapTokenToUsdgRobust(other, bal, stableOf(cc)!.addr, cc);
        cashedOut = `${base} via ${r.route}`;
      }
    } catch { /* token receh tetap di wallet */ }
  }
  if (base === 'ETH') {
    try {
      const wbal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (wbal > 0n) await (await cc.weth.withdraw(wbal)).wait();
    } catch { /* biarkan WETH */ }
  }
  const afterWei = await readBase();
  const baseOutWei = afterWei > beforeWei ? afterWei - beforeWei : 0n;
  return { txHash: rc?.hash ?? tx.hash, base, other: other ?? undefined, sym0, sym1, baseOutWei, cashedOut, unprotected: unprotectedIds, gone };
}

// Cache hasil list v4 per chain (TTL pendek): banyak command (/status, /positions,
// dll) memanggilnya beruntun; tanpa cache tiap kali fetch ULANG semua leg → lambat.
const listCache = new Map<string, { t: number; v: V4Position[] }>();
const LIST_TTL_MS = 45_000;

/** Daftar posisi v4 wallet. onlyLive=true → hanya yang liquidity > 0. */
export async function listPositionsV4(cc: ChainCtx, { onlyLive = true }: { onlyLive?: boolean } = {}): Promise<V4Position[]> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) return [];
  const ck = `${cc.key}:${onlyLive}`;
  const hit = listCache.get(ck);
  if (hit && Date.now() - hit.t < LIST_TTL_MS) return hit.v;
  const ids = await walletV4TokenIds(cc);
  if (ids.length === 0) return [];
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  // Konkurensi DIBATASI: 69 leg × ~5 RPC via Promise.all = ~300 RPC serentak →
  // Alchemy throttle → lambat/error. mapLimit menahan di ~8 serentak.
  const rows = await mapLimit(ids, 8,
    async (id): Promise<V4Position | null> => {
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
          val = await valuePositionV4(cc, poolKey, tickLower, tickUpper, liquidity, id);
        } catch {
          /* biarkan null */
        }
        // Harga token dlm ETH menurut slot0 pool INI (untuk deteksi pool sekarat:
        // dibandingkan harga pasar DexScreener di kartu). Hanya untuk pasangan ETH.
        let impliedTokenEthPrice: number | null = null;
        const pb = pairBase(cc, pk.currency0, pk.currency1);
        if (val && pb.base === 'ETH') {
          try {
            const tokenAddr = pb.baseIsCurrency0 ? pk.currency1 : pk.currency0;
            const tokDec = await tokenDecimals(tokenAddr, cc);
            const P = Math.pow(1.0001, val.currentTick); // currency1_raw / currency0_raw
            const factor = pb.baseIsCurrency0 ? 1 / P : P; // ETH_raw per token_raw
            const px = factor * Math.pow(10, tokDec - 18);
            if (isFinite(px) && px > 0) impliedTokenEthPrice = px;
          } catch {
            /* biarkan null */
          }
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
          feesBaseWei: val ? val.feesBaseWei : null,
          otherAmountWei: val ? (val.baseIsCurrency0 ? val.amount1 : val.amount0) : null,
          otherAddress: val ? (val.baseIsCurrency0 ? pk.currency1 : pk.currency0) : null,
          otherDecimals: val ? await tokenDecimals(val.baseIsCurrency0 ? pk.currency1 : pk.currency0, cc).catch(() => 18) : null,
          baseAmountWei: val ? (val.baseIsCurrency0 ? val.amount0 : val.amount1) : null,
          currentTick: val ? val.currentTick : null,
          rangePctHigh: val ? val.rangePctHigh : null,
          rangePctLow: val ? val.rangePctLow : null,
          inRange: val ? val.inRange : null,
          converted: val ? val.converted : false,
          base: pb.base,
          impliedTokenEthPrice,
        };
      } catch {
        return null;
      }
    },
  );
  const out = rows.filter((r): r is V4Position => r !== null);
  listCache.set(ck, { t: Date.now(), v: out });
  return out;
}

/** Buang cache list v4 (dipanggil setelah buka/tutup posisi supaya /positions segar). */
export function invalidateV4ListCache(): void {
  listCache.clear();
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
  // Jangan ambil pool PERTAMA yang terinisialisasi: varian native-ETH vs WETH bisa
  // dua-duanya hidup, dan yang satu bisa pool sekarat (liq ~$0) yang harganya
  // nyangkut jauh dari pasar. Pilih yang LIKUIDITASNYA paling dalam.
  let best: { poolKey: PoolKeyV4; baseIsCurrency0: boolean; liq: bigint } | null = null;
  for (const b of bases) {
    const [c0, c1] = b.toLowerCase() < otherAddr.toLowerCase() ? [b, otherAddr] : [otherAddr, b];
    const cand: PoolKeyV4 = { ...pk, currency0: c0, currency1: c1 };
    const { sqrtPriceX96 } = await readPoolState(cc, cand).catch(() => ({ sqrtPriceX96: 0n }));
    if (sqrtPriceX96 === 0n) continue;
    const liq = await readPoolLiquidity(cc, cand).catch(() => 0n);
    if (!best || liq > best.liq) best = { poolKey: cand, baseIsCurrency0: c0 === b, liq };
  }
  return best ? { poolKey: best.poolKey, baseIsCurrency0: best.baseIsCurrency0 } : null;
}

/**
 * Kesehatan pool v4 utk keputusan BUKA: likuiditas aktif on-chain + harga token
 * (dlm ETH) menurut slot0 pool ini. Dipakai wizard buat menyaring pool sekarat /
 * harga melenceng dari pasar sebelum menawarkannya. impliedTokenEthPrice hanya
 * untuk pasangan ETH (null selain itu / gagal baca).
 */
export async function poolHealthV4(
  cc: ChainCtx,
  pk: PoolKeyV4,
): Promise<{ liquidity: bigint; impliedTokenEthPrice: number | null }> {
  const liquidity = await readPoolLiquidity(cc, pk).catch(() => 0n);
  let impliedTokenEthPrice: number | null = null;
  const pb = pairBase(cc, pk.currency0, pk.currency1);
  if (pb.base === 'ETH') {
    try {
      const { tick } = await readPoolState(cc, pk);
      const tokenAddr = pb.baseIsCurrency0 ? pk.currency1 : pk.currency0;
      const tokDec = await tokenDecimals(tokenAddr, cc);
      const P = Math.pow(1.0001, tick);
      const factor = pb.baseIsCurrency0 ? 1 / P : P;
      const px = factor * Math.pow(10, tokDec - 18);
      if (isFinite(px) && px > 0) impliedTokenEthPrice = px;
    } catch {
      /* biarkan null */
    }
  }
  return { liquidity, impliedTokenEthPrice };
}

async function ensurePermit2(cc: ChainCtx, token: string, spender: string, amount: bigint): Promise<void> {
  const erc = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], cc.wallet);
  if ((await erc.allowance(cc.wallet.address, PERMIT2)) < amount) {
    await (await sendTxNonceSafe(cc.wallet as ethers.Wallet, await erc.approve.populateTransaction(PERMIT2, ethers.MaxUint256))).wait();
  }
  const p2 = new ethers.Contract(PERMIT2, ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)'], cc.wallet);
  const [amt] = await p2.allowance(cc.wallet.address, token, spender);
  if (BigInt(amt) < amount) {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await (await sendTxNonceSafe(cc.wallet as ethers.Wallet, await p2.approve.populateTransaction(token, spender, (1n << 160n) - 1n, exp))).wait();
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
  if (!pmAddr || !V4_POOL_MANAGER[cc.key]) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const spacing = poolKey.tickSpacing;
  const width = (opts.widthSpacings ?? 50) * spacing;
  // gap default 0 → tepi-dekat MENEMPEL harga sekarang supaya posisi mulai terisi
  // sejak pergerakan pertama ke arah kita (bukan menunggu turun berspasi dulu).
  const gap = (opts.gapSpacings ?? 0) * spacing;
  const state = await readPoolState(cc, poolKey);
  // slot0 kosong = poolKey tak cocok pool mana pun. Tanpa cek ini, revert-nya baru
  // muncul sebagai 'unknown custom error' (PoolNotInitialized) di preview rencana.
  if (state.sqrtPriceX96 === 0n) throw new Error('This v4 pool is not initialised — pick another pool.');
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
  if (liquidity <= 0n) {
    // Buta tanpa angka: catat pool, jumlah, spacing & lebar tick supaya jelas apakah
    // ini deposit kekecilan (wei USDG 6-dec) atau range kelewat lebar (spacing besar).
    console.log(
      `[v4] liquidity 0 — pool=${poolKey.currency0}/${poolKey.currency1} fee=${poolKey.fee} spacing=${spacing}` +
        ` baseIsC0=${baseIsCurrency0} amountWei=${baseAmountWei} widthTicks=${tickUpper - tickLower} [${tickLower},${tickUpper}]`,
    );
    throw new Error(
      `Computed liquidity is 0 — the deposit is too small for this pool's range (spacing ${spacing}, width ${tickUpper - tickLower} ticks). Increase the amount, narrow the range %, or pick a finer-spacing pool.`,
    );
  }

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
  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline, { value }));
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

// ── Ladder Bid-Ask v4 (batch native: N MINT + 1 SETTLE dalam satu tx) ────────
export type V4LadderLeg = { tickLower: number; tickUpper: number; baseAmountWei: bigint; liquidity: bigint; pctHigh: number; pctLow: number };

/** Bobot per-leg (index 0 = terdekat harga, N-1 = terjauh). spot=rata, bidask=∝(i+1). */
function ladderWeightsV4(n: number, shape: 'spot' | 'bidask'): number[] {
  if (n <= 1) return [1];
  const raw = shape === 'bidask' ? Array.from({ length: n }, (_, i) => i + 1) : Array.from({ length: n }, () => 1);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * Rencana ladder v4 single-sided (sisi base, buy-dip): pecah rentang [sekarang …
 * −X%] jadi N leg berbobot. Mirror planLadderSingleSided v3 tapi pakai tick-math
 * v4 (readPoolState + liqForAmount). Auto-cap N ke kapasitas spacing.
 */
export async function planLadderV4(
  cc: ChainCtx,
  poolKey: PoolKeyV4,
  baseIsCurrency0: boolean,
  totalBaseWei: bigint,
  rangePercent: number,
  legs: number,
  shape: 'spot' | 'bidask',
): Promise<V4LadderLeg[]> {
  const spacing = poolKey.tickSpacing;
  const state = await readPoolState(cc, poolKey);
  if (state.sqrtPriceX96 === 0n) throw new Error('This v4 pool is not initialised — pick another pool.');
  const current = state.tick;
  const frac = Math.min(Math.max(rangePercent, 0.1), 95) / 100;
  const fullWidth = Math.max(spacing, Math.ceil(Math.abs(Math.log(1 - frac)) / Math.log(1.0001) / spacing) * spacing);
  const maxLegs = Math.max(1, Math.floor(fullWidth / spacing));
  const n = Math.max(1, Math.min(legs, 69, maxLegs));
  const legWidth = Math.max(spacing, Math.round(fullWidth / n / spacing) * spacing);
  const weights = ladderWeightsV4(n, shape);
  const aligned = nearestUsableTick(current, spacing);
  const sgn = baseIsCurrency0 ? -1 : 1;
  const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - current)) - 1) * 100;

  const out: V4LadderLeg[] = [];
  let allocated = 0n;
  for (let k = 0; k < n; k++) {
    const legWei = k === n - 1 ? totalBaseWei - allocated : (totalBaseWei * BigInt(Math.round(weights[k] * 1e9))) / 1_000_000_000n;
    allocated += legWei;
    let tickLower: number;
    let tickUpper: number;
    if (baseIsCurrency0) {
      const anchor = aligned > current ? aligned : aligned + spacing;
      tickLower = anchor + k * legWidth;
      tickUpper = tickLower + legWidth;
    } else {
      const anchor = aligned < current ? aligned : aligned - spacing;
      tickUpper = anchor - k * legWidth;
      tickLower = tickUpper - legWidth;
    }
    const sqrtL = sqrtAtTick(tickLower);
    const sqrtU = sqrtAtTick(tickUpper);
    const liquidity = baseIsCurrency0 ? liqForAmount0(sqrtL, sqrtU, legWei) : liqForAmount1(sqrtL, sqrtU, legWei);
    if (liquidity <= 0n) continue; // leg debu — lewati
    const pcts = [pctOf(tickUpper), pctOf(tickLower)].sort((a, b) => b - a);
    out.push({ tickLower, tickUpper, baseAmountWei: legWei, liquidity, pctHigh: pcts[0], pctLow: pcts[1] });
  }
  return out;
}

/**
 * BATCH mint ladder v4: N leg dalam SATU modifyLiquidities atomik (N×MINT_POSITION
 * + 1×SETTLE_PAIR, +SWEEP bila native). Paling irit — settle base sekali di akhir.
 */
export async function openLadderV4(
  cc: ChainCtx,
  poolKey: PoolKeyV4,
  baseIsCurrency0: boolean,
  legs: V4LadderLeg[],
  opts: { dryRun: boolean },
): Promise<{ dryRun?: boolean; txHash?: string; tokenIds: string[] }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || !V4_POOL_MANAGER[cc.key]) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const baseCurrency = baseIsCurrency0 ? poolKey.currency0 : poolKey.currency1;
  const isNative = baseCurrency === ethers.ZeroAddress;
  const totalBase = legs.reduce((s, l) => s + l.baseAmountWei, 0n);

  const mintParams = legs.map((l) => {
    const amount0Max = baseIsCurrency0 ? l.baseAmountWei : 0n;
    const amount1Max = baseIsCurrency0 ? 0n : l.baseAmountWei;
    return coder.encode(
      ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
      [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], l.tickLower, l.tickUpper, l.liquidity, amount0Max, amount1Max, cc.wallet.address, '0x'],
    );
  });
  const settleParam = coder.encode(['address', 'address'], [poolKey.currency0, poolKey.currency1]);
  const actionBytes = [...legs.map(() => MINT_POSITION), SETTLE_PAIR, ...(isNative ? [SWEEP] : [])];
  const params = [...mintParams, settleParam, ...(isNative ? [coder.encode(['address', 'address'], [ethers.ZeroAddress, cc.wallet.address])] : [])];
  const actions = ethers.hexlify(new Uint8Array(actionBytes));
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const value = isNative ? totalBase : 0n;
  const pm = new ethers.Contract(pmAddr, V4_WRITE_ABI, cc.wallet);

  if (!isNative && !opts.dryRun) await ensurePermit2(cc, baseCurrency, pmAddr, totalBase);
  if (isNative || !opts.dryRun) {
    await pm.modifyLiquidities.staticCall(unlockData, deadline, { from: cc.wallet.address, value });
  }
  if (opts.dryRun) return { dryRun: true, tokenIds: [] };

  const tx = await sendTxNonceSafe(cc.wallet as ethers.Wallet, await pm.modifyLiquidities.populateTransaction(unlockData, deadline, { value }));
  const rc = await tx.wait();
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const toPadded = ethers.zeroPadValue(cc.wallet.address, 32).toLowerCase();
  const tokenIds: string[] = [];
  for (const log of rc?.logs ?? []) {
    if (
      log.address.toLowerCase() === pmAddr.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[1] === ethers.ZeroHash &&
      (log.topics[2] ?? '').toLowerCase() === toPadded
    ) {
      tokenIds.push(BigInt(log.topics[3]).toString());
    }
  }
  return { txHash: rc?.hash ?? tx.hash, tokenIds };
}

/**
 * Id NFT posisi berikutnya di PositionManager. Dipakai untuk MENGURUNG rentang
 * id yang mungkin lahir dari satu percobaan open: baca sebelum kirim, baca lagi
 * sesudahnya. Otoritatif (langsung dari kontrak), tak bergantung indexer.
 */
export async function v4NextTokenId(cc: ChainCtx): Promise<bigint> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  return await new ethers.Contract(pmAddr, ['function nextTokenId() view returns (uint256)'], cc.provider).nextTokenId();
}

/** Pemilik NFT posisi v4 — revert 'NOT_MINTED' berarti posisinya sudah tak ada. */
export async function v4OwnerOf(cc: ChainCtx, tokenId: string): Promise<string> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  return await new ethers.Contract(pmAddr, ['function ownerOf(uint256) view returns (address)'], cc.provider).ownerOf(tokenId);
}

/**
 * Id dalam [from, to) yang dimiliki wallet kita. Untuk memungut posisi yang
 * TERLANJUR ter-mint padahal alur open-nya gagal di tengah — tanpa ini posisi
 * itu ada di chain tapi tak punya catatan, jadi tak pernah muncul di /positions
 * saat indexer sedang down.
 * ponytail: dibatasi `cap` id — rentang satu percobaan open selalu kecil.
 */
export async function v4OwnedIdsInRange(cc: ChainCtx, from: bigint, to: bigint, cap = 64): Promise<string[]> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr || to <= from) return [];
  const pm = new ethers.Contract(pmAddr, ['function ownerOf(uint256) view returns (address)'], cc.provider);
  const me = cc.wallet.address.toLowerCase();
  const out: string[] = [];
  for (let id = from; id < to && id - from < BigInt(cap); id++) {
    const owner = await pm.ownerOf(id).catch(() => null);
    if (owner && String(owner).toLowerCase() === me) out.push(id.toString());
  }
  return out;
}

/** PoolKey + info base sebuah posisi v4 (untuk add ke pool yg sama). */
export async function getPoolKeyV4(cc: ChainCtx, tokenId: string): Promise<{ poolKey: PoolKeyV4; baseIsCurrency0: boolean; base: 'ETH' | 'USDG' | null }> {
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) throw new Error(`Uniswap v4 is not supported on ${cc.label}.`);
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  const [pk] = await pm.getPoolAndPositionInfo(tokenId);
  const poolKey: PoolKeyV4 = { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks };
  const { base, baseIsCurrency0 } = pairBase(cc, pk.currency0, pk.currency1);
  return { poolKey, baseIsCurrency0, base };
}

// ── Valuasi posisi v4 (nilai dalam base + range %) ──────────────────────────
/** Tick pool v4 sekarang — dipakai buat patok entryTick saat open. */
export async function currentTickV4(cc: ChainCtx, pk: PoolKeyV4): Promise<number> {
  return (await readPoolState(cc, pk)).tick;
}

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

/**
 * Likuiditas TOTAL pool v4 (bukan posisi). Layout Pool.State: base slot =
 * keccak256(poolId, POOLS_SLOT=6); slot0 di offset 0, liquidity (uint128) di
 * offset 3. Dipakai untuk deteksi pool sekarat (harga tak andal).
 */
async function readPoolLiquidity(cc: ChainCtx, pk: PoolKeyV4): Promise<bigint> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], ['function extsload(bytes32) view returns (bytes32)'], cc.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
  const base = BigInt(ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)])));
  const slot = ethers.zeroPadValue(ethers.toBeHex(base + 3n), 32);
  const raw = BigInt(await mgr.extsload(slot));
  return raw & ((1n << 128n) - 1n);
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

/**
 * Slot0 + fee posisi dalam SATU extsload(bytes32[]). Menggantikan readPoolState
 * di valuePositionV4 supaya jumlah RPC tak bertambah walau fee ikut dihitung.
 * tokenId = salt posisi v4 (owner = PositionManager).
 * Layout Pool.State: slot0@0, feeGrowthGlobal0/1@1,2, ticks@4, positions@6.
 */
async function readPoolAndFees(
  cc: ChainCtx, pk: PoolKeyV4, tickLower: number, tickUpper: number, tokenId: string,
): Promise<{ tick: number; sqrtPriceX96: bigint; fee0: bigint; fee1: bigint }> {
  const mgr = new ethers.Contract(V4_POOL_MANAGER[cc.key], [
    'function extsload(bytes32[]) view returns (bytes32[])',
  ], cc.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'],
    [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]]));
  const h = (x: bigint) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
  const base = BigInt(ethers.keccak256(ethers.concat([poolId, h(6n)])));
  const tickSlot = (t: number) => BigInt(ethers.keccak256(ethers.concat([
    h(BigInt.asUintN(256, BigInt(t))), h(base + 4n)])));
  const posKey = ethers.keccak256(ethers.solidityPacked(
    ['address', 'int24', 'int24', 'bytes32'], [V4_PM[cc.key], tickLower, tickUpper, h(BigInt(tokenId))]));
  const posSlot = BigInt(ethers.keccak256(ethers.concat([posKey, h(base + 6n)])));

  const raw: string[] = await mgr['extsload(bytes32[])']([
    h(base), h(base + 1n), h(base + 2n),
    h(tickSlot(tickLower) + 1n), h(tickSlot(tickLower) + 2n),
    h(tickSlot(tickUpper) + 1n), h(tickSlot(tickUpper) + 2n),
    h(posSlot), h(posSlot + 1n), h(posSlot + 2n),
  ]);
  const [s0, fg0, fg1, lo0, lo1, up0, up1, pl, il0, il1] = raw.map((x) => BigInt(x));

  const sqrtPriceX96 = s0 & ((1n << 160n) - 1n);
  let tick = Number((s0 >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;

  // feeGrowthInside = global - below - above (wrap-around uint256 disengaja).
  const M = 1n << 256n;
  const wrap = (x: bigint) => ((x % M) + M) % M;
  const below0 = tick >= tickLower ? lo0 : wrap(fg0 - lo0);
  const below1 = tick >= tickLower ? lo1 : wrap(fg1 - lo1);
  const above0 = tick < tickUpper ? up0 : wrap(fg0 - up0);
  const above1 = tick < tickUpper ? up1 : wrap(fg1 - up1);
  const L = pl & ((1n << 128n) - 1n);
  const fee0 = (wrap(wrap(fg0 - below0 - above0) - il0) * L) >> 128n;
  const fee1 = (wrap(wrap(fg1 - below1 - above1) - il1) * L) >> 128n;
  return { tick, sqrtPriceX96, fee0, fee1 };
}

export type V4Valuation = {
  amount0: bigint;
  amount1: bigint;
  base: 'ETH' | 'USDG' | null;
  baseIsCurrency0: boolean;
  valueBaseWei: bigint; // nilai posisi dalam unit base (raw, desimal base) — PRINSIPAL saja
  feesBaseWei: bigint; // fee belum diklaim, dinilai dalam base (0 bila tokenId tak diberi)
  rangePctHigh: number; // % ujung terdekat dari harga sekarang
  rangePctLow: number;
  inRange: boolean;
  currentTick: number;
  converted: boolean; // out-of-range & sisi base kosong → 100% token seberang (target tercapai)
};

/** Nilai posisi v4 (token amounts, nilai dalam base, range %). */
export async function valuePositionV4(cc: ChainCtx, pk: PoolKeyV4, tickLower: number, tickUpper: number, liquidity: bigint, tokenId?: string): Promise<V4Valuation> {
  // tokenId ada → sekalian ambil fee (RPC sama banyak). Tanpa tokenId (pratinjau
  // posisi yang belum dibuka) → slot0 saja, fee 0.
  const { tick, sqrtPriceX96, fee0, fee1 } = tokenId
    ? await readPoolAndFees(cc, pk, tickLower, tickUpper, tokenId)
    : { ...(await readPoolState(cc, pk)), fee0: 0n, fee1: 0n };
  const sqrtL = sqrtAtTick(tickLower);
  const sqrtU = sqrtAtTick(tickUpper);
  const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, sqrtL, sqrtU, liquidity);
  const { base, baseIsCurrency0 } = pairBase(cc, pk.currency0, pk.currency1);
  // sqrtPriceX96 = sqrt(token1/token0)*Q96 (rasio raw). Nilai dlm base:
  const p2 = sqrtPriceX96 * sqrtPriceX96; // (token1/token0)*Q96^2
  const inBase = (a0: bigint, a1: bigint) => baseIsCurrency0
    ? a0 + (p2 === 0n ? 0n : (a1 * Q96 * Q96) / p2)
    : a1 + (a0 * p2) / (Q96 * Q96);
  const valueBaseWei = inBase(amount0, amount1);
  const feesBaseWei = inBase(fee0, fee1);
  const sgn = baseIsCurrency0 ? -1 : 1;
  const pctOf = (tk: number) => (Math.pow(1.0001, sgn * (tk - tick)) - 1) * 100;
  const pcts = [pctOf(tickUpper), pctOf(tickLower)].sort((a, b) => b - a);
  const inRange = tick >= tickLower && tick < tickUpper;
  // Sisi base kosong saat out-of-range = harga sudah menembus SELURUH rentang →
  // 100% token seberang (buy-dip: sudah jadi token; target leg tercapai).
  const baseAmt = baseIsCurrency0 ? amount0 : amount1;
  return {
    amount0,
    amount1,
    base,
    baseIsCurrency0,
    valueBaseWei,
    feesBaseWei,
    rangePctHigh: pcts[0],
    rangePctLow: pcts[1],
    inRange,
    currentTick: tick,
    converted: !inRange && baseAmt === 0n,
  };
}

/** Status ringkas posisi v4 untuk monitor: masih ada? dalam range? */
export async function checkV4Status(
  cc: ChainCtx,
  tokenId: string,
): Promise<{ exists: boolean; inRange: boolean | null; tick: number | null; val: V4Valuation | null }> {
  // inRange null = TAK TAHU (RPC gagal / chain tanpa PM). Jangan dipetakan ke false:
  // itu memicu alert "OUT OF RANGE" palsu yang mendorong keputusan uang.
  const pmAddr = V4_PM[cc.key];
  if (!pmAddr) return { exists: true, inRange: null, tick: null, val: null };
  const pm = new ethers.Contract(pmAddr, V4_ABI, cc.provider);
  try {
    const [pk, info] = await pm.getPoolAndPositionInfo(tokenId);
    const liquidity: bigint = await pm.getPositionLiquidity(tokenId);
    if (liquidity === 0n || (pk.currency0 === ethers.ZeroAddress && pk.currency1 === ethers.ZeroAddress)) {
      return { exists: false, inRange: false, tick: null, val: null };
    }
    const tickLower = signExt24((info >> 8n) & 0xffffffn);
    const tickUpper = signExt24((info >> 32n) & 0xffffffn);
    const poolKey: PoolKeyV4 = { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks };
    // valuePositionV4 memakai SATU extsload yang juga berisi slot0 → tick, nilai,
    // dan fee didapat dengan RPC yang sama banyaknya seperti readPoolState dulu.
    const val = await valuePositionV4(cc, poolKey, tickLower, tickUpper, liquidity, tokenId);
    return { exists: true, inRange: val.inRange, tick: val.currentTick, val };
  } catch {
    return { exists: true, inRange: null, tick: null, val: null }; // transien → jangan hapus & jangan alert
  }
}
