import { ethers } from 'ethers';
import { getChain, type ChainCtx } from './chains.js';
import { ERC20_ABI } from './chain.js';
import { swapTokenToUsdgRobust, swapTokenToEthRobust } from './relay.js';

/**
 * Swap manual ETH ↔ USDG (Global Dollar) — reuse primitif swap yang sudah teruji:
 *   - ETH → USDG : wrap ETH→WETH seperlunya, lalu swapTokenToUsdgRobust (quoter floor, anti-sandwich)
 *   - USDG → ETH : swapTokenToEthRobust (Relay→unwrap, fallback Uniswap; keduanya floor slippage)
 * Tak ada minOut=0 di jalur mana pun. USDG 6-desimal, ETH/WETH 18-desimal.
 */

const GAS_RESERVE = ethers.parseEther('0.0004'); // sisakan utk gas saat wrap

export type SwapDir = 'e2u' | 'u2e';

/** ETH native → USDG. Mengembalikan USDG diterima (6-dec wei) + rute + tx. */
export async function swapEthToUsdg(
  amountEthWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ outWei: bigint; route: string; txHashes: string[] }> {
  if (!ctx.usdgAddress) throw new Error(`USDG tak tersedia di ${ctx.label}.`);
  const { wallet, provider } = ctx;

  // Cek saldo ETH + WETH terpakai serentak (independen).
  const [ethBal, weth] = await Promise.all([
    provider.getBalance(wallet.address),
    ctx.weth.balanceOf(wallet.address) as Promise<bigint>,
  ]);
  if (ethBal < amountEthWei + GAS_RESERVE) {
    throw new Error(
      `Saldo ETH kurang: butuh ~${ethers.formatEther(amountEthWei + GAS_RESERVE)} (swap+gas), ` +
        `ada ${ethers.formatEther(ethBal)}.`,
    );
  }

  const txHashes: string[] = [];
  // Wrap seperlunya (pakai WETH yang sudah ada dulu).
  if (weth < amountEthWei) {
    const tx = await ctx.weth.deposit({ value: amountEthWei - weth });
    await tx.wait();
    txHashes.push(tx.hash);
  }

  const r = await swapTokenToUsdgRobust(ctx.wethAddress, amountEthWei, ctx.usdgAddress, ctx);
  return { outWei: r.outWei, route: r.route, txHashes: [...txHashes, ...r.txHashes] };
}

/** USDG → ETH native. Mengembalikan ETH diterima (wei) + rute + tx. */
export async function swapUsdgToEth(
  amountUsdgWei: bigint,
  ctx: ChainCtx = getChain(),
): Promise<{ outWei: bigint; route: string; txHashes: string[] }> {
  if (!ctx.usdgAddress) throw new Error(`USDG tak tersedia di ${ctx.label}.`);
  const usdg = new ethers.Contract(ctx.usdgAddress, ERC20_ABI, ctx.wallet);
  const bal: bigint = await usdg.balanceOf(ctx.wallet.address);
  if (bal < amountUsdgWei) {
    throw new Error(
      `Saldo USDG kurang: butuh ${ethers.formatUnits(amountUsdgWei, 6)}, ` +
        `ada ${ethers.formatUnits(bal, 6)}.`,
    );
  }
  const r = await swapTokenToEthRobust(ctx.usdgAddress, amountUsdgWei, ctx);
  return { outWei: r.outEthWei, route: r.route, txHashes: r.txHashes };
}
