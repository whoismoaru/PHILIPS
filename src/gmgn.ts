import { execFile } from 'node:child_process';

/**
 * Pengisi CELAH data screening dari GMGN OpenAPI.
 *
 * Kenapa lewat CLI, bukan HTTP langsung: endpoint GMGN meminta tanda tangan
 * private key (header X-Signature) yang skemanya hanya ada di bundle gmgn-cli.
 * Membuat ulang skema itu dari bundle terminifikasi akan pecah begitu GMGN
 * mengubahnya. CLI-nya sudah terpasang, sudah menangani auth, dan responsnya
 * ~0.6 detik — cukup cepat.
 *
 * SEMUA kegagalan fail-open (null): GMGN adalah data TAMBAHAN. Kalau ia mati,
 * screening PHILIPS tetap jalan dengan sumbernya sendiri dan kartu menulis '?'.
 * Data hiasan tak boleh menghalangi keputusan.
 */

const BIN = '/home/ubuntu/.npm-global/bin/gmgn-cli';
const TIMEOUT_MS = 12_000;

/** PHILIPS key → nama chain GMGN. Tak ada di peta = GMGN tak mendukung chain itu. */
const CHAIN: Record<string, string> = { robinhood: 'robinhood', bsc: 'bsc' };

export type GmgnExtra = {
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  devPct: number | null;
  insidersPct: number | null;
  sniperCount: number | null;
  bundlerPct: number | null;
  lpLockedPct: number | null;
  burntPct: number | null;
  honeypot: boolean | null;
  renounced: boolean | null;
  openSource: boolean | null;
  top10Pct: number | null;
  /** Nama privilege/flag owner yang terdeteksi (pausable, cooldown, dst).
   *  null = payload security tak terbaca; [] = terbaca & tak ada satupun. */
  privileges: string[] | null;
  /** true bila angka tag (dev/insiders/sniper/bundler) hanya dari 100 holder terbesar */
  tagsFromTop100: boolean;
};

const EMPTY: GmgnExtra = {
  buyTaxPct: null,
  sellTaxPct: null,
  devPct: null,
  insidersPct: null,
  sniperCount: null,
  bundlerPct: null,
  lpLockedPct: null,
  burntPct: null,
  honeypot: null,
  renounced: null,
  openSource: null,
  top10Pct: null,
  privileges: null,
  tagsFromTop100: false,
};

const cache = new Map<string, { t: number; v: GmgnExtra }>();
const TTL = 60_000;

function run(args: string[]): Promise<any | null> {
  if (!process.env.GMGN_API_KEY) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      BIN,
      [...args, '--raw'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 << 20, env: process.env },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Rasio GMGN datang sebagai 0..1 ("0.1672"). Kartu memakai persen. */
const ratioToPct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : null;
};
const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export async function gmgnExtra(ca: string, chainKey: string): Promise<GmgnExtra> {
  const chain = CHAIN[chainKey];
  if (!chain || !process.env.GMGN_API_KEY) return EMPTY;

  // WAJIB huruf kecil: endpoint token/holders mengembalikan {list:[]} untuk alamat
  // ber-checksum (huruf campur), sementara token/security menerimanya. Terbukti
  // dengan membandingkan kedua bentuk pada CA yang sama.
  const addr = ca.toLowerCase();
  const key = `${chain}:${addr}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  const base = ['--chain', chain, '--address', addr];
  const [sec, hold] = await Promise.all([
    run(['token', 'security', ...base]),
    run(['token', 'holders', ...base, '--limit', '100']),
  ]);

  const out: GmgnExtra = { ...EMPTY };

  if (sec) {
    out.buyTaxPct = ratioToPct(sec.buy_tax);
    out.sellTaxPct = ratioToPct(sec.sell_tax);
    out.honeypot = boolOf(sec.is_honeypot);
    out.renounced = boolOf(sec.is_renounced);
    out.openSource = boolOf(sec.is_open_source);
    out.top10Pct = ratioToPct(sec.top_10_holder_rate);
    // privileges/flags bisa berisi string atau objek — ambil apa pun yang bisa dibaca
    // sebagai nama. Array kosong itu JAWABAN ('tak ada privilege'), bukan 'tak tahu'.
    const names = [...(sec.privileges ?? []), ...(sec.flags ?? [])]
      .map((x: any) => String(typeof x === 'string' ? x : (x?.name ?? x?.type ?? x?.key ?? '')).toLowerCase())
      .filter(Boolean);
    out.privileges = names;
    // Burnt: burn_ratio saja sering '0' walau LP dikirim ke blackhole, jadi
    // jumlahkan juga bagian lock yang alamatnya blackhole.
    const burn = ratioToPct(sec.burn_ratio);
    const holeLock = (sec.lock_summary?.lock_detail ?? [])
      .filter((d: any) => d?.is_blackhole)
      .reduce((s: number, d: any) => s + (Number(d.percent) || 0), 0);
    out.burntPct = burn !== null || holeLock > 0 ? (burn ?? 0) + holeLock * 100 : null;
    // LP Locked: total semua lock (termasuk blackhole — LP di blackhole tetap terkunci).
    const allLock = (sec.lock_summary?.lock_detail ?? []).reduce(
      (s: number, d: any) => s + (Number(d.percent) || 0),
      0,
    );
    out.lpLockedPct = sec.lock_summary ? allLock * 100 : null;
  }

  const list: any[] = hold?.list ?? hold?.holders ?? (Array.isArray(hold) ? hold : []);
  if (list.length) {
    out.tagsFromTop100 = true;
    const tagged = (h: any, t: string): boolean =>
      (h.tags ?? []).includes(t) || (h.maker_token_tags ?? []).includes(t);
    const sumPct = (t: string): number =>
      list.filter((h) => tagged(h, t)).reduce((s, h) => s + (Number(h.amount_percentage) || 0), 0) * 100;
    out.devPct = sumPct('dev');
    out.insidersPct = sumPct('rat_trader');
    out.bundlerPct = sumPct('bundler');
    out.sniperCount = list.filter((h) => tagged(h, 'sniper')).length;
  }

  cache.set(key, { t: Date.now(), v: out });
  return out;
}
