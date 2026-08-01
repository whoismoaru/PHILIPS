import type { Telegraf } from 'telegraf';
import { config } from './config.js';
import { getPositionDetail } from './uniswap.js';
import { getChain, CHAINS, ERC20_ABI } from './chains.js';
import { swapTokenToEthRobust } from './relay.js';
import { ethers } from 'ethers';
import * as store from './store.js';
import * as alerts from './alerts.js';
import * as journal from './journal.js';
import * as v4store from './v4store.js';
import { checkV4Status } from './uniswapV4.js';
import { msgRangeEnter, msgRangeExit, msgPriceDrop, msgIlAlert, msgConverted, msgV4Range } from './messages.js';
import { readFileSync } from 'node:fs';
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
const SWEEP_RECENT_MS = 24 * 3_600_000; // sisa cash-out selalu muncul di jam-jam pertama
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
    store.writeJson(SWEEP_FILE, Object.fromEntries(nextSweep));
  } catch {
    /* non-fatal */
  }
}

/** Sapu token sisa (cash-out gagal) di wallet → swap ke ETH. Non-fatal. */
async function sweepLeftovers(bot: Telegraf) {
  if (Date.now() - lastSweepRun < SWEEP_EVERY_MS) return;
  lastSweepRun = Date.now();
  const seen = new Set<string>();
  // Kandidat = SISA yang sesungguhnya saja: posisi STOPPED (definisi leftover, PRD §8.6)
  // + token dari close < 24 jam (record-nya mungkin sudah terhapus).
  // JANGAN pakai semua token yang pernah di-LP: bag spot hasil /buy ikut terjual.
  const candidates = [
    ...store
      .all()
      .filter((r) => r.status === 'STOPPED')
      .map((r) => ({ ca: r.ca, chain: r.chain, symbol: r.symbol })),
    ...journal
      .read(80)
      .filter((e) => e.ca && Date.now() - e.closedAt < SWEEP_RECENT_MS)
      .map((e) => ({ ca: e.ca as string, chain: e.chain, symbol: e.symbol })),
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
      // Sisa sudah pulih → record STOPPED tak perlu dipertahankan (kalau tidak ia
      // menumpuk selamanya & tetap jadi kandidat sweep tiap ronde).
      const st = store
        .all()
        .find(
          (x) =>
            x.status === 'STOPPED' &&
            (x.chain ?? 'robinhood') === (r.chain ?? 'robinhood') &&
            x.ca?.toLowerCase() === r.ca.toLowerCase(),
        );
      if (st) store.remove(st.tokenId);
      console.log(`[sweep] ${r.symbol} (${cc.key}) → +${ethers.formatEther(res.outEthWei)} ${cc.nativeSymbol} via ${res.route}`);
      await bot.telegram.sendMessage(
        config.telegram.allowedUserId,
        `♻️ Swept leftover ${r.symbol} → +${Number(ethers.formatEther(res.outEthWei)).toFixed(6)} ${cc.nativeSymbol} (${res.route})`,
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
      const wrapped = cc.bases.find((b) => b.kind === 'weth')?.symbol ?? 'WETH';
      console.log(`[sweep-weth] unwrap ${ethers.formatEther(bal)} ${wrapped} → ${cc.nativeSymbol} (${cc.key})`);
      await bot.telegram.sendMessage(
        config.telegram.allowedUserId,
        `♻️ Swept ${Number(ethers.formatEther(bal)).toFixed(6)} stuck ${wrapped} → ${cc.nativeSymbol} (${cc.label})`,
      );
    } catch (e) {
      console.log(`[sweep-weth] ${cc.key} gagal: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

let tickStartedAt = 0; // 0 = idle
// Satu tx yang tak pernah settle (RPC blackhole, unwrap underpriced) membuat
// `finally` tak pernah jalan. Dengan flag boolean, monitor mati DIAM-DIAM selamanya:
// tak ada alert range, anjlok, rugi, maupun sweep. Batas waktu ini membiarkan tick
// berikutnya mengambil alih; tick yang menggantung dibiarkan selesai sendiri.
const TICK_STUCK_MS = 5 * 60_000;

export function startMonitor(bot: Telegraf) {
  setInterval(async () => {
    // tick sebelumnya masih menunggu tx — jangan bertumpuk, KECUALI sudah macet.
    if (tickStartedAt && Date.now() - tickStartedAt < TICK_STUCK_MS) return;
    if (tickStartedAt) console.log('[monitor] tick sebelumnya macet >5m — dilanjutkan tanpa menunggu');
    tickStartedAt = Date.now();
    try {
      await tick(bot);
    } finally {
      tickStartedAt = 0;
    }
  }, INTERVAL_MS);
}

async function tick(bot: Telegraf) {
  // Sweep hanya saat tak ada tx uang berjalan (nonce & WETH perantara).
  if (!store.isBusy()) await sweepLeftovers(bot).catch(() => {});
  for (const rec of store.active()) {
    try {
      const d = await getPositionDetail(rec.tokenId, getChain(rec.chain));
      const cfg = alerts.get();
      if (cfg.rangeNotify && rec.lastInRange !== undefined && rec.lastInRange !== d.inRange) {
        if (d.inRange) {
          await bot.telegram.sendMessage(
            config.telegram.allowedUserId,
            msgRangeEnter(rec.tokenId, rec.symbol, d.baseSymbol, rec.side === 'token'),
            {
              ...html,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 View Position Details', callback_data: `back:card:${rec.tokenId}` }],
                  [{ text: '💵 Harvest Fees', callback_data: `claim:${rec.tokenId}` }],
                  [{ text: '❌ Dismiss Alert', callback_data: 'dismiss' }],
                ],
              },
            },
          );
        } else {
          await bot.telegram.sendMessage(
            config.telegram.allowedUserId,
            msgRangeExit(rec.tokenId, rec.symbol, d.side === 'above' ? 'above' : 'below', d.baseSymbol),
            html,
          );
        }
      }
      // Alert TERKONVERSI PENUH: harga menembus SELURUH rentang ke arah tujuan,
      // jadi modal sudah 100% berubah jadi aset seberang dan posisi berhenti
      // memanen fee. Ini kejadian yang berbeda dari sekadar keluar rentang —
      // dan yang paling perlu ditindak, karena modal tak bisa pulih sendiri
      // sebelum harga balik. Sekali per crossing; re-arm saat kembali in range.
      const converted = !d.inRange && (rec.side === 'token' ? d.side === 'above' : d.side === 'below');
      if (cfg.rangeNotify && converted && !rec.convertedAlerted) {
        await bot.telegram.sendMessage(
          config.telegram.allowedUserId,
          msgConverted(rec.tokenId, d.baseSymbol, rec.symbol, rec.side === 'token'),
          {
            ...html,
            reply_markup: {
              inline_keyboard: [
                [{ text: '🗑️ Withdraw Position', callback_data: `rm:${rec.tokenId}` }],
                [{ text: '📊 View Position Details', callback_data: `back:card:${rec.tokenId}` }],
                [{ text: '❌ Dismiss Alert', callback_data: 'dismiss' }],
              ],
            },
          },
        );
        store.update(rec.tokenId, { convertedAlerted: true });
      } else if (rec.convertedAlerted && d.inRange) {
        store.update(rec.tokenId, { convertedAlerted: false });
      }

      // Alert anjlok: harga token vs entry. Sekali per crossing; re-arm saat pulih.
      const entry = rec.entryPrice ? Number(rec.entryPrice) : 0;
      const cur = Number(d.currentPrice);
      const dropLimit = cfg.dropPct ?? DROP_ALERT_PCT;
      if (cfg.dropPct !== null && entry > 0 && cur > 0) {
        const dropPct = (1 - cur / entry) * 100;
        if (dropPct >= dropLimit && !rec.dropAlerted) {
          // Tombol menuju kartu KONFIRMASI tutup (stop:), bukan kirim tx — invariant
          // §8.5 utuh, tapi user tak perlu mengetik command saat harga jatuh.
          await bot.telegram.sendMessage(
            config.telegram.allowedUserId,
            msgPriceDrop(rec.tokenId, rec.symbol, dropPct, d.baseSymbol),
            {
              ...html,
              reply_markup: {
                inline_keyboard: [[{ text: '⛔ Close Now', callback_data: `stop:${rec.tokenId}` }]],
              },
            },
          );
          store.update(rec.tokenId, { dropAlerted: true });
        } else if (rec.dropAlerted && dropPct < dropLimit - (DROP_ALERT_PCT - DROP_REARM_PCT)) {
          store.update(rec.tokenId, { dropAlerted: false });
        }
      }
      // Alert rugi bersih (IL setelah fee): nilai posisi + fee vs modal saat buka.
      // Sekali per crossing, dipulihkan lewat penanda yang sama seperti alert anjlok.
      if (cfg.ilPct !== null && !rec.imported) {
        const init = Number(ethers.formatUnits(BigInt(rec.initialWethWei || '0'), d.baseDecimals));
        const now = Number(ethers.formatUnits(d.valueBaseWei + d.feesBaseWei, d.baseDecimals));
        if (init > 0) {
          const lossPct = (1 - now / init) * 100;
          if (lossPct >= cfg.ilPct && !rec.ilAlerted) {
            await bot.telegram.sendMessage(
              config.telegram.allowedUserId,
              msgIlAlert(rec.tokenId, rec.symbol, lossPct, cfg.ilPct),
              {
                ...html,
                reply_markup: {
                  inline_keyboard: [[{ text: '⛔ Close Now', callback_data: `stop:${rec.tokenId}` }]],
                },
              },
            );
            store.update(rec.tokenId, { ilAlerted: true });
          } else if (rec.ilAlerted && lossPct < cfg.ilPct - 5) {
            store.update(rec.tokenId, { ilAlerted: false });
          }
        }
      }
      store.update(rec.tokenId, { lastInRange: d.inRange });
    } catch (e) {
      // Posisi sudah di-burn (NFT hilang) → catat ke jurnal & keluarkan dari store.
      // TAPI jangan sentuh yang sedang ditutup jalur manual: dia yang punya angka
      // hasil cash-out; menjurnalkan 'burned' di sini = entri ganda / PnL hilang.
      if (
        /invalid token id/i.test(String((e as Error)?.message ?? e)) &&
        !store.closing.has(rec.tokenId) &&
        store.get(rec.tokenId)?.status === 'ACTIVE'
      ) {
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
      if (st.inRange !== null && v4store.setV4InRange(rec.tokenId, st.inRange)) {
        await bot.telegram.sendMessage(config.telegram.allowedUserId, msgV4Range(rec.tokenId, st.inRange), html);
      }
    } catch {
      /* lewati ronde ini */
    }
  }
}
