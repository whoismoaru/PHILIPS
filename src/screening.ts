import { ethers } from 'ethers';
import { bold, code, esc, nowWib } from './messages.js';
import { getChain, basesFor, type ChainCtx } from './chains.js';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];
const BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const FEE_TIERS = [100, 500, 3000, 10000];
type SellStatus = 'ok' | 'blocked' | 'costly' | 'unknown';

/**
 * Simulasi JALUR JUAL (exit-liquidity) sebelum ber-LP: round-trip via Quoter
 * (base → token → base) di pool base terdalam. Menangkap: tak ada jalur jual
 * (sell revert = token tak bisa dijual) & jual sangat boros (likuiditas tipis).
 * Parity dgn pola bot lain ("buy→sell via Quoter, revert = blocked").
 * CATATAN: Quoter menghitung math pool, TIDAK mengeksekusi transfer token —
 * pajak-jual/transfer-block murni tak selalu tertangkap (itu enhancement
 * stateOverride mendatang). Read-only, fail-open (error → 'unknown', tak blokir).
 */
async function simulateSellPath(
  tokenAddress: string,
  ctx: ChainCtx,
): Promise<{ status: SellStatus; flag: Flag | null }> {
  try {
    // Pool base terdalam untuk token ini.
    type Cand = { baseAddr: string; decimals: number; fee: number; reserve: bigint };
    // Semua (base × fee) diperiksa serentak — deteksi pool terdalam tanpa loop beruntun.
    const cands = await Promise.all(
      basesFor(ctx).flatMap((base) => {
        const baseC = new ethers.Contract(base.address, BAL_ABI, ctx.provider);
        return FEE_TIERS.map(async (fee): Promise<Cand | null> => {
          const pool: string = await ctx.factory.getPool(base.address, tokenAddress, fee);
          if (!pool || pool === ethers.ZeroAddress) return null;
          const reserve: bigint = await baseC.balanceOf(pool);
          return { baseAddr: base.address, decimals: base.decimals, fee, reserve };
        });
      }),
    );
    let best: Cand | null = null;
    for (const c of cands) if (c && (!best || c.reserve > best.reserve)) best = c;
    if (!best || best.reserve === 0n) return { status: 'unknown', flag: null };

    const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, ctx.provider);
    // Probe kecil relatif pool (kurangi price-impact palsu).
    const probe = best.decimals >= 18 ? '0.01' : '10';
    const baseIn = ethers.parseUnits(probe, best.decimals);

    let tokenOut: bigint;
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: best.baseAddr, tokenOut: tokenAddress, amountIn: baseIn, fee: best.fee, sqrtPriceLimitX96: 0n,
      });
      tokenOut = BigInt(q[0]);
    } catch {
      return { status: 'unknown', flag: null }; // gagal quote BELI → jangan blokir
    }
    if (tokenOut === 0n) return { status: 'unknown', flag: null };

    let baseBack: bigint;
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenAddress, tokenOut: best.baseAddr, amountIn: tokenOut, fee: best.fee, sqrtPriceLimitX96: 0n,
      });
      baseBack = BigInt(q[0]);
    } catch {
      return { status: 'blocked', flag: { level: 'BAHAYA', msg: 'Simulasi JUAL gagal (revert) — token mungkin tak bisa dijual' } };
    }
    if (baseBack === 0n)
      return { status: 'blocked', flag: { level: 'BAHAYA', msg: 'Simulasi jual hasil 0 — tak ada jalur keluar' } };

    const loss = 1 - Number(baseBack) / Number(baseIn);
    const feeRoundtrip = (2 * best.fee) / 1_000_000; // 3000 → 0.006
    if (loss > Math.max(0.2, feeRoundtrip * 4))
      return {
        status: 'costly',
        flag: { level: 'HATI-HATI', msg: `Jual boros ~${(loss * 100).toFixed(0)}% (round-trip) — likuiditas tipis` },
      };
    return { status: 'ok', flag: null };
  } catch {
    return { status: 'unknown', flag: null }; // fail-open
  }
}

/**
 * Screening token anti-anomali sebelum ber-LP.
 * Sumber data: Blockscout (explorer resmi Robinhood Chain) + DexScreener.
 * Semua bersifat heuristik — BUKAN jaminan aman, tapi menangkap pola scam umum.
 */

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';

type Level = 'BAHAYA' | 'HATI-HATI' | 'INFO';
export type Flag = { level: Level; msg: string };

export type ScreenResult = {
  ok: boolean;
  name: string;
  symbol: string;
  verified: boolean | null;
  isProxy: boolean;
  holdersCount: number | null;
  top1Pct: number | null;
  top10Pct: number | null;
  top1IsContract: boolean;
  liquidityUsd: number | null;
  volume24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  priceUsd: string | null;
  marketCapUsd: number | null; // dari DexScreener (marketCap, fallback fdv)
  pairAgeHours: number | null;
  renounced: boolean | null; // null = tak bisa ditentukan (owner() tak ada / RPC gagal)
  sellPath: SellStatus; // simulasi jalur jual (exit-liquidity)
  flags: Flag[];
  verdict: 'AMAN' | 'HATI-HATI' | 'BAHAYA';
};

// Cache off-chain read (Blockscout/DexScreener) per-URL. Data screening bersifat
// advisory & tak berubah detik-ke-detik; /add ulang token sama jadi instan.
// Sell-path (quoter on-chain) TIDAK lewat sini → tetap live.
const _jsonCache = new Map<string, { t: number; v: any }>();
const JSON_TTL = 60_000;

async function fetchJson(url: string): Promise<any | null> {
  const hit = _jsonCache.get(url);
  if (hit && Date.now() - hit.t < JSON_TTL) return hit.v;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000); // cap worst-case; fail-open (null) sudah ditangani
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const v = await res.json();
    _jsonCache.set(url, { t: Date.now(), v });
    return v;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function worst(flags: Flag[]): ScreenResult['verdict'] {
  if (flags.some((f) => f.level === 'BAHAYA')) return 'BAHAYA';
  if (flags.some((f) => f.level === 'HATI-HATI')) return 'HATI-HATI';
  return 'AMAN';
}

/**
 * Apakah kepemilikan kontrak sudah dilepas? Dibaca dari owner()/getOwner().
 * null = TAK BISA DITENTUKAN (fungsinya tak ada, atau RPC gagal) — jangan pernah
 * dianggap aman: kartu menampilkannya sebagai '?', bukan centang.
 */
async function readRenounced(addr: string, ctx: ChainCtx): Promise<boolean | null> {
  const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
  for (const fn of ['owner', 'getOwner']) {
    try {
      const c = new ethers.Contract(addr, [`function ${fn}() view returns (address)`], ctx.provider);
      const o: string = await c[fn]();
      return DEAD.has(o.toLowerCase());
    } catch {
      /* coba nama berikutnya */
    }
  }
  return null; // tak ada owner() yang bisa dibaca
}

export async function screenToken(
  tokenAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<ScreenResult> {
  const addr = ethers.getAddress(tokenAddress);
  const flags: Flag[] = [];
  const bs = ctx.blockscout; // null = explorer tak tersedia (mis. BSC)

  // Jalankan semua permintaan sekaligus (termasuk simulasi jalur jual on-chain).
  const [tokenInfo, holders, contract, dex, sell, renounced] = await Promise.all([
    bs ? fetchJson(`${bs}/tokens/${addr}`) : Promise.resolve(null),
    bs ? fetchJson(`${bs}/tokens/${addr}/holders`) : Promise.resolve(null),
    bs ? fetchJson(`${bs}/smart-contracts/${addr}`) : Promise.resolve(null),
    fetchJson(`${DEXSCREENER}/${addr}`),
    simulateSellPath(addr, ctx),
    readRenounced(addr, ctx),
  ]);
  if (sell.flag) flags.push(sell.flag);

  const dexBase = (dex?.pairs ?? []).find(
    (p: any) => p.chainId === ctx.dexKey && (p.baseToken?.address || '').toLowerCase() === addr.toLowerCase(),
  )?.baseToken;
  const name = tokenInfo?.name ?? dexBase?.name ?? 'Tidak diketahui';
  const symbol = tokenInfo?.symbol ?? dexBase?.symbol ?? '???';
  const holdersCount = tokenInfo?.holders_count ? Number(tokenInfo.holders_count) : null;
  const totalSupply = tokenInfo?.total_supply ? BigInt(tokenInfo.total_supply) : null;

  // --- Verifikasi kontrak ---
  let verified: boolean | null = null;
  let isProxy = false;
  if (contract) {
    verified = Boolean(contract.source_code || contract.is_verified || contract.is_fully_verified);
    isProxy = Boolean(
      contract.proxy_type ||
        (Array.isArray(contract.implementations) && contract.implementations.length > 0) ||
        /proxy/i.test(contract.name ?? ''),
    );
  } else {
    // Tanpa explorer (BSC) verifikasi tak bisa dicek → null, jangan flag palsu.
    verified = bs ? false : null;
  }
  if (verified === false) flags.push({ level: 'HATI-HATI', msg: 'Kontrak TIDAK terverifikasi (tak bisa audit kode)' });
  if (isProxy) flags.push({ level: 'INFO', msg: 'Kontrak upgradeable (proxy) — dev bisa ubah logika' });

  // --- Konsentrasi holder ---
  let top1Pct: number | null = null;
  let top10Pct: number | null = null;
  let top1IsContract = false;
  const items: any[] = holders?.items ?? [];
  if (items.length > 0 && totalSupply && totalSupply > 0n) {
    const val = (h: any) => {
      try {
        return BigInt(h.value ?? '0');
      } catch {
        return 0n;
      }
    };
    top1IsContract = Boolean(items[0]?.address?.is_contract);
    top1Pct = Number((val(items[0]) * 10000n) / totalSupply) / 100;
    const sum10 = items.slice(0, 10).reduce((a, h) => a + val(h), 0n);
    top10Pct = Number((sum10 * 10000n) / totalSupply) / 100;

    if (top1Pct > 50 && !top1IsContract)
      flags.push({ level: 'BAHAYA', msg: `1 dompet menguasai ${top1Pct.toFixed(1)}% supply` });
    else if (top10Pct > 90)
      flags.push({ level: 'HATI-HATI', msg: `10 dompet teratas menguasai ${top10Pct.toFixed(1)}% supply` });
  }
  if (holdersCount !== null && holdersCount < 30)
    flags.push({ level: 'HATI-HATI', msg: `Holder sangat sedikit (${holdersCount})` });

  // --- Data pasar (DexScreener) ---
  let liquidityUsd: number | null = null;
  let volume24h: number | null = null;
  let buys24h: number | null = null;
  let sells24h: number | null = null;
  let priceUsd: string | null = null;
  let marketCapUsd: number | null = null;
  let pairAgeHours: number | null = null;

  // Hanya pair di chain yang sama (alamat token bisa eksis di banyak chain).
  const pairs: any[] = (dex?.pairs ?? []).filter((p: any) => p.chainId === ctx.dexKey);
  if (pairs.length > 0) {
    // Ambil pair paling likuid.
    const p = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    liquidityUsd = p.liquidity?.usd ?? null;
    volume24h = p.volume?.h24 ?? null;
    buys24h = p.txns?.h24?.buys ?? null;
    sells24h = p.txns?.h24?.sells ?? null;
    priceUsd = p.priceUsd ?? null;
    marketCapUsd = p.marketCap ?? p.fdv ?? null;
    if (p.pairCreatedAt) pairAgeHours = (Date.now() - p.pairCreatedAt) / 3_600_000;

    if (liquidityUsd !== null && liquidityUsd < 2000)
      flags.push({ level: 'BAHAYA', msg: `Likuiditas sangat tipis ($${Math.round(liquidityUsd)})` });
    else if (liquidityUsd !== null && liquidityUsd < 20000)
      flags.push({ level: 'HATI-HATI', msg: `Likuiditas rendah ($${Math.round(liquidityUsd)})` });

    if (pairAgeHours !== null && pairAgeHours < 24)
      flags.push({ level: 'HATI-HATI', msg: `Pool sangat baru (${pairAgeHours.toFixed(0)} jam)` });

    if (buys24h !== null && sells24h !== null && buys24h > 20 && sells24h === 0)
      flags.push({ level: 'BAHAYA', msg: 'Banyak beli tapi ~0 jual — indikasi honeypot' });

    if (volume24h !== null && volume24h < 1000)
      flags.push({ level: 'HATI-HATI', msg: 'Nyaris tanpa transaksi 24 jam' });
  } else {
    flags.push({ level: 'HATI-HATI', msg: 'Tidak ada data pasar/likuiditas di DexScreener' });
  }

  return {
    ok: true,
    name,
    symbol,
    verified,
    isProxy,
    holdersCount,
    top1Pct,
    top10Pct,
    top1IsContract,
    liquidityUsd,
    volume24h,
    buys24h,
    sells24h,
    priceUsd,
    marketCapUsd,
    pairAgeHours,
    renounced,
    sellPath: sell.status,
    flags,
    verdict: worst(flags),
  };
}

/** Susun laporan screening jadi teks siap kirim ke Telegram. */
const ethUsdCache = new Map<string, { v: number | null; t: number }>();

/** Harga native (ETH/BNB) dalam USD via DexScreener, per chain (cache 60 dtk). */
export async function getEthUsd(
  wethAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<number | null> {
  const cached = ethUsdCache.get(ctx.key);
  if (cached && Date.now() - cached.t < 60_000) return cached.v;
  const dex = await fetchJson(`${DEXSCREENER}/${wethAddress}`);
  const pairs: any[] = (dex?.pairs ?? []).filter((p: any) => p.chainId === ctx.dexKey);
  const w = wethAddress.toLowerCase();
  let best: number | null = null;
  let bestLiq = -1;
  for (const p of pairs) {
    const liq = p.liquidity?.usd ?? 0;
    let eu: number | null = null;
    if ((p.baseToken?.address || '').toLowerCase() === w) {
      eu = Number(p.priceUsd);
    } else if ((p.quoteToken?.address || '').toLowerCase() === w) {
      const pn = Number(p.priceNative);
      const pu = Number(p.priceUsd);
      if (pn > 0) eu = pu / pn;
    }
    if (eu && isFinite(eu) && eu > 0 && liq > bestLiq) {
      best = eu;
      bestLiq = liq;
    }
  }
  ethUsdCache.set(ctx.key, { v: best, t: Date.now() });
  return best;
}

/**
 * Kartu DETAIL TOKEN setelah screening.
 *
 * ATURAN YANG TAK BOLEH DILANGGAR: field yang TIDAK PUNYA sumber data ditulis '?',
 * bukan centang. Menampilkan "Renounced ✓" untuk sesuatu yang tak pernah diperiksa
 * adalah klaim keamanan palsu — itu justru jenis kebohongan yang membuat orang
 * masuk ke token yang salah.
 *
 * Sumber nyata saat ini: DexScreener (harga, MC, Liq, Vol, umur pool), Blockscout
 * (holders, konsentrasi, verifikasi), on-chain (owner() untuk renounced, simulasi
 * jalur jual untuk honeypot). Sisanya belum punya sumber di chain ini.
 */
export function formatScreen(s: ScreenResult, opts?: { ca?: string; chainLabel?: string; heldLabel?: string | null; lpCount?: number }): string {
  const UNK = '?';
  const compact = (n: number | null): string => {
    if (n === null) return UNK;
    const a = Math.abs(n);
    if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${n.toFixed(0)}`;
  };
  const pct = (n: number | null): string => (n === null ? UNK : `${Number(n.toFixed(2))}%`);
  const mark = (v: boolean | null): string => (v === null ? UNK : v ? '✓' : '✗');

  const price = s.priceUsd ? `$${s.priceUsd}` : UNK;
  const holders = s.holdersCount === null ? UNK : s.holdersCount.toLocaleString('en-US');
  const pool = s.pairAgeHours === null ? UNK : `${Math.round(s.pairAgeHours)} jam`;
  // Honeypot dibaca dari simulasi jalur jual: 'ok' = bisa dijual, 'blocked' = TIDAK bisa.
  const noHoney = s.sellPath === 'ok' ? '✓' : s.sellPath === 'blocked' ? '✗' : UNK;

  const head = `${bold('$' + esc(s.symbol.toUpperCase()))}${opts?.chainLabel ? ` | ${esc(opts.chainLabel)}` : ''}`;

  const out = [
    head,
    '',
    `${price} · MC ${compact(s.marketCapUsd)} · Liq ${compact(s.liquidityUsd)}`,
    `Vol ${compact(s.volume24h)} · Holders ${holders} · Tax ${UNK}/${UNK}`,
    `Top 10 ${pct(s.top10Pct)} · DEV ${UNK} · Insiders ${UNK}`,
    `Sniper ${UNK} · Bundler ${UNK} · Dex Paid ${UNK}`,
    `Pool ${pool} · LP Locked ${UNK} · Cluster ${UNK}`,
    `NoHoneypot ${noHoney} · Phishing ${UNK} · Verified ${mark(s.verified)} · Renounced ${mark(s.renounced)} · Burnt ${UNK}`,
  ];

  if (opts?.ca) out.push('', code(opts.ca));

  const held = opts?.heldLabel ? `Dipegang ${esc(opts.heldLabel)}` : 'Belum dipegang';
  const lp = opts?.lpCount ? `${opts.lpCount} LP aktif` : 'Belum ber-LP';
  out.push('', `${held} & ${lp}`);
  if (!opts?.heldLabel && !opts?.lpCount) out.push('→ Bisa mulai dari Buka LP / Beli');

  // Verdict & flags TETAP ada: kartu ini menggantikan tampilan, bukan peringatannya.
  const risk = s.flags.filter((f) => f.level === 'BAHAYA' || f.level === 'HATI-HATI');
  if (s.verdict !== 'AMAN' || risk.length) {
    out.push('', `${s.verdict === 'BAHAYA' ? '🔴' : '⚠️'} ${bold(s.verdict)}`);
    for (const f of risk.slice(0, 4)) out.push(`• ${esc(f.msg)}`);
  } else {
    out.push('', `🟢 ${bold('AMAN')}`);
  }

  out.push('', nowWib());
  return out.join('\n');
}

