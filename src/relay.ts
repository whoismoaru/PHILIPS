import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';

/**
 * Swap token → ETH native di chain yang sama lewat Relay (relay.link).
 * Relay mengembalikan daftar langkah transaksi; kita eksekusi berurutan
 * (termasuk approve bila perlu).
 */

const RELAY_API = 'https://api.relay.link/quote';
export const NATIVE = '0x0000000000000000000000000000000000000000';

/** Swap same-chain lewat Relay: token → currency tujuan. */
export async function swapTokenViaRelay(
  tokenAddress: string,
  amountWei: bigint,
  destinationCurrency: string,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outWei: bigint }> {
  const wallet = ctx.wallet;
  const body = {
    user: wallet.address,
    recipient: wallet.address,
    originChainId: ctx.chainId,
    destinationChainId: ctx.chainId,
    originCurrency: ethers.getAddress(tokenAddress),
    destinationCurrency,
    amount: amountWei.toString(),
    tradeType: 'EXACT_INPUT',
  };

  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Relay quote failed (${res.status}): ${await res.text()}`);
  }
  const quote: any = await res.json();

  const txHashes: string[] = [];
  for (const step of quote.steps ?? []) {
    for (const item of step.items ?? []) {
      const d = item?.data;
      if (!d?.to) continue;
      // Jual token same-chain = ERC20 masuk, TAK ADA native. Step ber-value>0 itu
      // anomali (calldata relay tak terduga bisa kuras BNB/ETH) → tolak. Pemanggil
      // punya fallback Uniswap, jadi menolak di sini aman, bukan menggagalkan total.
      const value = d.value ? BigInt(d.value) : 0n;
      if (value > 0n) {
        throw new Error(`relay step unexpectedly requires ${value} native on a token sell — aborted for safety`);
      }
      const tx = await wallet.sendTransaction({
        to: d.to,
        data: d.data,
        value,
      });
      const rc = await tx.wait();
      if (rc) txHashes.push(rc.hash);
    }
  }

  // Estimasi jumlah keluar dari quote (kalau tersedia).
  let outWei = 0n;
  try {
    const raw = quote?.details?.currencyOut?.amount;
    if (raw) outWei = BigInt(raw);
  } catch {
    /* abaikan */
  }

  return { txHashes, outWei };
}

export async function swapTokenToEthViaRelay(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const r = await swapTokenViaRelay(tokenAddress, amountWei, NATIVE, ctx);
  return { txHashes: r.txHashes, outEthWei: r.outWei };
}

/** Quote-only Relay same-chain from→to (TIDAK eksekusi). null bila tak ada rute. */
export async function relayQuoteOut(
  fromCurrency: string,
  toCurrency: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<bigint | null> {
  try {
    const res = await fetch(RELAY_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: ctx.wallet.address,
        recipient: ctx.wallet.address,
        originChainId: ctx.chainId,
        destinationChainId: ctx.chainId,
        originCurrency: fromCurrency === NATIVE ? NATIVE : ethers.getAddress(fromCurrency),
        destinationCurrency: toCurrency === NATIVE ? NATIVE : ethers.getAddress(toCurrency),
        amount: amountWei.toString(),
        tradeType: 'EXACT_INPUT',
      }),
    });
    if (!res.ok) return null;
    const q: any = await res.json();
    const raw = q?.details?.currencyOut?.amount;
    return raw ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Dua bentuk struct exactInputSingle yang beredar. Uniswap SwapRouter02 membuang
// `deadline`; SwapRouter v3 asli (dipakai PancakeSwap) tetap memakainya. Memanggil
// dengan bentuk yang salah = revert tanpa data — mahal & membingungkan.
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const ROUTER_ABI_DEADLINE = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

/** Kontrak router + parameter exactInputSingle sesuai bentuk struct chain ini. */
function routerCall(
  ctx: ChainCtx,
  wallet: ethers.Signer,
  p: { tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint },
): { router: ethers.Contract; params: Record<string, unknown> } {
  const router = new ethers.Contract(
    ctx.routerAddress,
    ctx.routerHasDeadline ? ROUTER_ABI_DEADLINE : ROUTER_ABI,
    wallet,
  );
  return {
    router,
    params: {
      ...p,
      ...(ctx.routerHasDeadline ? { deadline: BigInt(Math.floor(Date.now() / 1000) + 600) } : {}),
      sqrtPriceLimitX96: 0n,
    },
  };
}
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
];

/**
 * Tangga slippage Uniswap: mulai 5%, naik ke 15% bila revert (volume ramai).
 * `max` menjepitnya: /buy & /sell mengirim 3 → tangga jadi [3] saja, tak pernah
 * ada percobaan kedua yang lebih longgar. Tanpa parameter = perilaku lama, sengaja
 * dipertahankan untuk close/sweep: di sana gagal berarti token nyangkut.
 *
 * Relay TIDAK diikutkan: default-nya sudah 1% (diverifikasi 2 Agu 2026 — kirim
 * slippageTolerance=300 justru melonggarkannya ke 3%), jadi biarkan apa adanya.
 */
export function slipLadder(max?: number): number[] {
  if (max === undefined) return [5, 15];
  return [...new Set([Math.min(5, max), max])].filter((s) => s > 0);
}

/** Fallback: swap token → WETH langsung via Uniswap SwapRouter02 (pool ter-likuid). */
async function swapViaUniswap(
  tokenAddress: string,
  amountWei: bigint,
  slippagePct: number,
  ctx: ChainCtx,
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const { ethers: e } = await import('ethers');
  const { discoverPools } = await import('./uniswap.js');
  const { ERC20_ABI } = await import('./chain.js');
  const { wallet, weth } = ctx;

  const pools = (await discoverPools(tokenAddress, ctx)).filter((p) => p.baseReserve > 0n);
  if (pools.length === 0) throw new Error('no WETH pool available for the fallback swap');
  const fee = pools[0].fee;

  const txHashes: string[] = [];
  const token = new e.Contract(tokenAddress, ERC20_ABI, wallet);
  const routerAddr = ctx.routerAddress;
  const allowance: bigint = await token.allowance(wallet.address, routerAddr);
  if (allowance < amountWei) {
    const atx = await token.approve(routerAddr, e.MaxUint256);
    await atx.wait();
    txHashes.push(atx.hash);
  }

  // minOut dari quoter, dikurangi slippage. Quoter gagal / kembali 0 → BATALKAN
  // route ini (JANGAN swap dgn minOut=0 — itu umpan sandwich). swapTokenToEthRobust
  // akan coba jalur lain; bila semua gagal, token ditahan (leftover/STOPPED) & sweep
  // mencoba lagi nanti — jauh lebih baik daripada dijual di harga berapa pun.
  let minOut: bigint;
  try {
    const quoter = new e.Contract(ctx.quoterAddress, QUOTER_ABI, wallet);
    const q = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenAddress,
      tokenOut: ctx.wethAddress,
      amountIn: amountWei,
      fee,
      sqrtPriceLimitX96: 0n,
    });
    minOut = (BigInt(q[0]) * BigInt(Math.floor((100 - slippagePct) * 100))) / 10000n;
  } catch (err) {
    throw new Error(`quoter failed (${(err as Error).message.slice(0, 60)}) — swap cancelled to avoid minOut=0`);
  }
  if (minOut <= 0n) {
    throw new Error('quoter returned 0 — swap cancelled (sandwich protection)');
  }

  const { router, params } = routerCall(ctx, wallet as unknown as ethers.Signer, {
    tokenIn: tokenAddress,
    tokenOut: ctx.wethAddress,
    fee,
    recipient: wallet.address,
    amountIn: amountWei,
    amountOutMinimum: minOut,
  });
  const beforeWeth: bigint = await weth.balanceOf(wallet.address);
  const tx = await router.exactInputSingle(params);
  await tx.wait();
  txHashes.push(tx.hash);

  // Unwrap WETH hasil swap → ETH native.
  const gotWeth: bigint = (await weth.balanceOf(wallet.address)) - beforeWeth;
  if (gotWeth > 0n) {
    const wtx = await weth.withdraw(gotWeth);
    await wtx.wait();
    txHashes.push(wtx.hash);
  }
  return { txHashes, outEthWei: gotWeth };
}

/**
 * Swap token → ETH TAHAN BANTING:
 *  1. Relay, retry 3x (backoff 2s/5s) — kuat saat jaringan/API ramai.
 *  2. Fallback Uniswap router: slippage 5%, lalu 15% bila revert (volume ramai).
 * Lempar error hanya kalau SEMUA jalur gagal.
 */
async function tokenBalance(tokenAddress: string, ctx: ChainCtx): Promise<bigint> {
  const c = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    ctx.provider,
  );
  return (await c.balanceOf(ctx.wallet.address)) as bigint;
}

/** Relay + VERIFIKASI saldo token benar-benar berkurang (Relay kadang "sukses" tanpa swap). */
async function relayVerified(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx,
): Promise<{ txHashes: string[]; outEthWei: bigint }> {
  const before = await tokenBalance(tokenAddress, ctx);
  const ethBefore = await ctx.provider.getBalance(ctx.wallet.address).catch(() => null);
  const r = await swapTokenToEthViaRelay(tokenAddress, amountWei, ctx);
  const after = await tokenBalance(tokenAddress, ctx);
  // Harus berkurang ≥90% dari yang diminta; kalau tidak, anggap Relay no-op.
  if (before - after < (amountWei * 9n) / 10n) {
    throw new Error(`relay did not reduce the token balance (before=${before} after=${after})`);
  }
  // outEthWei dari quote hanyalah ESTIMASI (kadang 0) — dan angka itu dipakai
  // sebagai hasil close di jurnal. Ukur dari delta saldo native bila bisa.
  const ethAfter = await ctx.provider.getBalance(ctx.wallet.address).catch(() => null);
  const measured = ethBefore !== null && ethAfter !== null && ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
  return { ...r, outEthWei: measured > 0n ? measured : r.outEthWei };
}

export async function swapTokenToEthRobust(
  tokenAddress: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
  maxSlipPct?: number,
): Promise<{ txHashes: string[]; outEthWei: bigint; route: string }> {
  const errors: string[] = [];

  // Jalur 1: Relay (agregator, hasil ETH native langsung) — terverifikasi.
  try {
    const r = await relayVerified(tokenAddress, amountWei, ctx);
    return { ...r, route: 'relay' };
  } catch (e) {
    errors.push(`relay: ${(e as Error).message.slice(0, 80)}`);
  }

  // Jalur 2: langsung Uniswap router (exactInputSingle → swap FULL amountIn), slippage naik.
  for (const slip of slipLadder(maxSlipPct)) {
    try {
      const r = await swapViaUniswap(tokenAddress, amountWei, slip, ctx);
      return { ...r, route: `uniswap(slip ${slip}%)` };
    } catch (e) {
      errors.push(`uniswap${slip}%: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Jalur 3: 2-hop token → USDG → ETH. Wajib utk token yang likuiditasnya HANYA di
  // pool USDG (mis. GME/USDG) — tak punya pool WETH, jadi jalur 1 & 2 selalu gagal &
  // token nyangkut. Guard: hanya bila USDG dikenal & token BUKAN USDG (hindari rekursi).
  const usdgAddr = ctx.usdgAddress;
  if (usdgAddr && tokenAddress.toLowerCase() !== usdgAddr.toLowerCase()) {
    try {
      const u = await swapTokenToUsdgRobust(tokenAddress, amountWei, usdgAddr, ctx, maxSlipPct);
      const eth = await swapTokenToEthRobust(usdgAddr, u.outWei, ctx, maxSlipPct); // USDG→ETH (relay/uniswap)
      return {
        txHashes: [...u.txHashes, ...eth.txHashes],
        outEthWei: eth.outEthWei,
        route: `usdg-hop(${u.route}→${eth.route})`,
      };
    } catch (e) {
      errors.push(`usdg-hop: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Jalur 4: Relay sekali lagi (siapa tahu gangguan tadi transien).
  await sleep(2000);
  try {
    const r = await relayVerified(tokenAddress, amountWei, ctx);
    return { ...r, route: 'relay(retry)' };
  } catch (e) {
    errors.push(`relay-retry: ${(e as Error).message.slice(0, 80)}`);
  }
  throw new Error('All swap routes failed:\n' + errors.join('\n'));
}

/**
 * Swap token → USDG (untuk close posisi pasangan USDG). Pilih pool USDG/token
 * terlikuid, exactInputSingle via Uniswap router dgn minOut dari quoter (floor,
 * sama seperti jalur WETH — quoter gagal/0 → BATALKAN, hindari sandwich).
 * Slippage 5% lalu 15% bila revert. USDG TIDAK di-unwrap (tetap stablecoin).
 */
export async function swapTokenToUsdgRobust(
  tokenAddress: string,
  amountWei: bigint,
  usdgAddress: string,
  ctx: ChainCtx = getChain(),
  maxSlipPct?: number,
): Promise<{ txHashes: string[]; outWei: bigint; route: string }> {
  const { wallet } = ctx;
  const usdg = new ethers.Contract(
    usdgAddress,
    ['function balanceOf(address) view returns (uint256)'],
    ctx.provider,
  );
  const token = new ethers.Contract(
    tokenAddress,
    [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
    ],
    wallet,
  );

  // Pool USDG/token terlikuid (USDG reserve terbesar).
  let bestFee = 0;
  let bestReserve = -1n;
  for (const fee of ctx.feeTiers) {
    const pool: string = await ctx.factory.getPool(usdgAddress, tokenAddress, fee);
    if (!pool || pool === ethers.ZeroAddress) continue;
    const r: bigint = await usdg.balanceOf(pool);
    if (r > bestReserve) {
      bestReserve = r;
      bestFee = fee;
    }
  }
  // TIDAK ADA pool langsung bukan alasan menyerah: Relay di bawah bisa merutekan
  // lewat WETH dll. Dulu di sini ada `throw` — akibatnya fallback Relay TAK PERNAH
  // tercapai dan /sell ke base stablecoin selalu gagal utk token yang cuma
  // berpasangan dgn WETH. Lewati saja bagian pool langsung, jangan berhenti.
  const hasDirectPool = bestReserve >= 0n;

  const routerAddr = ctx.routerAddress;
  const txHashes: string[] = [];
  if (hasDirectPool) {
    const allowance: bigint = await token.allowance(wallet.address, routerAddr);
    if (allowance < amountWei) {
      const atx = await token.approve(routerAddr, ethers.MaxUint256);
      await atx.wait();
      txHashes.push(atx.hash);
    }
  }

  const quoter = new ethers.Contract(ctx.quoterAddress, QUOTER_ABI, wallet);
  let lastErr = hasDirectPool ? '' : 'no direct token→USDG pool';
  for (const slip of hasDirectPool ? slipLadder(maxSlipPct) : []) {
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenAddress,
        tokenOut: usdgAddress,
        amountIn: amountWei,
        fee: bestFee,
        sqrtPriceLimitX96: 0n,
      });
      const minOut = (BigInt(q[0]) * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      if (minOut <= 0n) throw new Error('quoter returned 0 (sandwich protection)');
      const before: bigint = await usdg.balanceOf(wallet.address);
      const call = routerCall(ctx, wallet as unknown as ethers.Signer, {
        tokenIn: tokenAddress,
        tokenOut: usdgAddress,
        fee: bestFee,
        recipient: wallet.address,
        amountIn: amountWei,
        amountOutMinimum: minOut,
      });
      const tx = await call.router.exactInputSingle(call.params);
      await tx.wait();
      txHashes.push(tx.hash);
      const outWei = (await usdg.balanceOf(wallet.address)) - before;
      return { txHashes, outWei, route: `uniswap-usdg(slip ${slip}%)` };
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 80);
    }
  }

  // Fallback: Relay token→USDG (agregator; rute lewat WETH dll bila pool USDG langsung
  // tipis/impact tinggi). Verifikasi saldo token TURUN ≥90% (Relay kadang "sukses"
  // tanpa swap) & ukur USDG masuk dari delta saldo. Menyamakan ketahanan dgn jalur ETH
  // → posisi pasangan USDG tak lagi sering nyangkut tanpa auto-swap.
  try {
    const beforeTok = await tokenBalance(tokenAddress, ctx);
    const beforeUsdg: bigint = await usdg.balanceOf(wallet.address);
    const r = await swapTokenViaRelay(tokenAddress, amountWei, usdgAddress, ctx);
    const afterTok = await tokenBalance(tokenAddress, ctx);
    if (beforeTok - afterTok < (amountWei * 9n) / 10n) {
      throw new Error('relay did not reduce the token balance');
    }
    const outWei = (await usdg.balanceOf(wallet.address)) - beforeUsdg;
    return { txHashes: r.txHashes, outWei, route: 'relay-usdg' };
  } catch (e) {
    lastErr = `${lastErr} | relay: ${(e as Error).message.slice(0, 60)}`;
  }

  // Rute 3: 2-hop token → WETH → USDG. Cermin dari `usdg-hop` di
  // swapTokenToEthRobust, dan bukan teori: diukur 2 Agu 2026 utk SESTRI & IF —
  // pool token/WETH ADA (fee 1%), pool token/USDG TIDAK ADA, dan Relay pun tak
  // punya rute (quote null). Tanpa hop ini, /sell & close berbasis stablecoin
  // gagal total untuk mayoritas token, yang memang cuma berpasangan dgn WETH.
  //
  // Bila kaki-1 sukses tapi kaki-2 gagal, dompet memegang WETH (bukan token) —
  // itu tetap kemajuan: sweep monitor bisa meng-unwrap-nya.
  const wethLower = ctx.wethAddress.toLowerCase();
  const tokLower = tokenAddress.toLowerCase();
  if (tokLower !== wethLower && tokLower !== usdgAddress.toLowerCase()) {
    try {
      // Import dinamis: swapRoute.ts meng-import modul INI, jadi import statik
      // akan membuat siklus modul. Dipanggil saat runtime → aman.
      const { swapExactInBest } = await import('./swapRoute.js');
      const leg1 = await swapExactInBest(tokenAddress, ctx.wethAddress, amountWei, ctx, maxSlipPct ?? 5, maxSlipPct);
      const leg2 = await swapExactInBest(ctx.wethAddress, usdgAddress, leg1.outWei, ctx, maxSlipPct ?? 5, maxSlipPct);
      return {
        txHashes: [...txHashes, ...leg1.txHashes, ...leg2.txHashes],
        outWei: leg2.outWei,
        route: `weth-hop(${leg1.route}→${leg2.route})`,
      };
    } catch (e) {
      lastErr = `${lastErr} | weth-hop: ${(e as Error).message.slice(0, 60)}`;
    }
  }

  throw new Error(`token→USDG swap failed: ${lastErr}`);
}

// ─── bridge lintas chain (Relay) ────────────────────────────────────
//
// Relay itu agregator bridge: swap same-chain di atas hanyalah kasus khusus dengan
// origin == destination. Untuk lintas chain, kedua id diisi berbeda.

export type BridgeQuote = {
  inLabel: string; // "0.01 ETH"
  outLabel: string; // "0.0319 BNB"
  outWei: bigint;
  impactPct: number | null; // selisih nilai USD masuk vs keluar
  feeUsd: number | null; // biaya relayer
  etaSec: number | null;
  steps: Array<{ to: string; data: string; value: string }>;
};

/**
 * Quote bridge native→native. Calldata-nya BERUMUR PENDEK — jangan pernah
 * mengeksekusi `steps` dari quote yang dipakai merender kartu; minta quote baru
 * tepat sebelum kirim (lihat executeBridge).
 */
export async function getBridgeQuote(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
): Promise<BridgeQuote> {
  const body = {
    user: from.wallet.address,
    recipient: from.wallet.address, // dompet yang sama di kedua chain (EVM)
    originChainId: from.chainId,
    destinationChainId: to.chainId,
    originCurrency: NATIVE,
    destinationCurrency: NATIVE,
    amount: amountWei.toString(),
    tradeType: 'EXACT_INPUT',
  };
  const res = await fetch(RELAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Relay quote failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const q: any = await res.json();
  const d = q?.details ?? {};
  const steps: BridgeQuote['steps'] = [];
  for (const st of q?.steps ?? []) {
    for (const it of st?.items ?? []) {
      if (it?.data?.to) steps.push({ to: it.data.to, data: it.data.data, value: it.data.value ?? '0' });
    }
  }
  if (steps.length === 0) throw new Error('Relay returned no executable step for this route.');
  const outWei = BigInt(d?.currencyOut?.amount ?? '0');
  if (outWei <= 0n) throw new Error('Relay quote returned zero output — route unusable right now.');
  // Relay mengembalikan presisi penuh (18 angka di belakang koma) — dipangkas 6,
  // cukup untuk keputusan dan tak memenuhi layar HP.
  const trim = (v: unknown, fallback: bigint): string =>
    Number(v ?? ethers.formatEther(fallback)).toFixed(6);
  return {
    inLabel: `${trim(d?.currencyIn?.amountFormatted, amountWei)} ${d?.currencyIn?.currency?.symbol ?? from.nativeSymbol}`,
    outLabel: `${trim(d?.currencyOut?.amountFormatted, outWei)} ${d?.currencyOut?.currency?.symbol ?? to.nativeSymbol}`,
    outWei,
    impactPct: d?.totalImpact?.percent != null ? Number(d.totalImpact.percent) : null,
    feeUsd: q?.fees?.relayer?.amountUsd != null ? Number(q.fees.relayer.amountUsd) : null,
    etaSec: d?.timeEstimate != null ? Number(d.timeEstimate) : null,
    steps,
  };
}

/**
 * Kirim bridge. Quote DIMINTA ULANG di sini: calldata Relay berumur pendek, dan
 * mengeksekusi calldata basi = dana terkirim dengan angka yang bukan lagi yang
 * dilihat user. `minOutWei` menjaga hasil tak jatuh jauh dari yang dikonfirmasi.
 */
export async function executeBridge(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  minOutWei: bigint,
): Promise<{ txHashes: string[]; outWei: bigint }> {
  const fresh = await getBridgeQuote(from, to, amountWei);
  if (fresh.outWei < minOutWei) {
    throw new Error(
      `Route moved: now ${fresh.outLabel}, below the confirmed minimum. Nothing was sent — try again.`,
    );
  }
  const txHashes: string[] = [];
  for (const st of fresh.steps) {
    const tx = await from.wallet.sendTransaction({
      to: st.to,
      data: st.data,
      value: st.value ? BigInt(st.value) : 0n,
    });
    const rc = await tx.wait();
    if (rc) txHashes.push(rc.hash);
  }
  return { txHashes, outWei: fresh.outWei };
}
