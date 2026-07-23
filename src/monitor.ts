import type { Telegraf } from 'telegraf';
import { config } from './config.js';
import { getPositionDetail } from './uniswap.js';
import { getChain, CHAINS, ERC20_ABI } from './chains.js';
import { swapTokenToEthRobust } from './relay.js';
import { ethers } from 'ethers';
import * as store from './store.js';
import * as journal from './journal.js';
import * as v4store from './v4store.js';
import { checkV4Status } from './uniswapV4.js';
import { msgRangeEnter, msgRangeExit, msgPriceDrop, msgV4Range } from './messages.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Auto-monitor pasif: tiap interval, cek posisi ACTIVE.
 * Kirim notifikasi saat posisi masuk/keluar range (mulai/berhenti konversi & panen fee).
 */

const INTERVAL_MS = 60_000;
const DROP_ALERT_PCT = 25; // alert bila harga token turun ≥25% dari entry
const DROP_REARM_PCT = 20; // pulih di atas -20% → boleh alert lagi (histeresis anti-spam)
const SWEEP_EVERY_MS = 30 * 60_000; // sapu sisa token tiap 30 menit
const SWEEP_COOLDOWN_MS = 6 * 3_600_000; // per token max 1 percobaan / 6 jam
const DUST_COOLDOWN_MS = 7 * 24 * 3_600_000; // token "terlalu kecil" → mundur 7 hari
const SWEEP_FILE = join(process.cwd(), 'data', 'sweep.json');
const html = { parse_mode: 'HTML' as const };
// nextSweep[key] = epoch ms paling awal token boleh disapu lagi. PERSIST ke disk
// agar cooldown tak reset tiap restart (dulu in-memory → dust diulang tiap boot).
const nextSweep = loadSweep();
let lastSweepRun = 0;

function loadSweep(): Map<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SWEEP_FILE, 'utf8')) as Record<string, number>));
  } catch {
    return new Map();
  }
}

function saveSweep() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(SWEEP_FILE, JSON.stringify(Object.fromEntries(nextSweep)));
  } catch {
    /* non-fatal */
  }
}

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
    if (Date.now() < (nextSweep.get(key) ?? 0)) continue;
    const cc = getChain(r.chain);
    try {
      const t = new ethers.Contract(r.ca, ERC20_ABI, cc.wallet);
      const bal: bigint = await t.balanceOf(cc.wallet.address);
      if (bal === 0n) continue;
      nextSweep.set(key, Date.now() + SWEEP_COOLDOWN_MS);
      saveSweep();
      if (config.safety.dryRun) continue;
      const res = await swapTokenToEthRobust(r.ca, bal, cc);
      console.log(`[sweep] ${r.symbol} (${cc.key}) → +${ethers.formatEther(res.outEthWei)} ETH via ${res.route}`);
      await bot.telegram.sendMessage(
        config.telegram.allowedUserId,
        `♻️ Sisa ${r.symbol} tersapu → +${Number(ethers.formatEther(res.outEthWei)).toFixed(6)} ETH (${res.route})`,
      );
    } catch (e) {
      const emsg = (e as Error).message ?? '';
      // Token debu (nilai terlalu kecil utk di-swap) → mundur lama, jangan ulang tiap 6j.
      if (/too small|below minimum|\bminimum\b|dust/i.test(emsg)) {
        nextSweep.set(key, Date.now() + DUST_COOLDOWN_MS);
        saveSweep();
      }
      console.log(`[sweep] ${r.symbol} gagal: ${emsg.slice(0, 120)}`);
    }
  }
  await sweepStuckWeth(bot);
}

// Ambang debu WETH: < 0.00001 WETH diabaikan (gas unwrap > nilainya).
const WETH_DUST = 10_000_000_000_000n;

/**
 * Unwrap WETH NYANGKUT → ETH. WETH cuma perantara di bot ini (wrap saat open/swap);
 * sisa apa pun dari operasi gagal-separuh dikembalikan ke ETH native. Tanpa ini,
 * WETH menumpuk & harus di-unwrap manual (keluhan berulang user).
 */
async function sweepStuckWeth(bot: Telegraf) {
  for (const cc of Object.values(CHAINS)) {
    if (!cc.hasWethBase) continue;
    try {
      const bal: bigint = await cc.weth.balanceOf(cc.wallet.address);
      if (bal < WETH_DUST) continue;
      if (config.safety.dryRun) continue;
      const tx = await cc.weth.withdraw(bal);
      await tx.wait();
      console.log(`[sweep-weth] unwrap ${ethers.formatEther(bal)} WETH → ETH (${cc.key})`);
      await bot.telegram.sendMessage(
        config.telegram.allowedUserId,
        `♻️ WETH nyangkut ${Number(ethers.formatEther(bal)).toFixed(6)} disapu → ETH (${cc.label})`,
      );
    } catch (e) {
      console.log(`[sweep-weth] ${cc.key} gagal: ${(e as Error).message.slice(0, 80)}`);
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
            ? msgRangeEnter(rec.tokenId, rec.symbol, d.baseSymbol)
            : msgRangeExit(rec.tokenId, rec.symbol, d.side === 'above' ? 'above' : 'below', d.baseSymbol);
          await bot.telegram.sendMessage(config.telegram.allowedUserId, text, html);
        }
        // Alert anjlok: harga token vs entry. Sekali per crossing; re-arm saat pulih.
        const entry = rec.entryPrice ? Number(rec.entryPrice) : 0;
        const cur = Number(d.currentPrice);
        if (entry > 0 && cur > 0) {
          const dropPct = (1 - cur / entry) * 100;
          if (dropPct >= DROP_ALERT_PCT && !rec.dropAlerted) {
            await bot.telegram.sendMessage(
              config.telegram.allowedUserId,
              msgPriceDrop(rec.tokenId, rec.symbol, dropPct, d.baseSymbol),
              html,
            );
            store.update(rec.tokenId, { dropAlerted: true });
          } else if (rec.dropAlerted && dropPct < DROP_REARM_PCT) {
            store.update(rec.tokenId, { dropAlerted: false });
          }
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
    // Monitor posisi v4 yang DIKELOLA bot (alert in/out-range; bersihkan bila tertutup).
    for (const rec of v4store.allV4()) {
      try {
        const st = await checkV4Status(getChain(rec.chain), rec.tokenId);
        if (!st.exists) {
          v4store.removeV4(rec.tokenId); // ditutup di luar bot
          continue;
        }
        if (v4store.setV4InRange(rec.tokenId, st.inRange)) {
          await bot.telegram.sendMessage(config.telegram.allowedUserId, msgV4Range(rec.tokenId, st.inRange), html);
        }
      } catch {
        /* lewati ronde ini */
      }
    }
  }, INTERVAL_MS);
}
