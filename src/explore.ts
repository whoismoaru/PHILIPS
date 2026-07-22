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

    out.push({
      ver: (p.protocolVersion ?? 'V4').toLowerCase(),
      pair,
      feeTier,
      tvlUsd: tvl,
      vol1dUsd: vol,
      apr,
    });
  }
  out.sort((a, b) => b.apr - a.apr);
  return out.slice(0, limit);
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

/** Tabel monospace rata kolom. cols[i].right = rata kanan (angka). */
function alignTable(header: string[], rows: string[][], right: boolean[]): string {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (right[i] ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

/** Kartu EXPLORE (tg-ui): header identitas → tabel → highlight #1 APR → footer sinkron. */
export function renderExplore(pools: ExplorePool[], chainLabel: string): string {
  if (pools.length === 0) {
    return m.card(`📈 ${m.title('EXPLORE', chainLabel)}`, [
      m.note('Belum ada pool ETH/USDG yang memenuhi syarat. Coba lagi nanti.'),
      '',
      m.italic(`Uniswap · ${m.nowUtc()}`),
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
    m.pre(alignTable(header, rows, right)),
    '',
    `📈 ${m.bold(`#1 ${top.pair} · ${aprLabel(top.apr)} APR`)}`,
    '',
    m.note('top 5 by APR · single-sided ETH/USDG · APR = fee 1D disetahunkan'),
    m.italic(`Uniswap · sinkron · ${m.nowUtc()}`),
  ];
  return m.card(`📈 ${m.title('EXPLORE', chainLabel)}`, body);
}
