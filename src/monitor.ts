import type { Telegraf } from 'telegraf';
import { config } from './config.js';
import { getPositionDetail } from './uniswap.js';
import { getChain, ERC20_ABI } from './chains.js';
import { swapTokenToEthRobust } from './relay.js';
import { ethers } from 'ethers';
import * as store from './store.js';
import * as journal from './journal.js';
import { msgRangeEnter, msgRangeExit } from './messages.js';

/**
 * Auto-monitor pasif: tiap interval, cek posisi ACTIVE.
 * Kirim notifikasi saat posisi masuk/keluar range (mulai/berhenti konversi & panen fee).
 */

const INTERVAL_MS = 60_000;
const SWEEP_EVERY_MS = 30 * 60_000; // sapu sisa token tiap 30 menit
const SWEEP_COOLDOWN_MS = 6 * 3_600_000; // per token max 1 percobaan / 6 jam
const html = { parse_mode: 'HTML' as const };
const lastSweep = new Map<string, number>();
let lastSweepRun = 0;

/** Sapu token sisa (cash-out gagal) di wallet → swap ke ETH. Non-fatal. */
async function sweepLeftovers(bot: Telegraf) {
  if (Date.now() - lastSweepRun < SWEEP_EVERY_MS) return;
  lastSweepRun = Date.now();
  const seen = new Set<string>();
  // Kandidat token: dari store live + jurnal (agar sisa token dari posisi lama
  // yang sudah tak ada di store tetap bisa dipulihkan).
  const candidates = [
    ...store.all().map((r) => ({ ca: r.ca, chain: r.chain, symbol: r.symbol })),
    ...journal.recentTokens(80),
  ];
  for (const r of candidates) {
    if (!r.ca) continue;
    const key = `${r.chain ?? 'robinhood'}:${r.ca.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Date.now() - (lastSweep.get(key) ?? 0) < SWEEP_COOLDOWN_MS) continue;
    const cc = getChain(r.chain);
    try {
      const t = new ethers.Contract(r.ca, ERC20_ABI, cc.wallet);
      const bal: bigint = await t.balanceOf(cc.wallet.address);
      if (bal === 0n) continue;
      lastSweep.set(key, Date.now());
      if (config.safety.dryRun) continue;
      const res = await swapTokenToEthRobust(r.ca, bal, cc);
      console.log(`[sweep] ${r.symbol} (${cc.key}) → +${ethers.formatEther(res.outEthWei)} ETH via ${res.route}`);
      await bot.telegram.sendMessage(
        config.telegram.allowedUserId,
        `♻️ Sisa ${r.symbol} tersapu → +${Number(ethers.formatEther(res.outEthWei)).toFixed(6)} ETH (${res.route})`,
      );
    } catch (e) {
      console.log(`[sweep] ${r.symbol} gagal: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

export function startMonitor(bot: Telegraf) {
  setInterval(async () => {
    await sweepLeftovers(bot).catch(() => {});
    for (const rec of store.active()) {
      try {
        const d = await getPositionDetail(rec.tokenId, getChain(rec.chain));
        if (rec.lastInRange !== undefined && rec.lastInRange !== d.inRange) {
          const text = d.inRange
            ? msgRangeEnter(rec.tokenId, rec.symbol)
            : msgRangeExit(rec.tokenId, rec.symbol, d.side === 'above' ? 'above' : 'below');
          await bot.telegram.sendMessage(config.telegram.allowedUserId, text, html);
        }
        store.update(rec.tokenId, { lastInRange: d.inRange });
      } catch (e) {
        // Posisi sudah di-burn (NFT hilang) → catat ke jurnal & keluarkan dari store.
        if (/invalid token id/i.test(String((e as Error)?.message ?? e))) {
          journal.recordClose(rec, { reason: 'burned' });
          store.remove(rec.tokenId);
        }
        /* error lain: lewati ronde ini */
      }
    }
  }, INTERVAL_MS);
}
