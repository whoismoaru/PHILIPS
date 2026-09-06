/**
 * Contract audit from Serialized Audit (https://www.serializedaudit.io).
 *
 * This is the only source in the screening stack that covers ROBINHOOD, the
 * default chain. GoPlus deliberately skips it (goplus.ts explains why) and
 * Blockscout only answers "is there source code", not "what does the source do".
 *
 * It is also the only one that audits the Uniswap V4 HOOK. That matters more
 * here than anywhere else: this bot's whole job is opening V4 positions, and a
 * hook can tax, freeze, or drain a pool while the token contract itself reads
 * perfectly clean. A token-only verdict is a partial verdict on V4.
 *
 * EVERY failure fails open (null), like gmgn.ts, insightx.ts and goplus.ts.
 */

const BASE = 'https://www.serializedaudit.io/api/audit-contract';
const TIMEOUT_MS = 12_000;

/** PHILIPS key -> Serialized chain symbol. Not in the map means no call is made. */
const CHAIN: Record<string, string> = {
  robinhood: 'ROBINHOOD',
  bsc: 'BSC',
  base: 'BASE',
  hyperevm: 'HYPE',
  ink: 'INK',
};

export type AuditRisk = {
  type: string; // 'HiddenFees' | 'LiquidityDrain' | …
  impact: string; // 'critical' | 'warning' | 'info'
  description: string;
  mitigated: boolean | null; // true = the risk exists in code but is neutralised
  gateReason: string | null; // display-ready state, e.g. 'Owner renounced'
};

/**
 * What the card should actually show, per the API's own guidance: drop `info`
 * (surfaced but low risk on its own) and drop anything already neutralised.
 *
 * A mitigated risk is real code that CANNOT fire — the owner renounced, the role
 * has no holders. Printing it as a live warning cries wolf on the majority of
 * renounced tokens, and a card that warns about everything warns about nothing.
 */
export const activeRisks = (rs: AuditRisk[]): AuditRisk[] =>
  rs.filter((r) => r.impact.toLowerCase() !== 'info' && r.mitigated !== true);

export type SerializedInfo = {
  isSafe: boolean | null; // token AND hook together
  tokenSafe: boolean | null;
  hookSafe: boolean | null;
  summary: string | null; // one-line, human readable
  risks: AuditRisk[]; // token contract
  hookAddress: string | null;
  hookRisks: AuditRisk[];
  hookSummary: string | null;
  verified: boolean | null; // sourceType !== 'none'
  isProxy: boolean | null;
};

/**
 * 15 minutes, not the 60 seconds the other sources use. Every call here is
 * BILLED (4 credits for a fresh audit, 1 for a refresh), and a contract's
 * bytecode does not change on a one-minute cadence. The audit card's Refresh
 * button clears this entry explicitly, so a deliberate refresh still pays for
 * live data — only incidental repeat reads are served from memory.
 */
const cache = new Map<string, { t: number; v: SerializedInfo | null }>();
const TTL = 15 * 60_000;

export const bustSerializedCache = (addr: string): void => {
  for (const k of cache.keys()) if (k.endsWith(addr.toLowerCase())) cache.delete(k);
};

const risksOf = (v: unknown): AuditRisk[] =>
  (Array.isArray(v) ? v : [])
    .map((r: any) => ({
      type: String(r?.type ?? ''),
      impact: String(r?.impact ?? ''),
      description: String(r?.description ?? ''),
      mitigated: typeof r?.mitigated === 'boolean' ? r.mitigated : null,
      gateReason: typeof r?.gateReason === 'string' ? r.gateReason : null,
    }))
    .filter((r) => r.type || r.description);

const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export async function serializedInfo(addr: string, chainKey: string): Promise<SerializedInfo | null> {
  const chain = CHAIN[chainKey];
  const key = process.env.SERIALIZED_API_KEY;
  if (!chain || !key) return null;

  const ck = `${chain}:${addr.toLowerCase()}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  let out: SerializedInfo | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(`${BASE}?chain=${chain}&address=${addr}`, {
      headers: { 'X-Auth-Key': key, accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      const a = (await r.json())?.audit;
      if (a) {
        const hook = a.hookAudit ?? null;
        out = {
          isSafe: boolOf(a.isSafe),
          tokenSafe: boolOf(a.isTokenSafe),
          hookSafe: boolOf(a.isHookSafe),
          summary: typeof a.description === 'string' ? a.description : null,
          risks: risksOf(a.vulnerabilities),
          hookAddress: typeof a.hookAddress === 'string' ? a.hookAddress : null,
          hookRisks: risksOf(hook?.vulnerabilities),
          hookSummary: typeof hook?.description === 'string' ? hook.description : null,
          // 'none' means no published source. Blockscout answers this for chains
          // that have one; this fills the gap for the chains that do not.
          verified: typeof a.sourceType === 'string' ? a.sourceType !== 'none' : null,
          isProxy: boolOf(a.isProxy),
        };
      }
    } else {
      // 401/402 are OPERATOR problems (bad key, credits exhausted), not token
      // problems. Saying so once beats a card that silently loses a whole section.
      console.warn(`[serialized] ${chain}/${addr.slice(0, 10)} HTTP ${r.status}`);
    }
  } catch {
    out = null;
  }
  cache.set(ck, { t: Date.now(), v: out });
  return out;
}
