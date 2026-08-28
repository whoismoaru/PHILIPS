import { ethers } from 'ethers';
import { bold, code, esc, italic, nowWib } from './messages.js';
import { getChain, basesFor, type ChainCtx } from './chains.js';
import { EXPLORER_HEADERS } from './chain.js';
import { gmgnExtra, gmgnPrice, type GmgnExtra } from './gmgn.js';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];
const BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const FEE_TIERS = [100, 500, 2500, 3000, 10000]; // gabungan Uniswap + PancakeSwap; pool yang tak ada dilewati
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
      return { status: 'blocked', flag: { level: 'BAHAYA', msg: 'Sell simulation reverted — this token may be unsellable' } };
    }
    if (baseBack === 0n)
      return { status: 'blocked', flag: { level: 'BAHAYA', msg: 'Sell simulation returned 0 — no exit route' } };

    const loss = 1 - Number(baseBack) / Number(baseIn);
    const feeRoundtrip = (2 * best.fee) / 1_000_000; // 3000 → 0.006
    if (loss > Math.max(0.2, feeRoundtrip * 4))
      return {
        status: 'costly',
        flag: { level: 'HATI-HATI', msg: `Round-trip loss ~${(loss * 100).toFixed(0)}% — thin liquidity` },
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
  gmgn: GmgnExtra | null; // pengisi celah dari GMGN; null = tak dipanggil/gagal
  sellPath: SellStatus; // simulasi jalur jual (exit-liquidity)
  flags: Flag[];
  verdict: 'AMAN' | 'HATI-HATI' | 'BAHAYA';
};

// Cache off-chain read (Blockscout/DexScreener) per-URL. Data screening bersifat
// advisory & tak berubah detik-ke-detik; /add ulang token sama jadi instan.
// Sell-path (quoter on-chain) TIDAK lewat sini → tetap live.
const _jsonCache = new Map<string, { t: number; v: any }>();
const JSON_TTL = 60_000;

/**
 * Buang cache off-chain untuk satu token — dipakai tombol Refresh kartu audit.
 *
 * Tanpa ini, menekan Refresh dalam 60 detik mengembalikan angka yang sama persis:
 * cache-nya yang menjawab, bukan jaringannya. Refresh yang tak me-refresh apa pun
 * lebih buruk daripada tak ada tombol.
 */
export function bustScreenCache(addr: string): void {
  const a = addr.toLowerCase();
  for (const k of [..._jsonCache.keys()]) if (k.toLowerCase().includes(a)) _jsonCache.delete(k);
}

async function fetchJson(url: string): Promise<any | null> {
  const hit = _jsonCache.get(url);
  if (hit && Date.now() - hit.t < JSON_TTL) return hit.v;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000); // cap worst-case; fail-open (null) sudah ditangani
  try {
    const res = await fetch(url, { headers: EXPLORER_HEADERS, signal: ctrl.signal });
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
  const [tokenInfo, holders, contract, dex, sell, renounced, gmgn] = await Promise.all([
    bs ? fetchJson(`${bs}/tokens/${addr}`) : Promise.resolve(null),
    bs ? fetchJson(`${bs}/tokens/${addr}/holders`) : Promise.resolve(null),
    bs ? fetchJson(`${bs}/smart-contracts/${addr}`) : Promise.resolve(null),
    fetchJson(`${DEXSCREENER}/${addr}`),
    simulateSellPath(addr, ctx),
    readRenounced(addr, ctx),
    gmgnExtra(addr, ctx.key).catch(() => null), // fail-open: data tambahan
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
  if (verified === false) flags.push({ level: 'HATI-HATI', msg: 'Contract is NOT verified (source code unavailable)' });
  if (isProxy) flags.push({ level: 'INFO', msg: 'Upgradeable contract (proxy) — the dev can change its logic' });

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

    // Konsentrasi 10 teratas ditangani di bawah (butuh angka GMGN yang lebih
    // bersih); di sini hanya dompet TUNGGAL yang menguasai mayoritas.
    if (top1Pct > 50 && !top1IsContract)
      flags.push({ level: 'BAHAYA', msg: `One wallet holds ${top1Pct.toFixed(1)}% of supply` });
  }
  if (holdersCount !== null && holdersCount < 30)
    flags.push({ level: 'HATI-HATI', msg: `Very few holders (${holdersCount})` });

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
      flags.push({ level: 'BAHAYA', msg: `Very thin liquidity ($${Math.round(liquidityUsd)})` });
    else if (liquidityUsd !== null && liquidityUsd < 20000)
      flags.push({ level: 'HATI-HATI', msg: `Low liquidity ($${Math.round(liquidityUsd)})` });

    if (pairAgeHours !== null && pairAgeHours < 24)
      flags.push({ level: 'HATI-HATI', msg: `Pool is very new (${pairAgeHours.toFixed(0)}h old)` });

    if (buys24h !== null && sells24h !== null && buys24h > 20 && sells24h === 0)
      flags.push({ level: 'BAHAYA', msg: 'Many buys but almost no sells — possible honeypot' });

    if (volume24h !== null && volume24h < 1000)
      flags.push({ level: 'HATI-HATI', msg: 'Almost no trades in the last 24h' });
  } else {
    flags.push({ level: 'HATI-HATI', msg: 'No market or liquidity data on DexScreener' });
  }

  // Konsentrasi 10 dompet teratas. Diperiksa DI SINI (bukan di blok holders
  // Blockscout) karena angka GMGN baru tersedia setelah await di atas — dan
  // angka GMGN-lah yang dipakai kartu: Blockscout menghitung kontrak pool
  // sebagai 'holder' sehingga persennya melambung (41,27% vs 16,72% pada CA
  // yang sama). Ambang 50% = HATI-HATI: LP tetap boleh, vonis turun jadi
  // "SAFE TO LP (Moderate Risk)" supaya keputusannya tetap di tangan user.
  const top10Concentration = gmgn?.top10Pct ?? top10Pct;
  if (top10Concentration !== null && top10Concentration >= 50) {
    flags.push({
      level: 'HATI-HATI',
      msg: `Top 10 wallets hold ${top10Concentration.toFixed(1)}% of supply`,
    });
  }

  // Buta BUKAN berarti aman. Flag hanya ditambahkan saat data ADA dan buruk;
  // kalau sumbernya diam (Blockscout tak tersedia di BSC, GMGN kena rate-limit),
  // semua pemeriksaan itu lewat tanpa suara dan vonisnya jadi "SAFE TO LP" —
  // padahal justru tak ada yang diperiksa. Turunkan vonisnya dan sebutkan apa
  // yang tak terbaca, supaya user memutuskan dengan tahu ia sedang buta.
  const takTerbaca = [
    top10Concentration === null && 'holder concentration',
    verified === null && 'contract verification',
    (gmgn?.buyTaxPct ?? null) === null && 'buy/sell tax',
    (gmgn?.lpLockedPct ?? null) === null && 'liquidity lock',
  ].filter(Boolean) as string[];
  if (takTerbaca.length >= 3) {
    flags.push({
      level: 'HATI-HATI',
      msg: `${takTerbaca.length} safety checks unreadable (${takTerbaca.slice(0, 2).join(', ')}…) — not verified as safe`,
    });
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
    gmgn,
    sellPath: sell.status,
    flags,
    verdict: worst(flags),
  };
}

/** Susun laporan screening jadi teks siap kirim ke Telegram. */
const ethUsdCache = new Map<string, { v: number | null; t: number }>();

/**
 * Harga PASAR token dalam native (ETH per token) dari pair DexScreener ber-liq
 * TERDALAM di chain ini. Dipakai buat cek apakah pool v4 sebuah posisi
 * "sekarat" (harga on-chain-nya melenceng jauh dari pasar). null = tak terbaca.
 */
const tokenEthCache = new Map<string, { v: number | null; t: number }>();
export async function getTokenEthPrice(tokenAddress: string, ctx: ChainCtx = getChain()): Promise<number | null> {
  const key = `${ctx.key}:${tokenAddress.toLowerCase()}`;
  const cached = tokenEthCache.get(key);
  if (cached && Date.now() - cached.t < 60_000) return cached.v;
  const dex = await fetchJson(`${DEXSCREENER}/${tokenAddress}`);
  const w = ctx.wethAddress.toLowerCase();
  const isEthQuote = (a: string) => a === '0x0000000000000000000000000000000000000000' || a.toLowerCase() === w;
  const t = tokenAddress.toLowerCase();
  let best: number | null = null;
  let bestLiq = -1;
  for (const p of (dex?.pairs ?? []) as any[]) {
    if (p.chainId !== ctx.dexKey) continue;
    const liq = p.liquidity?.usd ?? 0;
    let ethPerTok: number | null = null;
    // base=token, quote=ETH → priceNative = ETH per token (langsung).
    if ((p.baseToken?.address || '').toLowerCase() === t && isEthQuote(p.quoteToken?.address || '')) {
      const pn = Number(p.priceNative);
      if (pn > 0) ethPerTok = pn;
    }
    if (ethPerTok && isFinite(ethPerTok) && liq > bestLiq) {
      best = ethPerTok;
      bestLiq = liq;
    }
  }
  tokenEthCache.set(key, { v: best, t: Date.now() });
  return best;
}

/** Harga native (ETH/BNB) dalam USD. DexScreener UTAMA (HTTP ~60ms), GMGN FALLBACK
 *  (subprocess ~470ms — cuma dipakai kalau DexScreener gagal, biar command gak molor).
 *  Cache 60 dtk. */
export async function getEthUsd(
  wethAddress: string,
  ctx: ChainCtx = getChain(),
): Promise<number | null> {
  const cached = ethUsdCache.get(ctx.key);
  if (cached && Date.now() - cached.t < 60_000) return cached.v;
  const w = wethAddress.toLowerCase();
  // Harga WETH dari pool ter-likuid: base=WETH → priceUsd; quote=WETH → priceUsd/priceNative.
  const pick = (pairs: any[]): number | null => {
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
    return best;
  };
  // 1) Endpoint CHAIN-SCOPED: cuma pair chain ini → anti-tabrakan alamat. WETH OP-stack
  //    (0x4200..0006) sama di Base/Ink/Soneium; endpoint tokens/ lintas-chain bikin
  //    pair chain kecil (Ink) kegencet keluar → harga null. Chain-scoped menghindarinya.
  const scoped = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${ctx.dexKey}/${wethAddress}`);
  let best = pick(Array.isArray(scoped) ? scoped : (scoped?.pairs ?? []));
  // 2) Fallback: endpoint tokens/ lama, difilter dexKey (mis. Robinhood yg tak ada di
  //    token-pairs/v1). Menjaga chain yang sebelumnya sudah benar tetap benar.
  if (best === null) {
    const dex = await fetchJson(`${DEXSCREENER}/${wethAddress}`);
    best = pick((dex?.pairs ?? []).filter((p: any) => p.chainId === ctx.dexKey));
  }
  // FALLBACK: DexScreener kosong/down → GMGN (chain didukung: robinhood/bsc/base).
  if (best === null) {
    const g = await gmgnPrice(wethAddress, ctx.key).catch(() => null);
    if (g && g.priceUsd > 0) best = g.priceUsd;
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
  // Jawaban ya/tidak: '?' bila datanya memang tak terbaca — JANGAN mengarang '✅'.
  const yes = (v: boolean | null): string => (v === null ? `${UNK} unreadable` : v ? '✅ Yes' : '❌ No');
  const no = (v: boolean | null): string => (v === null ? `${UNK} unreadable` : v ? '⚠️ Yes' : '✅ No');

  const g = s.gmgn;
  const symUp = s.symbol.toUpperCase().replace(/^\$+/, '');

  // NoHoneypot: simulasi jalur jual PHILIPS lebih dipercaya (on-chain, live) —
  // GMGN dipakai hanya bila simulasi tak memberi jawaban.
  const sellable =
    s.sellPath === 'ok' ? true : s.sellPath === 'blocked' ? false : g?.honeypot == null ? null : !g.honeypot;

  // Top 10: UTAMAKAN GMGN. Angka Blockscout menghitung kontrak pool sebagai
  // 'holder' sehingga melambung (terukur 41.27% vs 16.72% pada CA yang sama).
  const top10 = g?.top10Pct != null ? g.top10Pct : s.top10Pct;
  const top10Line =
    top10 === null ? UNK : `${pct(top10)} ${top10 >= 50 ? '🔴 (high whale risk)' : top10 >= 20 ? '⚠️ (moderate whale risk)' : '✅'}`;
  const verified = s.verified !== null ? s.verified : (g?.openSource ?? null);
  const renounced = s.renounced !== null ? s.renounced : (g?.renounced ?? null);
  const taxLine = (n: number | null): string => (n === null ? UNK : `${Number(n.toFixed(1))}% ${n <= 5 ? '✅' : n <= 10 ? '⚠️' : '🔴'}`);
  const lpLocked = g?.lpLockedPct ?? null;
  const burnt = g?.burntPct ?? null;

  const num = (n: number | null): string => (n === null ? UNK : n.toLocaleString('en-US'));

  // Pausable / cooldown: GMGN mengirim daftar privilege owner. Daftar KOSONG =
  // jawaban 'tak ada', bukan 'tak tahu'; payload tak terbaca (null) tetap '?'.
  const privHas = (re: RegExp): boolean | null =>
    g?.privileges == null ? null : g.privileges.some((p) => re.test(p));

  const out: string[] = [
    bold('TOKEN SECURITY AUDIT'),
    '',
    `📊 ${bold('Basic Info :')}`,
    `- Name: ${esc(s.name)} (${esc(symUp)})`,
    `- Network: ${esc(opts?.chainLabel ?? UNK)}`,
    `- Price: ${bold(s.priceUsd ? `$${s.priceUsd}` : UNK)} · MC: ${compact(s.marketCapUsd)}`,
    `- Pool Age: ${s.pairAgeHours === null ? UNK : `${Math.round(s.pairAgeHours)} hours`}`,
    '',
    `🛡 ${bold('Contract Security :')}`,
    `- Ownership Renounced: ${yes(renounced)}`,
    `- Contract Verified: ${yes(verified)}`,
    `- Proxy Contract: ${no(s.isProxy)}`,
    `- Honeypot Risk (Can sell?): ${sellable === null ? `${UNK} unreadable` : sellable ? '✅ Safe' : '🚫 Cannot sell'}`,
    `- Transfer Pause: ${no(privHas(/paus|freeze/))}`,
    `- Trading Cooldown: ${no(privHas(/cooldown/))}`,
    '',
    `💧 ${bold('Liquidity & Market :')}`,
    `- Total Liquidity: ${bold(compact(s.liquidityUsd))}`,
    `- Liquidity Locked: ${lpLocked === null ? UNK : `${pct(lpLocked)} ${lpLocked >= 50 ? '✅' : '⚠️'}`}${burnt ? ` · burnt ${pct(burnt)}` : ''}`,
    `- 24H Volume: ${compact(s.volume24h)} (${num(s.buys24h)} Buys / ${num(s.sells24h)} Sells)`,
    `- Top 10 Holders: ${top10Line}`,
  ];

  // Dev & insider digabung satu baris (naskah). Jumlahnya TIDAK dijumlahkan —
  // dompet dev bisa ikut terhitung sebagai insider, jadi menambahkannya melebihkan.
  if (g && (g.devPct !== null || g.insidersPct !== null)) {
    const worst = Math.max(g.devPct ?? 0, g.insidersPct ?? 0);
    out.push(
      `- Dev &amp; Insiders: dev ${pct(g.devPct)} · insiders ${pct(g.insidersPct)} ${worst >= 20 ? '🔴' : worst >= 5 ? '⚠️' : '✅'}`,
    );
  }

  out.push(
    '',
    `💸 ${bold('Taxes / Fees :')}`,
    `- Buy Tax -> ${taxLine(g?.buyTaxPct ?? null)}`,
    `- Sell Tax -> ${taxLine(g?.sellTaxPct ?? null)}`,
  );

  // Baris vonis DIHAPUS atas permintaan pemilik (28 Agu 2026): kartunya kini hanya
  // menyajikan angka, penilaiannya diserahkan ke pembaca. `s.verdict` sendiri TETAP
  // dihitung dan tetap dipakai alur /add untuk MEMBLOKIR token bervonis BAHAYA —
  // yang hilang cuma tampilannya, bukan penjaganya.

  if (opts?.ca) out.push('', code(opts.ca));

  out.push(
    '',
    `-> Holding Token: ${bold(opts?.heldLabel ? esc(opts.heldLabel) : 'No')}`,
    `-> Active LP: ${bold(opts?.lpCount ? `${opts.lpCount} position(s)` : 'No')}`,
    '',
    nowWib(),
  );
  return out.join('\n');
}

