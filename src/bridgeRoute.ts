import { ethers } from 'ethers';
import { type ChainCtx } from './chains.js';
import { getBridgeQuote, executeBridge, NATIVE, type BridgeQuote } from './relay.js';
import { lifiBridgeQuote, lifiSupports } from './lifi.js';

export type BridgeAssets = { originCurrency?: string; destinationCurrency?: string };

/**
 * Pemilih rute BRIDGE otomatis antar penyedia agregator (Relay & LI.FI/Jumper).
 * Kriteria: output tertinggi (nilai terdalam) dulu; bila selisih ≤0,5% pilih ETA
 * tercepat. Eksekusi MEMINTA QUOTE ULANG dari penyedia terpilih (calldata bridge
 * berumur pendek) dan menolak bila turun di bawah minimum yang dikonfirmasi user.
 */

export type BridgeProvider = 'relay' | 'lifi';

/** Adu quote kedua penyedia, kembalikan yang terbaik. Lempar bila tak ada rute. */
export async function bestBridgeQuote(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  assets: BridgeAssets = {},
): Promise<{ provider: BridgeProvider; quote: BridgeQuote }> {
  const tasks: Array<Promise<{ provider: BridgeProvider; quote: BridgeQuote }>> = [
    getBridgeQuote(from, to, amountWei, assets).then((quote) => ({ provider: 'relay' as const, quote })),
  ];
  if (lifiSupports(from) && lifiSupports(to)) {
    tasks.push(lifiBridgeQuote(from, to, amountWei, assets).then((quote) => ({ provider: 'lifi' as const, quote })));
  }
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter((s): s is PromiseFulfilledResult<{ provider: BridgeProvider; quote: BridgeQuote }> => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length === 0) {
    const why = settled.map((s) => (s.status === 'rejected' ? (s.reason as Error).message?.slice(0, 80) : '')).filter(Boolean);
    throw new Error(why.join(' | ') || 'no bridge route available');
  }
  ok.sort((a, b) => {
    // Output tertinggi dulu; dalam 0,5% dianggap seri → ETA lebih cepat menang.
    const hi = a.quote.outWei > b.quote.outWei ? a : b;
    const near = (hi.quote.outWei - (a === hi ? b : a).quote.outWei) * 1000n <= hi.quote.outWei * 5n;
    if (near) {
      const ea = a.quote.etaSec ?? Number.MAX_SAFE_INTEGER;
      const eb = b.quote.etaSec ?? Number.MAX_SAFE_INTEGER;
      if (ea !== eb) return ea - eb;
    }
    return b.quote.outWei > a.quote.outWei ? 1 : b.quote.outWei < a.quote.outWei ? -1 : 0;
  });
  return ok[0];
}

/** Eksekusi bridge lewat penyedia terpilih; quote diminta ulang & dijaga minOut. */
export async function executeBridgeVia(
  provider: BridgeProvider,
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  minOutWei: bigint,
  assets: BridgeAssets = {},
): Promise<{ txHashes: string[]; outWei: bigint }> {
  // Relay menyertakan langkah approve token di step-nya sendiri.
  if (provider === 'relay') return executeBridge(from, to, amountWei, minOutWei, assets);
  // LI.FI: quote ulang (target & spender sudah dipin ke diamond di lifiBridgeQuote), cek minOut.
  const fresh = await lifiBridgeQuote(from, to, amountWei, assets);
  if (fresh.outWei < minOutWei) {
    throw new Error(`Route moved: now ${fresh.outLabel}, below the confirmed minimum. Nothing was sent — try again.`);
  }
  const txHashes: string[] = [];
  const origin = assets.originCurrency ?? NATIVE;
  // Token ERC20: approve EXACT-amount ke diamond (spender sudah diverifikasi dipin).
  if (origin !== NATIVE) {
    const spender = fresh.steps[0]?.approvalAddress;
    if (!spender) throw new Error('LI.FI tak mengembalikan spender untuk approve token');
    const erc = new ethers.Contract(
      ethers.getAddress(origin),
      ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
      from.wallet,
    );
    const allowance: bigint = await erc.allowance(from.wallet.address, spender);
    if (allowance < amountWei) {
      const atx = await erc.approve(spender, amountWei);
      await atx.wait();
      txHashes.push(atx.hash);
    }
  }
  for (const st of fresh.steps) {
    const tx = await from.wallet.sendTransaction({ to: st.to, data: st.data, value: st.value ? BigInt(st.value) : 0n });
    const rc = await tx.wait();
    if (rc) txHashes.push(rc.hash);
  }
  return { txHashes, outWei: fresh.outWei };
}
