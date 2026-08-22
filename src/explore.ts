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
import { getChain, venueCtx, venuesFor, type BaseKind, type ChainCtx } from './chains.js';
import { v4Supported } from './uniswapV4.js';
import { krystalPools } from './krystal.js';
import type { PoolKeyV4 } from './uniswapV4.js';
import { ethers } from 'ethers';
import * as m from './messages.js';

const GATEWAY = 'https://interface.gateway.uniswap.org/v1/graphql';

// key chain internal → nama enum Chain di API Uniswap.
// Chain yang daftar pool-nya diambil dari gateway Uniswap. BSC SENGAJA tak ada:
// posisi di sana dibuka di PancakeSwap, dan gateway Uniswap tak memuat pool Pancake
// sama sekali — chain di luar peta ini memakai jalur DexScreener di bawah.
const UNISWAP_CHAIN: Record<string, string> = {
  robinhood: 'ROBINHOOD',
  ethereum: 'ETHEREUM',
  base: 'BASE',
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
  chain?: string; // key chain asal — WAJIB saat daftar menggabung banyak chain
  chainLabel?: string; // label tampilan chain asal
  vol1hUsd?: number; // volume 1 jam (DexScreener). undefined = tak terbaca.
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
  if (!chain) return fetchTopPoolsDex(ctx, limit);

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
    // v4 hanya di chain yang bot dukung PENUH — di chain lain posisi v4 tak bisa
    // dipantau atau ditutup, jadi jangan dipajang sebagai peluang.
    ...(v4Supported(ctx) ? (json?.data?.topV4Pools ?? []) : []),
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
  return out.slice(0, limit).map((p) => ({ ...p, chain: ctx.key, chainLabel: ctx.label }));
}

// ─── discovery per-token (untuk /add) ──────────────────────────────

/** Kandidat pool untuk 1 token — dipakai wizard /add. Cerminan app.uniswap.org. */
export type TokenPool = {
  protocol: 'v3' | 'v4';
  base: BaseKind; // sisi base bot (WETH/ETH, USDG, atau USDT)
  baseSymbol: string; // 'ETH' | 'WETH' | 'USDG' (apa adanya dari Uniswap)
  otherSymbol: string; // simbol token target
  fee: number;
  tvlUsd: number;
  vol24hUsd?: number; // volume 24 jam (USD) — untuk ranking "terbesar" & tampilan
  vol1hUsd?: number; // volume 1 jam (USD) — Krystal stats1h; untuk daftar "lagi rame"
  aprPct?: number | null; // fee 24 jam disetahunkan; null = volume tak terbaca
  otherAddr?: string; // alamat sisi token — dibutuhkan tombol "Add LP" di daftar lintas-chain
  venue?: string; // DEX non-bawaan chain (mis. 'uniswapv3' di BSC); kosong = bawaan
  poolKey?: PoolKeyV4; // v4 saja — currency0/1, fee, tickSpacing, hooks
  baseIsCurrency0?: boolean; // v4 saja
};

// Query pool untuk 1 token (v3 + v4) via tokenFilter — persis sumber Explore.
const TOKEN_POOL_FIELDS = `
    protocolVersion
    feeTier
    totalLiquidity { value }
    cumulativeVolume(duration: DAY) { value }
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

/** Sisi base sebuah token dalam pool, dicocokkan ke daftar base CHAIN ini
 *  (WETH/WBNB, USDG, USDT). null = bukan aset base. */
const baseKindOf = (
  sym: string | null | undefined,
  addr: string | null | undefined,
  ctx: ChainCtx,
): BaseKind | null => {
  const s = (sym ?? '').toUpperCase();
  const a = (addr ?? '').toLowerCase();
  for (const b of ctx.bases) {
    if (a && a === b.address.toLowerCase()) return b.kind;
    if (s && s === b.symbol.toUpperCase()) return b.kind;
  }
  // ETH-native (v4 currency0 = 0x0) memakai simbol 'ETH', bukan simbol wrapped-nya.
  if (s === 'ETH' && ctx.hasWethBase) return 'weth';
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
  if (!chain) return poolsForTokenDex(ctx, token);

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
    // v4 hanya di chain yang bot dukung PENUH (V4_PM + Blockscout utk enumerasi).
    // Di chain lain gateway tetap mengembalikan pool v4, tapi posisi yang dibuka
    // takkan bisa dipantau atau ditutup — jangan tawarkan sama sekali.
    if (protocol === 'v4' && !v4Supported(ctx)) return;

    const baseIsCurrency0 = !!b0;
    const base = (b0 ?? b1)!;
    const baseSymbol = (baseIsCurrency0 ? t0.symbol : t1.symbol) ?? (base === 'usdg' ? 'USDG' : 'ETH');
    const otherSymbol = (baseIsCurrency0 ? t1.symbol : t0.symbol) ?? '?';
    // APR = fee 24 jam disetahunkan (rumus sama dengan kartu /pools).
    const vol = p.cumulativeVolume?.value ?? 0;
    const aprPct = tvl > 0 && vol > 0 ? ((vol * (fee / 1e6) * 365) / tvl) * 100 : null;
    const tp: TokenPool = { protocol, base, baseSymbol, otherSymbol, fee, tvlUsd: tvl, vol24hUsd: vol, aprPct };
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

// ─── sumber alternatif: DexScreener (chain tanpa gateway Uniswap, mis. BSC) ──
//
// DexScreener memberi likuiditas & volume 24 jam per PAIR, tapi TIDAK memberi fee
// tier. Fee dibaca on-chain dari pool-nya, sekaligus dipakai membuktikan pool itu
// benar milik factory chain ini (fork lain punya alamat pool berbeda untuk pasangan
// yang sama) — jadi angka yang dipakai membuka posisi tetap datang dari chain.

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
const ERC20_SYM_ABI = ['function symbol() view returns (string)'];
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];

/** Harga USD wrapped-native chain ini (untuk menilai sisi base). null = tak terbaca. */
async function getBaseUsd(ctx: ChainCtx): Promise<number | null> {
  const { getEthUsd } = await import('./screening.js');
  return getEthUsd(ctx.wethAddress, ctx).catch(() => null);
}
const POOL_META_ABI = [
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

type DexPair = {
  pairAddress: string;
  liquidityUsd: number;
  vol24hUsd: number;
  vol1hUsd?: number;
  /** alamat(lowercase) → simbol. DexScreener memakai base/quote miliknya sendiri,
   *  yang TIDAK selalu sama urutannya dengan token0/token1 pool — jadi simbol
   *  harus dicocokkan lewat alamat, bukan lewat posisi. */
  symByAddr: Record<string, string>;
};

async function dexPairs(ctx: ChainCtx, tokenAddress: string): Promise<DexPair[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let json: any;
  try {
    const res = await fetch(`${DEXSCREENER_TOKENS}/${tokenAddress}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const out: DexPair[] = [];
  for (const p of json?.pairs ?? []) {
    if (p?.chainId !== ctx.dexKey) continue;
    if (!(p?.labels ?? []).includes('v3')) continue; // v2 tak punya rentang → bukan single-side
    // liquidity.usd BOLEH kosong: DexScreener kadang tak mengisinya untuk pool v3
    // yang sah. Membuangnya di sini pernah membuat pool nyata dilaporkan 'tak ada'.
    const liq = Number(p?.liquidity?.usd ?? 0);
    if (!p.pairAddress) continue;
    const symByAddr: Record<string, string> = {};
    for (const t of [p?.baseToken, p?.quoteToken]) {
      if (t?.address) symByAddr[String(t.address).toLowerCase()] = t.symbol ?? '?';
    }
    out.push({
      pairAddress: p.pairAddress,
      liquidityUsd: liq,
      vol24hUsd: Number(p?.volume?.h24 ?? 0),
      vol1hUsd: Number(p?.volume?.h1 ?? 0),
      symByAddr,
    });
  }
  return out;
}

/** Baca fee & pasangan pool on-chain, lalu BUKTIKAN pool itu milik factory chain ini. */
async function verifyPool(
  pairAddress: string,
  ctx: ChainCtx,
): Promise<{ fee: number; token0: string; token1: string } | null> {
  try {
    const c = new ethers.Contract(pairAddress, POOL_META_ABI, ctx.provider);
    const [fee, token0, token1] = await Promise.all([c.fee(), c.token0(), c.token1()]);
    const feeNum = Number(fee);
    if (!ctx.feeTiers.includes(feeNum)) return null;
    const expect: string = await ctx.factory.getPool(token0, token1, feeNum);
    if (expect.toLowerCase() !== pairAddress.toLowerCase()) return null; // pool DEX lain
    return { fee: feeNum, token0, token1 };
  } catch {
    return null;
  }
}

const aprOf = (vol24h: number, fee: number, tvl: number): number | null =>
  tvl > 0 && vol24h > 0 ? ((vol24h * (fee / 1e6) * 365) / tvl) * 100 : null;

/**
 * Pool untuk 1 token di chain tanpa gateway Uniswap.
 *
 * SUMBER UTAMA = factory on-chain (getPool per base × per fee tier), bukan
 * DexScreener: terbukti DexScreener bisa mengembalikan pair v3 yang sah dengan
 * `liquidity: undefined` (token 黄金时代/USDT), dan menyaringnya membuat pool yang
 * benar-benar ada dilaporkan "tak ada". DexScreener hanya dipakai MELENGKAPI
 * volume 24 jam supaya APR bisa dihitung.
 */
async function poolsForTokenDex(ctx: ChainCtx, token: string): Promise<TokenPool[]> {
  // Volume per pool (best-effort) — kegagalannya tak boleh menghilangkan pool.
  const volByPool = new Map<string, number>();
  const symByAddr: Record<string, string> = {};
  try {
    for (const p of await dexPairs(ctx, token)) {
      volByPool.set(p.pairAddress.toLowerCase(), p.vol24hUsd);
      Object.assign(symByAddr, p.symByAddr);
    }
  } catch {
    /* tanpa DexScreener: pool tetap ketemu, APR-nya saja yang '?' */
  }

  const tokenC = new ethers.Contract(token, ERC20_SYM_ABI, ctx.provider);
  const otherSymbol = symByAddr[token.toLowerCase()] ?? (await tokenC.symbol().catch(() => '?'));
  const nativeUsd = await getBaseUsd(ctx);

  // Sapu SEMUA DEX yang bot punya kontraknya di chain ini: bawaan (undefined) +
  // tiap venue. Tanpa ini, di BSC hanya PancakeSwap yang terlihat, padahal Uniswap
  // v3 juga hidup di sana dengan factory sendiri — dan untuk sebagian token justru
  // hanya Uniswap yang punya pool.
  const venues: Array<string | undefined> = [undefined, ...venuesFor(ctx.key)];
  const found = await Promise.all(
    venues.flatMap((venue) => {
      const vctx = venueCtx(ctx, venue);
      return vctx.bases.flatMap((base) =>
        vctx.feeTiers.map(async (fee): Promise<TokenPool | null> => {
          try {
            const pool: string = await vctx.factory.getPool(base.address, token, fee);
            if (!pool || pool === ethers.ZeroAddress) return null;
            const baseC = new ethers.Contract(base.address, ERC20_BAL_ABI, vctx.provider);
            const reserve: bigint = await baseC.balanceOf(pool);
            if (reserve <= 0n) return null; // pool terdaftar tapi kosong
            const amt = Number(ethers.formatUnits(reserve, base.decimals));
            // TVL ≈ 2× sisi base (pool seimbang secara nilai). Stablecoin = $1.
            const usdPerBase = base.kind === 'weth' ? nativeUsd : 1;
            const tvlUsd = usdPerBase !== null ? amt * usdPerBase * 2 : 0;
            const vol = volByPool.get(pool.toLowerCase()) ?? 0;
            return {
              protocol: 'v3',
              base: base.kind,
              baseSymbol: base.symbol,
              otherSymbol: String(otherSymbol),
              fee,
              tvlUsd,
              vol24hUsd: vol,
              aprPct: aprOf(vol, fee, tvlUsd),
              ...(venue ? { venue } : {}),
            };
          } catch {
            return null;
          }
        }),
      );
    }),
  );
  const out = found.filter((p): p is TokenPool => p !== null);
  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return out;
}

/** Top pool chain (by APR) via DexScreener: pair paling likuid dari tiap aset base. */
async function fetchTopPoolsDex(ctx: ChainCtx, limit: number): Promise<ExplorePool[]> {
  const lists = await Promise.all(ctx.bases.map((b) => dexPairs(ctx, b.address).catch(() => [])));
  const seen = new Set<string>();
  const cand = lists
    .flat()
    .filter((p) => (seen.has(p.pairAddress.toLowerCase()) ? false : seen.add(p.pairAddress.toLowerCase())))
    .filter((p) => p.liquidityUsd >= MIN_TVL_USD && p.vol24hUsd > 0)
    // Urut by volume 24 jam, bukan likuiditas: pool TERLIKUID di BSC selalu
    // USDT/WBNB, jadi memilih by likuiditas membuat daftar habis oleh stablecoin
    // dan token yang benar-benar ramai tak pernah sampai ke kandidat.
    .sort((a, b) => b.vol24hUsd - a.vol24hUsd)
    .slice(0, 25); // batasi verifikasi on-chain
  const pools: ExplorePool[] = [];
  await Promise.all(
    cand.map(async (p) => {
      const v = await verifyPool(p.pairAddress, ctx);
      if (!v) return;
      const b0 = baseKindOf(null, v.token0, ctx);
      const b1 = baseKindOf(null, v.token1, ctx);
      if (!b0 && !b1) return;
      const apr = aprOf(p.vol24hUsd, v.fee, p.liquidityUsd);
      if (apr === null) return;
      const bothBase = !!b0 && !!b1;
      const otherAddr = bothBase ? undefined : b0 ? v.token1 : v.token0;
      const symOf = (a: string) => p.symByAddr[a.toLowerCase()] ?? '?';
      // Base ditaruh BELAKANG supaya terbaca "TOKEN/BASE", sama seperti jalur gateway.
      const pair = bothBase
        ? `${symOf(v.token0)}/${symOf(v.token1)}`
        : b0
          ? `${symOf(v.token1)}/${symOf(v.token0)}`
          : `${symOf(v.token0)}/${symOf(v.token1)}`;
      pools.push({
        ver: 'v3',
        pair,
        feeTier: v.fee,
        tvlUsd: p.liquidityUsd,
        vol1dUsd: p.vol24hUsd,
        vol1hUsd: p.vol1hUsd,
        apr,
        otherAddr,
      });
    }),
  );
  pools.sort((a, b) => b.apr - a.apr);
  return pools.slice(0, limit).map((p) => ({ ...p, chain: ctx.key, chainLabel: ctx.label }));
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

/** Kartu /pools — peringkat pool paling menguntungkan (naskah §4). */
export function renderExplore(pools: ExplorePool[], chainLabel: string, dexLabel = 'Uniswap', baseLabel = 'ETH/USDG'): string {
  if (pools.length === 0) {
    return [
      `📈 ${m.bold(`Top ${dexLabel} Pools (24H)`)}`,
      '',
      m.note(`No ${baseLabel} pool meets the criteria right now. Try again later.`),
      m.italic(m.nowWib()),
    ].join('\n');
  }

  const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const blocks = pools.map((p, i) => {
    // "Stable / Low Risk" HANYA untuk pool base-lawan-base (mis. WETH/USDG):
    // otherAddr kosong artinya kedua sisinya aset base kita. Menempelkan label itu
    // pada pool token biasa ber-APR rendah = klaim aman yang tak kita punya dasarnya.
    const stablePair = !p.otherAddr;
    const risk = stablePair
      ? `✅ ${m.italic('Stable / Low Risk')}`
      : p.apr >= 40
        ? `⚠️ ${m.italic('High Volatility')}`
        : `⚠️ ${m.italic('Volatile — impermanent loss risk')}`;
    return [
      `${medal[i] ?? `${i + 1}.`} ${m.bold(p.pair.replace('/', ' / '))} (${p.ver.toUpperCase()}, ${m.feeLabel(p.feeTier)})`,
      `• TVL: ${usdCompact(p.tvlUsd)} | APR: ${aprLabel(p.apr)}`,
      `• ${risk}`,
    ].join('\n');
  });

  return [
    `📈 ${m.bold(`Top ${dexLabel} Pools (24H)`)}`,
    '',
    'Here are the most profitable pools right now :',
    '',
    blocks.join('\n\n'),
    '',
    m.note(`top ${pools.length} by APR · single-sided ${baseLabel} · TVL ≥ $${(MIN_TVL_USD / 1000).toFixed(0)}K · APR = 24h fees annualised`),
    m.italic(`${chainLabel} · ${m.nowWib()}`),
  ].join('\n');
}

/** Penanda warna per chain — pembeda cepat di daftar gabungan. */
export const chainDot = (key?: string): string =>
  key === 'bsc' ? '🟡' : key === 'base' ? '🔵' : '🟣';

/**
 * Daftar pool "lagi rame" dari SEMUA chain sekaligus, dikelompokkan per chain.
 * Urutan di dalam grup: volume 24 jam (itu arti ramai), bukan APR — APR tinggi
 * di pool sepi cuma angka, tak ada yang menukar di sana.
 */
export function renderExploreAll(groups: Array<{ ctx: ChainCtx; pools: ExplorePool[] }>): string {
  const live = groups.filter((g) => g.pools.length > 0);
  if (live.length === 0) {
    return [
      `🔥 ${m.bold('Hot Pools (1H)')}`,
      '',
      m.note(`No pool traded ≥ $${(MIN_VOL_1H_USD / 1000).toFixed(0)}K in the last hour on any chain. Try again later.`),
      m.italic(m.nowWib()),
    ].join('\n');
  }

  const sections = live.map(({ ctx, pools }) => {
    const bases = ctx.bases.map((b) => b.symbol).join('/');
    const rows = pools.map((p, i) => {
      const risk = !p.otherAddr ? '✅' : p.apr >= 40 ? '⚠️' : '•';
      return [
        `${i + 1}. ${m.bold(p.pair.replace('/', ' / '))} ${m.italic(`(${p.ver.toUpperCase()}, ${m.feeLabel(p.feeTier)})`)}`,
        `   ${risk} 1h ${usdCompact(p.vol1hUsd ?? 0)} · 24h ${usdCompact(p.vol1dUsd)} · TVL ${usdCompact(p.tvlUsd)} · APR ${aprLabel(p.apr)}`,
      ].join('\n');
    });
    return [`${chainDot(ctx.key)} ${m.bold(ctx.label.toUpperCase())} ${m.italic(`· ${ctx.dexLabel} · ${bases}`)}`, ...rows].join('\n');
  });

  return [
    `🔥 ${m.bold('Hot Pools (1H)')}`,
    '',
    'Single-sided pools actually being traded right now:',
    '',
    sections.join('\n\n'),
    '',
    m.note(
      `sorted by 1h volume · 1h ≥ $${(MIN_VOL_1H_USD / 1000).toFixed(0)}K · TVL ≥ $${(MIN_TVL_USD / 1000).toFixed(0)}K · stablecoin pairs excluded`,
    ),
    m.italic(m.nowWib()),
  ].join('\n');
}

// ─── daftar "lagi rame": volume 1 JAM, tanpa pool stablecoin ────────

/** Ambang ramai: pool harus benar-benar ditukar SEKARANG, bukan kemarin. */
export const MIN_VOL_1H_USD = 80_000;

/**
 * Simbol yang dianggap stablecoin. Pool TOKEN/BASE yang sisi tokennya stablecoin
 * bukan peluang LP single-side — tak ada token yang mau dibeli di harga bawah,
 * cuma dolar ditukar dolar.
 */
const STABLE_SYMBOLS = new Set([
  'USDT', 'USDC', 'USDG', 'USDE', 'USD1', 'USDS', 'USDP', 'USDD', 'USDX',
  'DAI', 'BUSD', 'FDUSD', 'TUSD', 'PYUSD', 'FRAX', 'LUSD', 'GUSD', 'EURC',
  'USDT0', 'USDBC', 'CBBTC-USD',
]);
const isStableSymbol = (sym?: string): boolean => {
  if (!sym) return false;
  const u = sym.toUpperCase().replace(/^W/, '');
  return STABLE_SYMBOLS.has(u) || /^[A-Z]{0,3}USD[A-Z0-9]{0,2}$/.test(u);
};

/** Sisi non-base sebuah pool (pair ditulis "TOKEN/BASE"). */
const otherSymbolOf = (pair: string): string => pair.split('/')[0] ?? '';

/**
 * Isi vol1hUsd dari DexScreener. Gateway Uniswap hanya menyediakan volume 24 jam
 * (`duration: HOUR` ditolak server), jadi angka 1 jam harus dari sumber lain.
 * Pencocokan: pair DexScreener untuk token yang sama, versi sama, likuiditas
 * paling dekat dengan TVL gateway.
 */
async function enrichHourlyVolume(ctx: ChainCtx, pools: ExplorePool[]): Promise<void> {
  const tokens = [...new Set(pools.map((p) => p.otherAddr).filter(Boolean) as string[])];
  const byToken = new Map<string, any[]>();
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const res = await fetch(`${DEXSCREENER_TOKENS}/${t}`, { signal: AbortSignal.timeout(12_000) });
        if (!res.ok) return;
        const j: any = await res.json();
        byToken.set(t.toLowerCase(), (j?.pairs ?? []).filter((x: any) => x?.chainId === ctx.dexKey));
      } catch {
        /* satu token gagal → pool itu saja yang tak dapat angka 1 jam */
      }
    }),
  );
  for (const p of pools) {
    if (!p.otherAddr) continue;
    const cands = (byToken.get(p.otherAddr.toLowerCase()) ?? []).filter((x: any) =>
      (x?.labels ?? []).some((l: string) => l.toLowerCase() === p.ver.toLowerCase()),
    );
    if (!cands.length) continue;
    // TVL gateway vs likuiditas DexScreener: pool yang sama pasti paling dekat.
    const best = cands.reduce((a: any, b: any) =>
      Math.abs((a?.liquidity?.usd ?? 0) - p.tvlUsd) <= Math.abs((b?.liquidity?.usd ?? 0) - p.tvlUsd) ? a : b,
    );
    const v = Number(best?.volume?.h1 ?? NaN);
    if (Number.isFinite(v)) p.vol1hUsd = v;
  }
}

/** Pool yang benar-benar ramai 1 jam terakhir, bukan pool stablecoin. */
export async function fetchHotPools(ctx: ChainCtx, limit = 3): Promise<ExplorePool[]> {
  // Sumber utama Krystal: satu-satunya yang memberi volume 1 JAM asli (stats1h)
  // untuk ketiga chain. Gateway Uniswap menolak `duration: HOUR`, dan DexScreener
  // hanya membalas ~30 pair terlikuid per token — di BSC itu stablecoin semua.
  const fromKrystal = (
    await Promise.all(
      ctx.bases.map((b) => krystalPools(ctx, b.address, 2).catch(() => [] as TokenPool[])),
    )
  ).flat();

  const seen = new Set<string>();
  const pools: ExplorePool[] = [];
  for (const p of fromKrystal) {
    if (isStableSymbol(p.otherSymbol)) continue; // dolar ditukar dolar — bukan peluang LP
    if ((p.vol1hUsd ?? 0) < MIN_VOL_1H_USD) continue;
    if (p.tvlUsd < MIN_TVL_USD) continue;
    const k = `${p.protocol}:${p.venue ?? ''}:${p.baseSymbol}/${p.otherSymbol}:${p.fee}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pools.push({
      ver: p.protocol,
      pair: `${p.otherSymbol}/${p.baseSymbol}`,
      feeTier: p.fee,
      tvlUsd: p.tvlUsd,
      vol1dUsd: p.vol24hUsd ?? 0,
      vol1hUsd: p.vol1hUsd,
      apr: p.aprPct ?? 0,
      otherAddr: p.otherAddr,
      chain: ctx.key,
      chainLabel: ctx.label,
    });
  }
  if (pools.length > 0) {
    return pools.sort((a, b) => (b.vol1hUsd ?? 0) - (a.vol1hUsd ?? 0)).slice(0, limit);
  }

  // Krystal mati / chain tak didukung → jalur lama (gateway + volume 1 jam DexScreener).
  const cand = (await fetchTopPools(ctx, 40))
    .filter((p) => p.otherAddr)
    .filter((p) => !isStableSymbol(otherSymbolOf(p.pair)));
  await enrichHourlyVolume(ctx, cand);
  return cand
    .filter((p) => (p.vol1hUsd ?? 0) >= MIN_VOL_1H_USD)
    .sort((a, b) => (b.vol1hUsd ?? 0) - (a.vol1hUsd ?? 0))
    .slice(0, limit);
}
