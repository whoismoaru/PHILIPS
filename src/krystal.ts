import { ethers } from 'ethers';
import { config } from './config.js';
import type { ChainCtx } from './chains.js';
import type { TokenPool } from './explore.js';
import type { PoolKeyV4 } from './uniswapV4.js';

/**
 * Sumber pool via Krystal Cloud API — daftar pool jauh lebih lengkap dari gateway
 * Uniswap / DexScreener (mis. pool ETH/token ber-TVL besar yang gateway lewatkan),
 * dengan TVL benar. Dipakai di Robinhood (uniswap v3/v4) DAN BSC (pancakeswap v3).
 *
 * Catatan penting per protokol:
 *  - v4: Krystal memberi fee EFEKTIF & tickSpacing 0 di list → TAK bisa dipakai mint.
 *    poolKey direkonstruksi di resolveV4PoolKey (detail Krystal + brute-force fee)
 *    lalu DIVERIFIKASI keccak==poolId. Hanya ditawarkan di chain yang bot bisa
 *    KELOLA posisinya (butuh Blockscout utk enumerasi/monitor — BSC tak punya).
 *  - v3: poolAddress = kontrak pool langsung; buka cukup pakai fee + factory.getPool,
 *    jadi tak perlu rekonstruksi. fee wajib termasuk feeTiers chain.
 */

const CHAIN_ID: Record<string, number> = { robinhood: 4663, bsc: 56 };
const API = 'https://cloud-api.krystal.app/v1';
const V3_PROTOCOLS = new Set(['uniswapv3', 'pancakev3', 'sushiv3']);

export const krystalConfigured = (cc: ChainCtx): boolean => !!config.krystal.apiKey && CHAIN_ID[cc.key] !== undefined;

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { 'KC-APIKey': config.krystal.apiKey, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`krystal HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const coder = ethers.AbiCoder.defaultAbiCoder();
// Buffer ABI-encoded poolKey dgn fee=0 (placeholder); fee ditulis-ulang saat brute.
const poolIdBufferHex = (c0: string, c1: string, ts: number, h: string): string =>
  coder.encode(['tuple(address,address,uint24,int24,address)'], [[c0, c1, 0, ts, h]]);

// poolKey diverifikasi bersifat TETAP (poolId = keccak-nya) → cache selamanya.
// Bikin resolusi tahan gangguan API sesaat: sekali terbukti, tak perlu diulang.
const pkCache = new Map<string, PoolKeyV4>();

/** Detail 1 pool: list memberi tickSpacing 0, detail memberi tickSpacing & hooks asli. */
async function krystalDetail(cid: number, poolId: string): Promise<{ tickSpacing: number; hooks: string; feeTier: number } | null> {
  const d = await fetchJson(`${API}/pools/${cid}/${poolId}`).catch(() => null);
  if (!d || d.tickSpacing == null) return null;
  return { tickSpacing: Number(d.tickSpacing), hooks: d.hook ?? ethers.ZeroAddress, feeTier: Number(d.feeTier) };
}

/**
 * poolKey v4 diverifikasi, ANDAL (tanpa Blockscout — dulu getLogs 0→latest sering
 * timeout/rate-limit → pool v4 lenyap dari daftar). Sumber: detail Krystal
 * (tickSpacing + hooks) + fee di-BRUTE-FORCE. Krystal cuma tahu fee EFEKTIF (≈ fee
 * poolKey − ~1000 unit), jadi fee dicari di window sempit sekitar feeTier lalu
 * DIVERIFIKASI keccak==poolId. Cocok → pasti aman di-mint; hooks/ts salah → tak
 * cocok → null (tak ditawarkan). Hasil di-cache.
 */
async function resolveV4PoolKey(cc: ChainCtx, p: any): Promise<PoolKeyV4 | null> {
  const poolId = String(p.poolAddress);
  const hit = pkCache.get(poolId);
  if (hit) return hit;
  const a = p.token0?.token?.address, b = p.token1?.token?.address;
  if (!a || !b) return null;
  const det = await krystalDetail(CHAIN_ID[cc.key], poolId);
  if (!det) return null;
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  // Encode poolKey SEKALI, lalu tiap iterasi cuma tulis-ulang 3 byte fee (uint24 di
  // ujung word ke-3) + keccak — jauh lebih cepat dari AbiCoder.encode per iterasi
  // (dulu ~40 dtk untuk 5 pool → wizard menggantung). Window lebar aman karena murah.
  const buf = ethers.getBytes(poolIdBufferHex(c0, c1, det.tickSpacing, det.hooks));
  const target = poolId.toLowerCase();
  // fee poolKey ≈ fee efektif − beberapa % (dynamic-fee premium; terukur 2–3%).
  // Window 20% ke bawah + 2000 ke atas = margin ~6× dari yang teramati, tetap murah.
  const lo = Math.max(0, Math.floor(det.feeTier * 0.8) - 100);
  const hi = det.feeTier + 2_000;
  for (let f = lo; f <= hi; f++) {
    buf[93] = (f >> 16) & 0xff;
    buf[94] = (f >> 8) & 0xff;
    buf[95] = f & 0xff;
    if (ethers.keccak256(buf) === target) {
      const pk: PoolKeyV4 = { currency0: ethers.getAddress(c0), currency1: ethers.getAddress(c1), fee: f, tickSpacing: det.tickSpacing, hooks: det.hooks };
      pkCache.set(poolId, pk);
      return pk;
    }
  }
  return null;
}

/** Protokol v3 asli chain ini (samakan dgn cc.factory): PancakeSwap→pancakev3, selain itu uniswapv3. */
const chainV3Protocol = (cc: ChainCtx): string => (cc.dexLabel === 'PancakeSwap' ? 'pancakev3' : 'uniswapv3');

/** base bot dari sepasang currency (ETH-native/WETH/WBNB, USDG, atau USDT). null = tak didukung. */
function baseOfPair(
  cc: ChainCtx,
  c0: string,
  c1: string,
): { base: 'weth' | 'usdg' | 'usdt'; baseIsCurrency0: boolean } | null {
  const isEth = (a: string) =>
    cc.hasWethBase && (a === ethers.ZeroAddress || a.toLowerCase() === cc.wethAddress.toLowerCase());
  const isUsdg = (a: string) => !!cc.usdgAddress && a.toLowerCase() === cc.usdgAddress.toLowerCase();
  const isUsdt = (a: string) => !!cc.usdtAddress && a.toLowerCase() === cc.usdtAddress.toLowerCase();
  if (isEth(c0)) return { base: 'weth', baseIsCurrency0: true };
  if (isEth(c1)) return { base: 'weth', baseIsCurrency0: false };
  if (isUsdg(c0)) return { base: 'usdg', baseIsCurrency0: true };
  if (isUsdg(c1)) return { base: 'usdg', baseIsCurrency0: false };
  if (isUsdt(c0)) return { base: 'usdt', baseIsCurrency0: true };
  if (isUsdt(c1)) return { base: 'usdt', baseIsCurrency0: false };
  return null;
}

/**
 * Pool untuk 1 token via Krystal, siap dipakai wizard. v4 → poolKey diverifikasi
 * on-chain; v3 → fee + base (buka via factory.getPool). Hanya pair base ETH/USDG/
 * USDT. Diurut TVL turun. Tak dikonfigurasi / gagal → []. Pemanggil tetap menjalankan
 * filter kesehatan (activeLiq>0 utk v4).
 */
export async function krystalPools(cc: ChainCtx, token: string): Promise<TokenPool[]> {
  if (!krystalConfigured(cc)) return [];
  const cid = CHAIN_ID[cc.key];
  const list = await fetchJson(`${API}/pools?chainId=${cid}&token=${token}&sortBy=0&limit=50`).catch(() => null);
  if (!Array.isArray(list)) return [];
  const out = await Promise.all(
    list.map(async (p: any): Promise<TokenPool | null> => {
      const proto = p?.protocol?.key as string | undefined;
      if (!proto || !p.poolAddress) return null;
      const t0 = p.token0?.token, t1 = p.token1?.token;
      if (!t0?.address || !t1?.address) return null;
      // Debu → lewati SEBELUM resolusi poolKey v4 yang mahal (brute-force). Diuji pada
      // TVL sendiri: volume tak boleh menutupi pool kosong (lihat MIN_POOL_TVL_USD).
      // Ambang di sini setengah ambang tampilan — biar pemanggil tetap yang memutuskan.
      const tvl = Number(p.tvl) || 0;
      if (tvl < 500) return null;

      if (proto === 'uniswapv4') {
        // v4 hanya di chain yang bot dukung PENUH: enumerasi/monitor/tutup posisi v4
        // butuh Blockscout (BSC tak punya) + V4_PM terkonfigurasi. Tanpa itu, posisi
        // yang dibuka tak bisa dipantau/ditutup — jangan tawarkan.
        if (!cc.blockscout) return null;
        const pk = await resolveV4PoolKey(cc, p);
        if (!pk) return null; // poolKey tak terbukti → jangan tawarkan
        const b = baseOfPair(cc, pk.currency0, pk.currency1);
        if (!b) return null;
        const otherSym = (b.baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
        const baseSym = (b.baseIsCurrency0 ? t0.symbol : t1.symbol) ?? (b.base === 'weth' ? 'ETH' : b.base.toUpperCase());
        return {
          protocol: 'v4',
          base: b.base,
          baseSymbol: baseSym,
          otherSymbol: otherSym,
          fee: pk.fee,
          tvlUsd: Number(p.tvl) || 0,
          vol24hUsd: p.stats24h?.volume != null ? Number(p.stats24h.volume) : 0,
          aprPct: p.stats24h?.apr != null ? Number(p.stats24h.apr) : null,
          poolKey: pk,
          baseIsCurrency0: b.baseIsCurrency0,
        };
      }

      if (V3_PROTOCOLS.has(proto)) {
        // Hanya v3 dari DEX ASLI chain ini (yang cc.factory tunjuk). Pool uniswapv3 di
        // BSC pakai factory berbeda dari PancakeSwap → factory.getPool gagal saat buka.
        if (proto !== chainV3Protocol(cc)) return null;
        const b = baseOfPair(cc, t0.address, t1.address);
        if (!b) return null;
        const fee = Number(p.feeTier);
        if (!cc.feeTiers.includes(fee)) return null; // fee tak terdaftar di factory → tak bisa dibuka
        const otherSym = (b.baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
        const baseSym = (b.baseIsCurrency0 ? t0.symbol : t1.symbol) ?? (b.base === 'weth' ? 'ETH' : b.base.toUpperCase());
        return {
          protocol: 'v3',
          base: b.base,
          baseSymbol: baseSym,
          otherSymbol: otherSym,
          fee,
          tvlUsd: Number(p.tvl) || 0,
          vol24hUsd: p.stats24h?.volume != null ? Number(p.stats24h.volume) : 0,
          aprPct: p.stats24h?.apr != null ? Number(p.stats24h.apr) : null,
        };
      }
      return null;
    }),
  );
  return out.filter((p): p is TokenPool => p !== null).sort((a, b) => b.tvlUsd - a.tvlUsd);
}
