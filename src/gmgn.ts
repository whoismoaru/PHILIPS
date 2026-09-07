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

// Jalur biner tak boleh dipatok ke satu mesin: default cari di PATH, boleh
// ditimpa lewat GMGN_CLI_BIN kalau npm global bin tak ada di PATH service.
const BIN = process.env.GMGN_CLI_BIN || 'gmgn-cli';
// 4 dtk: GMGN dipakai di jalur kritis harga (getEthUsd/mcap). Timeout lama bikin
// command Telegram nge-freeze saat GMGN lambat; 4 dtk cukup buat respons normal
// (~0.5s) dan cepat mundur ke DexScreener kalau ngadat.
const TIMEOUT_MS = 4_000;

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
/**
 * How long a GMGN answer is reused.
 *
 * This was 60s, which is far shorter than the data changes. Taxes, privileges, LP
 * lock, top-10 share and holder tags move over hours, not minutes, so a one-minute
 * TTL mostly bought re-fetches of identical numbers.
 *
 * That matters beyond speed: GMGN rate-limits per IP, and REXONA runs on this same
 * box against the same key. Every avoidable call here is quota taken from its alert
 * lane — measured, 45% of REXONA's rate-limit hits landed within 90s of activity on
 * this bot. The audit card's Refresh button clears this cache explicitly (see
 * `bustGmgnCache`), so a longer TTL never blocks a deliberate re-read.
 */
const TTL = 15 * 60_000;

/** Drop one token's cached answer, so Refresh really re-reads. */
export function bustGmgnCache(addr: string): void {
  const a = addr.toLowerCase();
  for (const k of [...cache.keys()]) if (k.toLowerCase().includes(a)) cache.delete(k);
}

/** Real (uncached) CLI calls made this process. Logged so the quota has a witness. */
let calls = 0;

function run(args: string[]): Promise<any | null> {
  if (!process.env.GMGN_API_KEY) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      BIN,
      [...args, '--raw'],
      // JANGAN oper process.env: itu menyerahkan PRIVATE_KEY & token bot ke
      // proses pihak ketiga. gmgn-cli hanya butuh api key + PATH/HOME.
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 8 << 20,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          GMGN_API_KEY: process.env.GMGN_API_KEY ?? '',
        },
      },
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

/** Chain yang GMGN `token info` dukung untuk HARGA. hyperevm/ink TAK ada → DexScreener. */
const PRICE_CHAIN: Record<string, string> = { robinhood: 'robinhood', bsc: 'bsc', base: 'base' };
const priceCache = new Map<string, { t: number; v: { priceUsd: number; mcapUsd: number | null } | null }>();

/**
 * Harga & market cap dari GMGN `token info` (realtime). null = GMGN tak dukung
 * chain / gagal / harga 0 → pemanggil WAJIB fallback ke DexScreener. mcap = harga
 * × circulating supply (GMGN kembalikan keduanya).
 */
export async function gmgnPrice(ca: string, chainKey: string): Promise<{ priceUsd: number; mcapUsd: number | null } | null> {
  const chain = PRICE_CHAIN[chainKey];
  if (!chain || !process.env.GMGN_API_KEY) return null;
  const key = `${chain}:${ca.toLowerCase()}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const j = await run(['token', 'info', '--chain', chain, '--address', ca.toLowerCase()]);
  const px = Number(j?.price?.price);
  let v: { priceUsd: number; mcapUsd: number | null } | null = null;
  if (Number.isFinite(px) && px > 0) {
    const supply = Number(j?.circulating_supply ?? j?.total_supply);
    v = { priceUsd: px, mcapUsd: Number.isFinite(supply) && supply > 0 ? px * supply : null };
  }
  priceCache.set(key, { t: Date.now(), v });
  return v;
}

/** Rasio GMGN datang sebagai 0..1 ("0.1672"). Kartu memakai persen. */
const ratioToPct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : null;
};
const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/**
 * Holder tags rolled up into the four figures the audit card shows.
 *
 * Exported so it can be tested WITHOUT a network call: the bug it exists to
 * prevent is a silent one. GMGN's vocabulary does NOT use the names this code
 * once looked for — a Robinhood payload carries `dev_team` and `creator`, never
 * a bare `dev` — so Dev Wallet printed a confident 0% for tokens whose developer
 * was tagged and holding. That is a lie in the safe direction, the one this card
 * must never tell. Matching a set of aliases keeps a future rename from silently
 * zeroing a row instead of failing loudly.
 */
export function tagStats(list: any[]): Pick<GmgnExtra, 'devPct' | 'insidersPct' | 'bundlerPct' | 'sniperCount'> {
  const tagged = (h: any, tags: readonly string[]): boolean => {
    const punya = [...(h.tags ?? []), ...(h.maker_token_tags ?? [])];
    return tags.some((t) => punya.includes(t));
  };
  const sumPct = (tags: readonly string[]): number =>
    list.filter((h) => tagged(h, tags)).reduce((s, h) => s + (Number(h.amount_percentage) || 0), 0) * 100;
  return {
    devPct: sumPct(['dev', 'dev_team', 'creator']),
    insidersPct: sumPct(['rat_trader', 'insider', 'sandwich_bot']),
    bundlerPct: sumPct(['bundler']),
    sniperCount: list.filter((h) => tagged(h, ['sniper'])).length,
  };
}

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
  // SEQUENTIAL, not Promise.all. These are two heavy endpoints, and firing them
  // together is a burst against a leaky bucket that REXONA is already drawing from
  // steadily. Back to back they cost the same quota but never spike, at the price of
  // roughly half a second on a card the user is already waiting on.
  const sec = await run(['token', 'security', ...base]);
  const hold = await run(['token', 'holders', ...base, '--limit', '100']);
  calls += 2;
  console.log(`[gmgn] ${chain}/${addr.slice(0, 10)} security+holders · ${calls} calls this run`);

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
    Object.assign(out, tagStats(list));
  }

  cache.set(key, { t: Date.now(), v: out });
  return out;
}
