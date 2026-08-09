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
 *  - v4: Krystal mengembalikan fee EFEKTIF & tickSpacing 0 → TAK bisa dipakai mint.
 *    poolKey (currency0/1, fee, tickSpacing, hooks) diambil dari event Initialize
 *    on-chain (Blockscout) lalu DIVERIFIKASI keccak==poolId. Butuh cc.blockscout.
 *  - v3: poolAddress = kontrak pool langsung; buka cukup pakai fee + factory.getPool,
 *    jadi tak perlu rekonstruksi. fee wajib termasuk feeTiers chain.
 */

const CHAIN_ID: Record<string, number> = { robinhood: 4663, bsc: 56 };
const API = 'https://cloud-api.krystal.app/v1';
const INIT_SIG = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
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

/**
 * poolKey v4 PASTI dari event Initialize (difilter poolId), diverifikasi
 * keccak==poolId. Blockscout REST getLogs menelan rentang blok penuh (RPC getLogs
 * 0→latest ditolak). null = tak bisa dibuktikan → jangan tawarkan.
 */
async function poolKeyFromInitialize(cc: ChainCtx, poolManager: string, poolId: string): Promise<PoolKeyV4 | null> {
  if (!cc.blockscout) return null;
  const base = cc.blockscout.replace('/api/v2', '/api');
  const url = `${base}?module=logs&action=getLogs&fromBlock=1&toBlock=latest&address=${poolManager}&topic0=${INIT_SIG}&topic1=${poolId}&topic0_1_opr=and`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  let j: any;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  const log = Array.isArray(j?.result) ? j.result[0] : null;
  if (!log?.data || !log?.topics) return null;
  try {
    const [fee, tickSpacing, hooks] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'],
      log.data,
    );
    const currency0 = ethers.getAddress('0x' + String(log.topics[2]).slice(26));
    const currency1 = ethers.getAddress('0x' + String(log.topics[3]).slice(26));
    const pk: PoolKeyV4 = { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const recomputed = ethers.keccak256(
      coder.encode(['tuple(address,address,uint24,int24,address)'], [[currency0, currency1, pk.fee, pk.tickSpacing, hooks]]),
    );
    if (recomputed.toLowerCase() !== poolId.toLowerCase()) return null;
    return pk;
  } catch {
    return null;
  }
}

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

      if (proto === 'uniswapv4') {
        const pk = await poolKeyFromInitialize(cc, p.protocol.factoryAddress, p.poolAddress);
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
