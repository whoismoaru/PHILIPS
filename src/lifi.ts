import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';
import { NATIVE } from './relay.js';

/**
 * LI.FI (mesin di balik Jumper) — agregator swap & bridge lintas ratusan DEX/bridge.
 * Dipakai sebagai SUMBER QUOTE tambahan di best-of (swapRoute.ts) dan penyedia
 * bridge alternatif (commands/bridge.ts). Rute dipilih otomatis oleh best-of:
 * output tertinggi = likuiditas efektif terdalam; bridge tie-break ke ETA tercepat.
 *
 * KEAMANAN — LI.FI mengembalikan target & spender DINAMIS. Hot wallet ini tak punya
 * stop-loss, jadi calldata dari API TAK PERNAH dieksekusi ke alamat sembarang:
 *  - `to` transaksi & `approvalAddress` WAJIB = LiFiDiamond resmi chain ini
 *    (allowlist di bawah, diverifikasi dari li.quest/v1/chains). Beda = tolak.
 *  - approve EXACT-amount ke diamond, bukan MaxUint256.
 *  - `out` dari API hanya ESTIMASI; pemanggil tetap verifikasi delta saldo (§8).
 */

const LIFI_API = 'https://li.quest/v1';
const TIMEOUT_MS = 8000;

/** LiFiDiamond per chainId — allowlist target/spender. Sumber: li.quest/v1/chains. */
const DIAMOND: Record<number, string> = {
  4663: '0xB477751B76CF82d00a686A1232f5fCD772414Af3', // Robinhood
  999: '0x0a0758d937d1059c356D4714e57F5df0239bce1A', // HyperEVM
  8453: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', // Base
  56: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', // BSC
};

/** true bila LI.FI aktif untuk chain ini (diamond diketahui). */
export const lifiSupports = (ctx: ChainCtx): boolean => DIAMOND[ctx.chainId] !== undefined;

const isAllowed = (chainId: number, addr: string | undefined): boolean =>
  !!addr && !!DIAMOND[chainId] && addr.toLowerCase() === DIAMOND[chainId].toLowerCase();

/** LI.FI memakai 0x000..0 untuk native — sama dgn NATIVE kita. */
const tok = (a: string) => (a === NATIVE ? NATIVE : ethers.getAddress(a));

async function fetchQuote(params: Record<string, string>): Promise<any | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${LIFI_API}/quote?${new URLSearchParams(params)}`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Quote-only same-chain from→to (TIDAK eksekusi). null bila tak ada rute / chain tak didukung. */
export async function lifiQuoteOut(
  fromAddr: string,
  toAddr: string,
  amountWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<bigint | null> {
  if (!lifiSupports(ctx)) return null;
  const q = await fetchQuote({
    fromChain: String(ctx.chainId),
    toChain: String(ctx.chainId),
    fromToken: tok(fromAddr),
    toToken: tok(toAddr),
    fromAmount: amountWei.toString(),
    fromAddress: ctx.wallet.address,
    slippage: '0.05',
  });
  const raw = q?.estimate?.toAmount;
  try {
    return raw ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

/** Eksekusi swap same-chain from→to lewat LI.FI. Verifikasi delta saldo dilakukan pemanggil. */
export async function swapViaLifi(
  fromAddr: string,
  toAddr: string,
  amountWei: bigint,
  ctx: ChainCtx,
  slipPct = 5,
): Promise<{ txHashes: string[]; outWei: bigint }> {
  if (!lifiSupports(ctx)) throw new Error('LI.FI tidak mendukung chain ini');
  const wallet = ctx.wallet;
  const q = await fetchQuote({
    fromChain: String(ctx.chainId),
    toChain: String(ctx.chainId),
    fromToken: tok(fromAddr),
    toToken: tok(toAddr),
    fromAmount: amountWei.toString(),
    fromAddress: wallet.address,
    slippage: String(slipPct / 100),
  });
  if (!q) throw new Error('LI.FI quote gagal / kosong');
  const tr = q.transactionRequest;
  const spender: string | undefined = q.estimate?.approvalAddress;
  // PIN: target tx & spender HARUS diamond resmi chain ini. Kalau tidak → API
  // mungkin dikompromikan/keliru; batalkan sebelum menandatangani apa pun.
  if (!tr?.to || !isAllowed(ctx.chainId, tr.to)) {
    throw new Error(`LI.FI target tak dikenal (${tr?.to}) — ditolak demi keamanan`);
  }
  if (fromAddr !== NATIVE && !isAllowed(ctx.chainId, spender)) {
    throw new Error(`LI.FI spender tak dikenal (${spender}) — ditolak demi keamanan`);
  }
  const txHashes: string[] = [];
  // Approve EXACT-amount ke diamond (bukan MaxUint256). Native tak perlu approve.
  if (fromAddr !== NATIVE) {
    const erc = new ethers.Contract(
      fromAddr,
      ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
      wallet,
    );
    const allowance: bigint = await erc.allowance(wallet.address, spender!);
    if (allowance < amountWei) {
      const atx = await erc.approve(spender!, amountWei);
      await atx.wait();
      txHashes.push(atx.hash);
    }
  }
  const tx = await wallet.sendTransaction({
    to: tr.to,
    data: tr.data,
    value: tr.value ? BigInt(tr.value) : 0n,
    ...(tr.gasLimit ? { gasLimit: BigInt(tr.gasLimit) } : {}),
  });
  const rc = await tx.wait();
  if (rc) txHashes.push(rc.hash);
  let outWei = 0n;
  try {
    outWei = BigInt(q.estimate?.toAmount ?? '0');
  } catch {
    /* estimasi saja; pemanggil ukur dari saldo */
  }
  return { txHashes, outWei };
}

// ─── bridge lintas chain (LI.FI) ────────────────────────────────────
import type { BridgeQuote } from './relay.js';

/** Quote bridge native→native lewat LI.FI. Bentuk sama dgn Relay agar bisa diadu. */
export async function lifiBridgeQuote(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  opts: { originCurrency?: string; destinationCurrency?: string } = {},
): Promise<BridgeQuote> {
  if (!lifiSupports(from) || !lifiSupports(to)) throw new Error('LI.FI tak mendukung salah satu chain');
  const q = await fetchQuote({
    fromChain: String(from.chainId),
    toChain: String(to.chainId),
    fromToken: tok(opts.originCurrency ?? NATIVE),
    toToken: tok(opts.destinationCurrency ?? NATIVE),
    fromAmount: amountWei.toString(),
    fromAddress: from.wallet.address,
    toAddress: from.wallet.address,
    slippage: '0.05',
  });
  if (!q) throw new Error('LI.FI bridge quote gagal');
  const tr = q.transactionRequest;
  if (!tr?.to || !isAllowed(from.chainId, tr.to)) {
    throw new Error(`LI.FI bridge target tak dikenal (${tr?.to}) — ditolak`);
  }
  // Untuk token ERC20 spender juga wajib diamond (approve terjadi di executeBridgeVia... —
  // bridge native tak perlu; token perlu, jadi tetap dipin di sini).
  if ((opts.originCurrency ?? NATIVE) !== NATIVE && !isAllowed(from.chainId, q.estimate?.approvalAddress)) {
    throw new Error(`LI.FI bridge spender tak dikenal (${q.estimate?.approvalAddress}) — ditolak`);
  }
  const outWei = BigInt(q.estimate?.toAmount ?? '0');
  if (outWei <= 0n) throw new Error('LI.FI bridge out 0 — rute tak terpakai');
  // Desimal & simbol dari token yang LI.FI kembalikan — jangan asumsikan 18.
  const inTok = q.action?.fromToken ?? {};
  const outTok = q.action?.toToken ?? {};
  const fmt = (wei: bigint, dec: number, sym: string) => `${Number(ethers.formatUnits(wei, dec)).toFixed(6)} ${sym}`;
  const feeUsd = [...(q.estimate?.feeCosts ?? []), ...(q.estimate?.gasCosts ?? [])]
    .reduce((s: number, c: any) => s + Number(c.amountUSD ?? 0), 0);
  return {
    inLabel: fmt(amountWei, Number(inTok.decimals ?? 18), inTok.symbol ?? from.nativeSymbol),
    outLabel: fmt(outWei, Number(outTok.decimals ?? 18), outTok.symbol ?? to.nativeSymbol),
    outWei,
    impactPct: null,
    feeUsd: feeUsd || null,
    etaSec: q.estimate?.executionDuration != null ? Number(q.estimate.executionDuration) : null,
    steps: [{ to: tr.to, data: tr.data, value: tr.value ?? '0', approvalAddress: q.estimate?.approvalAddress }],
  };
}
