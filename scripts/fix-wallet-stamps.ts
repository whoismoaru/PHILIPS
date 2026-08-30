/**
 * Cap ulang entri jurnal yang salah pemilik.
 *
 * Field `wallet` baru ditambahkan 22 Agu 2026 lewat backfill (lihat
 * `journal.jsonl.bak-prewallet-*`), dan backfill itu MENEBAK: entri lama dicap
 * wallet yang sedang aktif saat migrasi, bukan wallet yang benar-benar melakukan
 * trade-nya. Akibatnya /pnl menghitung trade wallet lama sebagai milik wallet
 * sekarang.
 *
 * Batasnya diambil dari RANTAI, bukan tebakan: transaksi PERTAMA wallet aktif di
 * chain itu. Entri yang ditutup sebelum wallet itu pernah menyentuh chain tersebut
 * mustahil miliknya. Chain tanpa explorer memakai batas terverifikasi paling awal
 * dari chain lain — disebutkan terang-terangan di laporan, bukan didiamkan.
 *
 *   npx tsx scripts/fix-wallet-stamps.ts          # laporan saja (tak menulis)
 *   npx tsx scripts/fix-wallet-stamps.ts --tulis  # cadangkan lalu tulis
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, getChain } from '../src/chains.js';
import { EXPLORER_HEADERS } from '../src/chain.js';
import * as journal from '../src/journal.js';

const TULIS = process.argv.includes('--tulis');
const FILE = join(process.cwd(), 'data', 'journal.jsonl');
const ME = journal.currentWallet();
if (!ME) throw new Error('wallet tak tersambung — tak ada acuan untuk mencap ulang.');

const wib = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

/** Transaksi pertama alamat ini di sebuah chain, atau null bila tak terperiksa. */
async function firstTx(chainKey: string, addr: string): Promise<number | null> {
  const cc = getChain(chainKey);
  if (!cc?.blockscout) return null;
  let url = `${cc.blockscout}/addresses/${addr}/transactions`;
  let last: { timestamp: string } | null = null;
  for (let i = 0; i < 300; i++) {
    const r: any = await fetch(url, { headers: EXPLORER_HEADERS }).then((x) => x.json()).catch(() => null);
    if (!r) return null;
    if (r.items?.length) last = r.items[r.items.length - 1];
    if (!r.next_page_params) break; // sampai ujung — ini benar-benar yang tertua
    const q = new URLSearchParams(Object.entries(r.next_page_params).map(([k, v]) => [k, String(v)]));
    url = `${cc.blockscout}/addresses/${addr}/transactions?${q}`;
  }
  return last ? new Date(last.timestamp).getTime() : null;
}

const batas = new Map<string, number>();
for (const key of Object.keys(CHAINS)) {
  const t = await firstTx(key, ME);
  if (t !== null) {
    batas.set(key, t);
    console.log(`${key.padEnd(10)} tx pertama wallet ini: ${wib(t)} WIB  (terverifikasi on-chain)`);
  } else {
    console.log(`${key.padEnd(10)} tak ada explorer — pakai batas terverifikasi paling awal`);
  }
}
const cadangan = batas.size ? Math.min(...batas.values()) : null;
if (cadangan === null) throw new Error('tak satu pun chain bisa diverifikasi — berhenti, jangan menebak.');

// Pemilik pengganti = wallet lain yang paling banyak muncul di jurnal.
const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
const entries = lines.map((l) => JSON.parse(l) as journal.JournalEntry & Record<string, unknown>);
const hitung = new Map<string, number>();
for (const e of entries) if (e.wallet && e.wallet !== ME) hitung.set(e.wallet, (hitung.get(e.wallet) ?? 0) + 1);
const sebelumnya = [...hitung.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
if (!sebelumnya) throw new Error('tak ada wallet lain di jurnal — tak ada yang perlu dicap ulang.');

let diubah = 0;
const per = new Map<string, number>();
for (const e of entries) {
  if (e.wallet !== ME) continue;
  const chain = e.chain ?? 'robinhood';
  const b = batas.get(chain) ?? cadangan;
  if (e.closedAt >= b) continue;
  e.wallet = sebelumnya;
  diubah++;
  per.set(chain, (per.get(chain) ?? 0) + 1);
}

console.log(`\nwallet aktif     : ${ME}`);
console.log(`dicap ulang ke   : ${sebelumnya}`);
for (const [k, n] of per) console.log(`  ${k.padEnd(10)} ${n} entri${batas.has(k) ? '' : '  (batas pinjaman — tak terverifikasi)'}`);
console.log(`total            : ${diubah} entri dari ${entries.length}`);

if (!TULIS) {
  console.log('\n(laporan saja — jalankan dengan --tulis untuk menerapkan)');
} else if (diubah > 0) {
  const bak = `${FILE}.bak-wallet-${Date.now()}`;
  copyFileSync(FILE, bak);
  writeFileSync(FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`\ncadangan: ${bak}\nditulis : ${FILE}`);
} else {
  console.log('\ntak ada yang perlu diubah.');
}
