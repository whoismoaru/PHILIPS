import { execFile } from 'node:child_process';

/**
 * Fills the GAPS in screening data, from the GMGN OpenAPI.
 *
 * Why through the CLI rather than plain HTTP: GMGN's endpoints want a private-key
 * signature (the X-Signature header) whose scheme exists only inside the gmgn-cli bundle.
 * Rebuilding that scheme from a minified bundle would break the moment GMGN changed it.
 * The CLI is already installed, already handles auth, and answers in about 0.6 s.
 *
 * EVERY failure fails open with null: GMGN is supplementary. If it goes down, screening
 * still runs on its own sources and the card prints '?'. Decoration must never stand in
 * the way of a decision.
 */

// The binary path must not be pinned to one machine: look it up on PATH by default, and
// allow GMGN_CLI_BIN to override when npm's global bin is not on the service's PATH.
const BIN = process.env.GMGN_CLI_BIN || 'gmgn-cli';
// Four seconds: GMGN sits on the price-critical path (getEthUsd and market cap). A long
// timeout freezes Telegram commands whenever GMGN is slow; four seconds is ample for its
// usual ~0.5 s response and falls back to DexScreener quickly when it stalls.
const TIMEOUT_MS = 4_000;

/** Our chain key -> GMGN's chain name. Absent from the map means GMGN has no such chain. */
// NOTE: 'arc' and 'stable' need gmgn-cli >= 1.5.8 -- older builds validate the chain name
// LOCALLY and reject arc before the request is ever made. Check with `gmgn-cli --version`.
const CHAIN: Record<string, string> = { robinhood: 'robinhood', bsc: 'bsc', arc: 'arc' };

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
  /** Owner privileges or flags detected (pausable, cooldown and so on).
   *  null means the security payload could not be read; [] means read, and there are none. */
  privileges: string[] | null;
  /** true when the tag counts (dev/insiders/sniper/bundler) cover only the top 100 holders */
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
      // NEVER pass process.env along: that hands PRIVATE_KEY and the bot token to
      // a third-party process. gmgn-cli only needs the API key plus PATH and HOME.
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

/** Chains whose PRICE GMGN's `token info` supports. HyperEVM and Ink are absent: DexScreener. */
const PRICE_CHAIN: Record<string, string> = { robinhood: 'robinhood', bsc: 'bsc', base: 'base', arc: 'arc' };
const priceCache = new Map<string, { t: number; v: { priceUsd: number; mcapUsd: number | null } | null }>();

/**
 * Live price and market cap from GMGN's `token info`. null means GMGN does not cover the
 * chain, the call failed, or the price came back 0 -- and the caller MUST fall back to
 * DexScreener. Market cap is price x circulating supply; GMGN returns both.
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
  // Only an ANSWER is cached. A timeout or rate-limit hit cached as null blanked the price
  // on every card for 15 minutes (23 Sep 2026, $GPU): a miss must be retried, not remembered.
  if (v) priceCache.set(key, { t: Date.now(), v });
  return v;
}

/** GMGN ratios arrive as 0..1 ("0.1672"); the card wants percentages. */
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
    const holderTags = [...(h.tags ?? []), ...(h.maker_token_tags ?? [])];
    return tags.some((t) => holderTags.includes(t));
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

  // MUST be lowercase: the token/holders endpoint returns {list:[]} for a checksummed
  // (mixed-case) address, while token/security accepts one. Confirmed by sending both
  // forms of the same address.
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
    // privileges/flags may hold strings or objects, so take whatever reads as a name. An
    // empty array is an ANSWER ("no privileges"), not "unknown".
    const names = [...(sec.privileges ?? []), ...(sec.flags ?? [])]
      .map((x: any) => String(typeof x === 'string' ? x : (x?.name ?? x?.type ?? x?.key ?? '')).toLowerCase())
      .filter(Boolean);
    out.privileges = names;
    // burn_ratio alone often reads '0' even when the LP was sent to a burn address, so the
    // locked share held at a burn address is counted too.
    const burn = ratioToPct(sec.burn_ratio);
    const holeLock = (sec.lock_summary?.lock_detail ?? [])
      .filter((d: any) => d?.is_blackhole)
      .reduce((s: number, d: any) => s + (Number(d.percent) || 0), 0);
    out.burntPct = burn !== null || holeLock > 0 ? (burn ?? 0) + holeLock * 100 : null;
    // LP Locked: the sum of every lock, blackhole included, since LP in a blackhole is still locked.
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
