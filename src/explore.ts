/**
 * EXPLORE — Top pool by APR, sinkron REAL-TIME dgn Uniswap.
 *
 * Sumber data = gateway resmi Uniswap (interface.gateway.uniswap.org) — persis
 * yang menyalakan app.uniswap.org/explore. Ambil topV3Pools + topV4Pools (protocol
 * v3 & v4) lalu SARING pool yang bisa di-LP single-sided oleh bot:
 * salah satu sisi harus base kita (ETH/WETH atau USDG). APR bukan field bawaan →
 * dihitung dgn rumus Explore: fee 1D disetahunkan / TVL.
 *
 *   APR = volume1D × (feeTier / 1e6) × 365 / TVL
 *
 * Read-only murni: tak menyentuh wallet/on-chain. Aman gagal (throw → kartu error).
 */
import { getChain, type ChainCtx } from './chains.js';
import type { PoolKeyV4 } from './uniswapV4.js';
import { ethers } from 'ethers';
import * as m from './messages.js';

const GATEWAY = 'https://interface.gateway.uniswap.org/v1/graphql';

// key chain internal → nama enum Chain di API Uniswap.
const UNISWAP_CHAIN: Record<string, string> = {
  robinhood: 'ROBINHOOD',
  ethereum: 'ETHEREUM',
  base: 'BASE',
  bsc: 'BNB',
};

// Ambil banyak lalu saring & urut sendiri (API urut by TVL, kita mau by APR).
const FETCH_N = 100;
// Lantai TVL: cegah pool debu ($ receh, 1 swap) memalsukan APR ribuan %.
const MIN_TVL_USD = 1_000;

export type ExplorePool = {
  ver: string; // 'v4' | 'v3'
  pair: string; // TOKEN/BASE (base ditaruh belakang)
  feeTier: number; // 500 = 0.05%
  tvlUsd: number;
  vol1dUsd: number;
  apr: number; // persen
  otherAddr?: string; // CA sisi non-base → tombol "➕ LP <TOKEN>"
};

type ApiPool = {
  protocolVersion?: string;
  feeTier?: number;
  totalLiquidity?: { value?: number } | null;
  cumulativeVolume?: { value?: number } | null;
  token0?: { symbol?: string; address?: string | null } | null;
  token1?: { symbol?: string; address?: string | null } | null;
};

const POOL_FIELDS = `
    protocolVersion
    feeTier
    totalLiquidity { value }
    cumulativeVolume(duration: DAY) { value }
    token0 { symbol address }
    token1 { symbol address }`;

const QUERY = `query TopPools($chain: Chain!, $n: Int!) {
  topV3Pools(chain: $chain, first: $n) {${POOL_FIELDS}
  }
  topV4Pools(chain: $chain, first: $n) {${POOL_FIELDS}
  }
}`;

/** true bila token ini salah satu base yang bisa di-LP single-sided (ETH/WETH/USDG). */
function isBase(sym: string | undefined | null, addr: string | undefined | null, ctx: ChainCtx): boolean {
  const s = (sym ?? '').toUpperCase();
  const a = (addr ?? '').toLowerCase();
  if (s === 'ETH' || s === 'WETH') return true;
  if (a && a === ctx.wethAddress.toLowerCase()) return true;
  if (ctx.usdgAddress) {
    if (s === 'USDG') return true;
    if (a && a === ctx.usdgAddress.toLowerCase()) return true;
  }
  return false;
}

/** Ambil top pool by APR yang bisa di-LP single-sided (ETH/WETH/USDG), sinkron Uniswap. */
export async function fetchTopPools(
  ctx: ChainCtx = getChain(),
  limit = 5,
): Promise<ExplorePool[]> {
  const chain = UNISWAP_CHAIN[ctx.key];
  if (!chain) throw new Error(`Chain ${ctx.label} tak didukung Explore Uniswap.`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let json: any;
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body: JSON.stringify({ query: QUERY, variables: { chain, n: FETCH_N } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (json?.errors?.length) throw new Error(json.errors[0]?.message ?? 'gateway error');

  const raw: ApiPool[] = [
    ...(json?.data?.topV3Pools ?? []),
    ...(json?.data?.topV4Pools ?? []),
  ];
  const out: ExplorePool[] = [];
  for (const p of raw) {
    const t0 = p.token0,
      t1 = p.token1;
    if (!t0 || !t1) continue;
    // Wajib bisa single-sided: tepat/minimal satu sisi = base kita.
    const base0 = isBase(t0.symbol, t0.address, ctx);
    const base1 = isBase(t1.symbol, t1.address, ctx);
    if (!base0 && !base1) continue;

    const tvl = p.totalLiquidity?.value ?? 0;
    const vol = p.cumulativeVolume?.value ?? 0;
    const feeTier = p.feeTier ?? 0;
    if (tvl < MIN_TVL_USD || vol <= 0 || feeTier <= 0) continue;

    const apr = (vol * (feeTier / 1e6) * 365) / tvl * 100;

    // Base ditaruh belakang → baca "TOKEN/BASE".
    const s0 = t0.symbol ?? '?',
      s1 = t1.symbol ?? '?';
    const pair = base0 && !base1 ? `${s1}/${s0}` : `${s0}/${s1}`;
    const otherAddr = base0 && !base1 ? t1.address : base1 && !base0 ? t0.address : undefined;

    out.push({
      ver: (p.protocolVersion ?? 'V4').toLowerCase(),
      pair,
      feeTier,
      tvlUsd: tvl,
      vol1dUsd: vol,
      apr,
      otherAddr: otherAddr ?? undefined,
    });
  }
  out.sort((a, b) => b.apr - a.apr);
  return out.slice(0, limit);
}

// ─── discovery per-token (untuk /add) ──────────────────────────────

/** Kandidat pool untuk 1 token — dipakai wizard /add. Cerminan app.uniswap.org. */
export type TokenPool = {
  protocol: 'v3' | 'v4';
  base: 'weth' | 'usdg' | 'usdt'; // sisi base bot (WETH/ETH, USDG, atau USDT)
  baseSymbol: string; // 'ETH' | 'WETH' | 'USDG' (apa adanya dari Uniswap)
  otherSymbol: string; // simbol token target
  fee: number;
  tvlUsd: number;
  poolKey?: PoolKeyV4; // v4 saja — currency0/1, fee, tickSpacing, hooks
  baseIsCurrency0?: boolean; // v4 saja
};

// Query pool untuk 1 token (v3 + v4) via tokenFilter — persis sumber Explore.
const TOKEN_POOL_FIELDS = `
    protocolVersion
    feeTier
    totalLiquidity { value }
    token0 { symbol address }
    token1 { symbol address }`;
const TOKEN_QUERY = `query PoolsForToken($chain: Chain!, $n: Int!, $t: String!) {
  topV3Pools(chain: $chain, first: $n, tokenFilter: $t) {${TOKEN_POOL_FIELDS}
  }
  topV4Pools(chain: $chain, first: $n, tokenFilter: $t) {${TOKEN_POOL_FIELDS}
    tickSpacing
    hook { address }
  }
}`;

const baseKindOf = (sym: string | null | undefined, addr: string | null | undefined, ctx: ChainCtx): 'weth' | 'usdg' | null => {
  const s = (sym ?? '').toUpperCase();
  const a = (addr ?? '').toLowerCase();
  if (s === 'ETH' || s === 'WETH' || (a && a === ctx.wethAddress.toLowerCase())) return 'weth';
  if (ctx.usdgAddress && (s === 'USDG' || (a && a === ctx.usdgAddress.toLowerCase()))) return 'usdg';
  return null;
};

/**
 * Semua pool (v3 + v4) yang memuat `token` dan bisa di-LP single-sided (satu sisi
 * base ETH/WETH/USDG), urut TVL menurun. Cerminan langsung app.uniswap.org.
 * Pool v4 BER-HOOK di-skip (hook bisa ubah fee/behavior — riskan utk auto-LP).
 * Throw bila gateway gagal → pemanggil bisa fallback ke discovery on-chain v3.
 */
export async function poolsForToken(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  const chain = UNISWAP_CHAIN[ctx.key];
  if (!chain) throw new Error(`Chain ${ctx.label} tak didukung Explore Uniswap.`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let json: any;
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body: JSON.stringify({ query: TOKEN_QUERY, variables: { chain, n: 40, t: token } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (json?.errors?.length) throw new Error(json.errors[0]?.message ?? 'gateway error');

  const out: TokenPool[] = [];
  const push = (p: ApiPool & { tickSpacing?: number; hook?: { address?: string } | null }, protocol: 'v3' | 'v4') => {
    const t0 = p.token0,
      t1 = p.token1;
    if (!t0 || !t1) return;
    const b0 = baseKindOf(t0.symbol, t0.address, ctx);
    const b1 = baseKindOf(t1.symbol, t1.address, ctx);
    // Wajib TEPAT satu sisi base (single-sided-able); skip base/base atau non-base.
    if ((b0 && b1) || (!b0 && !b1)) return;
    const fee = p.feeTier ?? 0;
    const tvl = p.totalLiquidity?.value ?? 0;
    if (fee <= 0) return;
    if (protocol === 'v4' && p.hook) return; // ber-hook → skip (aman)

    const baseIsCurrency0 = !!b0;
    const base = (b0 ?? b1)!;
    const baseSymbol = (baseIsCurrency0 ? t0.symbol : t1.symbol) ?? (base === 'usdg' ? 'USDG' : 'ETH');
    const otherSymbol = (baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
    const tp: TokenPool = { protocol, base, baseSymbol, otherSymbol, fee, tvlUsd: tvl };
    if (protocol === 'v4') {
      tp.poolKey = {
        currency0: t0.address ?? ethers.ZeroAddress, // ETH native = null → 0x0
        currency1: t1.address ?? ethers.ZeroAddress,
        fee,
        tickSpacing: p.tickSpacing ?? 0,
        hooks: ethers.ZeroAddress,
      };
      tp.baseIsCurrency0 = baseIsCurrency0;
      if (!tp.poolKey.tickSpacing) return; // tanpa tickSpacing tak bisa dibuka
    }
    out.push(tp);
  };
  for (const p of json?.data?.topV3Pools ?? []) push(p, 'v3');
  for (const p of json?.data?.topV4Pools ?? []) push(p, 'v4');
  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return out;
}

// ─── format ────────────────────────────────────────────────────────

function usdCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function aprLabel(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K%';
  return n.toFixed(1) + '%';
}

/** Kartu EXPLORE (tg-ui): header identitas → tabel → highlight #1 APR → footer sinkron. */
export function renderExplore(pools: ExplorePool[], chainLabel: string): string {
  if (pools.length === 0) {
    return m.card(`📈 ${m.title('EXPLORE', chainLabel)}`, [
      m.note('Belum ada pool ETH/USDG yang memenuhi syarat. Coba lagi nanti.'),
      '',
      m.italic(`Uniswap · ${m.nowWib()}`),
    ]);
  }

  const header = ['#', 'pair', 'ver', 'fee', 'apr', 'tvl', '1d vol'];
  const rows = pools.map((p, i) => [
    String(i + 1),
    p.pair.length > 16 ? p.pair.slice(0, 15) + '…' : p.pair,
    p.ver,
    m.feeLabel(p.feeTier),
    aprLabel(p.apr),
    usdCompact(p.tvlUsd),
    usdCompact(p.vol1dUsd),
  ]);
  const right = [true, false, false, true, true, true, true];

  const top = pools[0];
  const body = [
    m.pre(m.alignTable(header, rows, right)),
    '',
    `📈 ${m.bold(`#1 ${top.pair} · ${aprLabel(top.apr)} APR`)}`,
    '',
    m.note(`top 5 by APR · single-sided ETH/USDG · TVL ≥ $${(MIN_TVL_USD / 1000).toFixed(0)}K · APR = fee 1D disetahunkan`),
    m.italic(`Uniswap · sinkron · ${m.nowWib()}`),
  ];
  return m.card(`📈 ${m.title('EXPLORE', chainLabel)}`, body);
}
