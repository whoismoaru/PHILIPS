/**
 * PHILIPS — Telegram message cards (HTML only).
 *
 * Design: plain text — a bold title plus 'label · value' bullets.
 * NO <pre>, no box drawing, no padEnd alignment: Telegram's font is
 * proportional, so a "terminal" look always falls apart on a phone.
 *
 *  <b>POSITION · #178449</b>
 *  • Pair · WETH / TENDIES (1.00%)
 *  • Deposit · 0.09 WETH
 */
import { ethers } from 'ethers';
import type { BaseKind } from './chains.js';
import { explainRevert } from './revert.js';
import { TRADE_LIMIT_PCT, SELL_IMPACT_PCT } from './tradeLimit.js';

// ─── primitives ────────────────────────────────────────────────────

export function esc(t: string | number | bigint): string {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function code(v: string | number | bigint): string {
  return `<code>${esc(v)}</code>`;
}

export function bold(v: string | number | bigint): string {
  return `<b>${esc(v)}</b>`;
}

export function italic(v: string | number | bigint): string {
  return `<i>${esc(v)}</i>`;
}

/** Primary title: POSITION · #178449 */
export function title(...parts: string[]): string {
  return bold(parts.filter(Boolean).join(' · '));
}

/** One "label · value" line (plain text, not monospace). */
export function field(label: string, value: string, _width = 0): string {
  return `${label} · ${value}`;
}

/** Several label/value lines; empty values are dropped. */
export function fieldBlock(rows: Array<[string, string]>, _minWidth = 6): string {
  const clean = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (clean.length === 0) return '';
  return clean.map(([l, v]) => `${esc(l)} · ${bold(String(v))}`).join('\n');
}

/** A label · value line with the value bolded, not monospaced. */
export function hrow(label: string, value: string | number): string {
  return `${esc(label)} · ${bold(value)}`;
}

/** Several hybrid lines; empty values are skipped. */
export function hrows(rows: Array<[string, string | number | null | undefined]>): string[] {
  return rows
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([l, v]) => hrow(l, String(v)));
}

/** Loose kv (non-aligned) for one-liners outside field sheets. */
export function kv(label: string, valueHtml: string): string {
  return `${esc(label)} · ${valueHtml}`;
}

export function note(text: string): string {
  return italic(text);
}

export function quoteHtml(innerHtml: string): string {
  return `<blockquote>${innerHtml}</blockquote>`;
}

/** A 'label · value' block (plain text). */
/** A list of rows, each row joining its cells with ' · '. Headers are dropped (there are no columns). */
export function alignTable(header: string[], rows: string[][], _right: boolean[] = []): string {
  return rows.map((cells) => cells.filter((c) => c !== '' && c != null).join(' · ')).join('\n');
}

// ─── header ────────────────────────────────────────────────────────

/** Card title — plain bold text, no box or monospace. */
export function hdr(text: string): string {
  return `<b>${esc(text)}</b>`;
}

/** Dynamic emoji for a PnL figure: green, red or neutral. */
export function dot(n: number | null | undefined): string {
  if (n === null || n === undefined) return '⚪';
  return n > 0 ? '🟢' : n < 0 ? '🔴' : '⚪';
}

/** A bullet list of 'label · value' (no tree lines). */
export function tree(rows: Array<[string, string]>, _width = 12): string[] {
  return rows.map(([k, v]) => `• ${esc(k)} · ${v}`);
}

/** Plain text (this used to be a <pre> block). */
export function pre(text: string): string {
  return esc(text);
}

export function card(titleLine: string, body: string[], footer?: string): string {
  const parts = [titleLine, ''];
  parts.push(...body);
  if (footer) {
    parts.push('');
    parts.push(italic(footer));
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n');
}

// ─── number / money helpers ────────────────────────────────────────

export function cleanUnits(wei: bigint, dec: number): string {
  return Number(ethers.formatUnits(wei, dec)).toLocaleString('id-ID', {
    maximumFractionDigits: 4,
  });
}

export function fmtEth(wei: bigint): string {
  return Number(ethers.formatEther(wei)).toFixed(6);
}

export function usdSigned(n: number): string {
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
}

export function usdPlain(n: number): string {
  // Grouped, id-ID (1.268,62): the owner's own locale, and every figure in the bot uses
  // it -- a card that groups one way while the next groups another reads as two
  // different products, and "1.268" would be read as one-point-two-six-eight.
  return '$' + n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Compact USD: $1.5M / $50.9K / $79. For pool lists and depth. */
export function usdCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}

/** Signed percentage, ONE format across the whole bot: '+13.3%' / '-0.7%'. */
export function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

export function feeLabel(fee: number): string {
  return `${(fee / 10000).toFixed(2)}%`;
}

export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

export function shortAddr(a: string): string {
  const s = String(a);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function modeLabel(dryRun: boolean): string {
  return dryRun ? 'DRY RUN' : 'LIVE';
}

/** The owner's local time (WIB, UTC+7), not UTC: these cards are read on a phone in Jakarta. */
/** Clock only: "22:10 WIB". Internal -- cards stamp the date too, see nowWib(). */
function timeWib(): string {
  const d = new Date(Date.now() + 7 * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} WIB`;
}

/**
 * The stamp every card carries: "12 Sep 2026, 22:10 WIB".
 *
 * The date is not decoration. These cards are scrolled back to days later to find when
 * money moved, and a bare "22:10" cannot tell yesterday's fill from last week's.
 */
export function nowWib(): string {
  const d = new Date(Date.now() + 7 * 3_600_000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${timeWib()}`;
}


/**
 * "14 September 2026" -- the month spelled out, no clock.
 *
 * Every card that reports MONEY ALREADY BOOKED carries this: a recap covers a whole period
 * and a close has already happened, so the minute either was drawn says nothing, and a
 * timezone on it is one more thing to misread. Built the same way as nowWib (UTC shifted by
 * 7) rather than through a locale, which on a server set to another zone returns yesterday.
 */
export function dateWibFull(): string {
  const d = new Date(Date.now() + 7 * 3_600_000);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function footerMode(dryRun?: boolean): string {
  if (dryRun === undefined) return nowWib();
  return `${modeLabel(dryRun)} · ${nowWib()}`;
}

/** Parse multi-chain balance string into field rows. */
function balanceFields(gasEth: string): Array<[string, string]> {
  const raw = (gasEth || '').trim();
  if (!raw) return [['balance', '—']];

  const parts = raw.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean);

  if (parts.length === 1 && /^\d+(\.\d+)?$/.test(parts[0])) {
    return [['balance', `${parts[0]} ETH`]];
  }
  if (parts.length === 1) {
    return [['balance', parts[0]]];
  }

  // "Robinhood 0.0376 ETH" -> chain as the label, amount as the value
  return parts.map((p) => {
    const m = p.match(/^(\S+)\s+(.+)$/);
    return m ? ([m[1].toLowerCase(), m[2]] as [string, string]) : (['balance', p] as [string, string]);
  });
}

// ─── cards ─────────────────────────────────────────────────────────

// The cockpit body shared by /start and /help: VIEW/EXECUTION/EMERGENCY in a tree.
function cockpitLines(dryRun: boolean): string[] {
  const grp = (rows: Array<[string, string]>) => rows.map(([c, d], i) => `${i + 1}. ${c}: ${esc(d)}`);
  return [
    bold('View :'),
    ...grp([
      ['/portfolio', 'balances and equity, per chain'],
      ['/positions', 'active LPs, live'],
      ['/pnl', 'recap of closed trades'],
      ['/gas', 'what a transaction costs on each chain'],
    ]),
    '',
    bold('Move funds :'),
    ...grp([
      ['/claim_fees', 'harvest fees, the position stays open'],
      ['/swap', 'swap a token you hold'],
      ['/bridge', 'move funds across chains'],
      ['/withdraw', 'withdraw to another address'],
    ]),
    '',
    bold('Setup :'),
    ...grp([
      ['/settings', 'mode, limits, LP shape and quick percentages'],
      ['/alerts', 'what PHILIPS notifies you about'],
    ]),
    '',
    // The only place these entry points are named: neither has a button or a menu entry.
    'Paste a token CA into this chat to open its audit card, that is where Add LP and Buy start.',
    // The single most important behaviour change to know about before tapping anything.
    // The one line on this card that changes how you tap. It has to name EVERY path that
    // now goes straight out: closing lost its confirmation the same day swapping did, and
    // a list that stops at three reads as a promise about the other two.
    dryRun
      ? 'mode: DRY RUN, no transaction is ever sent.'
      : 'nothing asks twice: swap, bridge, withdraw and opening an LP execute on the amount you enter, and Close Position executes on the tap.',
    '',
    note(nowWib()),
  ];
}

/** The command list card (/help). */
export function msgHelp(dryRun: boolean): string {
  return [`\u{1F4D6} ${bold('HELP')}`, '', ...cockpitLines(dryRun)].join('\n');
}

/**
 * The /start card — a PROOF-OF-LIFE marker and nothing more (Telegram sends /start
 * automatically when a chat opens and when Start is tapped). The command list lives
 * in /help; here one state line plus the sync result is enough, so it does not become
 * two bubbles.
 */
export function msgStarted(o: {
  dryRun: boolean;
  chainLabel: string;
  chainId: string | number | bigint;
  positions: number;
  imported: number;
  gone: number;
  walletShort?: string | null;
  /** The Solana wallet, already shortened. Absent when Solana is not configured, and the
   *  row is then left out entirely rather than printed as "not connected": an owner who
   *  does not use Solana should not be told about a wallet they never set. */
  solShort?: string | null;
  /** Every chain the bot is configured for, in menu order. Falls back to chainLabel. */
  chainLabels?: string[];
}): string {
  const chains = o.chainLabels?.length ? o.chainLabels.join('/') : o.chainLabel;
  const out = [
    bold('WELCOME TO PHILIPS!'),
    '',
    'Your ultimate assistant for managing Single-Side Liquidity Pools on EVM & SOL chains. ' +
      'Streamline your DeFi strategy, from automated dip-buying and profit-taking to effortless fee tracking.',
    '',
    `\u{1F4B3} ${bold('EVM Address')} : ${code(o.walletShort ?? 'not connected')}`,
    ...(o.solShort ? [`\u{1F4B3} ${bold('SOL Address')} : ${code(o.solShort)}`] : []),
    `\u{26D3}\u{FE0F} ${bold('Chain')} : ${esc(chains)}`,
  ];
  // Position drift is reported only when it happened: silence means nothing moved, and
  // a line reading "0 imported, 0 gone" is noise on every single start.
  if (o.imported || o.gone) {
    const bits = [o.imported ? `${o.imported} imported` : '', o.gone ? `${o.gone} closed elsewhere` : ''].filter(Boolean);
    out.push('', note(`positions synced: ${bits.join(' \u00B7 ')}`));
  }
  out.push('', note(`${o.dryRun ? 'DRY RUN' : 'LIVE'} \u00B7 ${nowWib()}`));
  return out.join('\n');
}

/** How to start an LP — used by the "Open LP" button on /start (there is no CA-less wizard yet). */
export function msgAddHowTo(): string {
  return [
    `💧 ${bold('Open a Single-Side LP')}`,
    '',
    'Provide liquidity using only one token. This acts as a passive limit order where you earn trading fees while waiting for your target price.',
    '',
    `📝 ${bold('How to Start :')}`,
    `• ${bold('Quick Method ->')} Paste a token Contract Address (CA) directly in this chat.`,
    `• ${bold('Wizard Method ->')} Type ${code('/add_lp [CA]')} to enter the step-by-step setup.`,
    // The third path that genuinely exists: /add_lp with no CA opens the pair picker.
    // Unmentioned, the only way to find it is by accident.
    `• ${bold('No CA? ->')} Type ${code('/add_lp')} on its own to pick from the top pools.`,
    '',
    note(nowWib()),
  ].join('\n');
}

/** The "How it Works" card — static explanation, opened from a button on /start. */
export function msgHighRiskBlocked(reasons: string[]): string {
  const out = [
    `🚫 ${bold('Blocked: High-Risk Token')}`,
    '',
    'PHILIPS found serious security problems with this token :',
  ];
  for (const r of reasons.slice(0, 5)) out.push(`• ${esc(r)}`);
  if (!reasons.length) out.push('• audit verdict: HIGH RISK');
  out.push(
    '',
    'To protect your funds, Single-Side LP is disabled for this contract. Pick another token.',
    '',
    note('the full audit is in the card above.'),
  );
  return out.join('\n');
}

export function msgSecretLeakWarning(): string {
  return [
    `🚨 ${bold('SECURITY WARNING')} 🚨`,
    '',
    'It looks like you sent sensitive data (private key / seed phrase) outside the official connection flow.',
    '',
    `❌ ${bold('Your message was ignored and has been deleted.')}`,
    '',
    `If you meant to connect a wallet, open ${code('/settings')} and follow the steps there. Never paste a key loosely into a chat.`,
    '',
    note('any key that has already been sent to a chat should be treated as compromised. Move the funds.'),
    note('if that was just a tx hash (0x + 64 chars), ignore this: the bot never takes a tx hash as input.'),
  ].join('\n');
}

export function msgHowItWorks(): string {
  return [
    `📖 ${bold('How PHILIPS Works')}`,
    '',
    `1️⃣ ${bold('Connect your wallet')} — import it from /settings. The key is stored encrypted on this bot's server so PHILIPS can sign transactions for you.`,
    '',
    `2️⃣ ${bold('Pick a token')} — paste a contract address (CA) straight into the chat. Every token is audited first: honeypot, buy/sell tax, locked liquidity, holder spread.`,
    '',
    `3️⃣ ${bold('Open a single-side LP')} — paste the token's contract address into the chat. You deposit only one token; the position works like a passive limit order that keeps earning fees while it waits for your price.`,
    '',
    `4️⃣ ${bold('Monitor & harvest')} — /positions for in/out of range status and /claim_fees to harvest. Open a position for its Remove Liquidity and Close buttons.`,
    '',
    `⚠️ ${bold('Risk')}: price can move through your range (impermanent loss), and new tokens can rug. PHILIPS blocks the clearly dangerous ones, but the final call is always yours.`,
  ].join('\n');
}

export function msgV4Position(p: {
  tokenId: string;
  pair: string;
  feeLabel: string;
  valueLabel: string; // "$12.34" / "0.02 ETH" / "—"
  feesLabel?: string; // unclaimed fees, already included in valueLabel
  rangeLabel: string; // "+5.2% / -3.1%" / "—"
  inRange: boolean | null;
  pnlText?: string; // only when the bot manages it, so the entry is known
  tracked: boolean;
  priceWarn?: string | null; // a dying pool: the on-chain price has drifted from the market
  baseSymbol?: string; // ETH | USDG
  tokenSymbol?: string; // sisi token (non-base)
  age?: string;
  chain?: string;
  mcRange?: string; // the same range, read as market cap
  converted?: boolean; // out-of-range & 100% token seberang (target tercapai)
  ladder?: { legIndex: number; legCount: number; shape: string; groupDeposit?: string; sharePct?: number; progress?: string;
    // A summary of the WHOLE ladder, which is the point of the bid-ask feature.
    // Without it a leg card shows a single rung, when what the user deposited was a
    // ladder.
    valueLabel?: string; feesLabel?: string; pnlText?: string; mcRange?: string;
    // Why "Value now" is not simply the market price — see the note in index.ts.
    exitNote?: string;
    filled?: number; active?: number; waiting?: number }; // the legs of a ladder group
  /** The pool's own depth and activity, read fresh when the card is opened. */
  pool?: { tvl: string; vol?: string; apr: string };
  /** True when the pool index has no entry for this pool yet (new pools are missing). */
  poolUnindexed?: boolean;
  /** How far price must still move before this position starts filling. '0%' in range. */
  fillsLabel?: string;
  /** The POOL's liquidity at the current price, in base units. Read on-chain. */
  poolDepth?: string;
}): string {
  // Match the V3 card's layout (msgPositionCard): one fact per line, status on its
  // own line, with a strategy and an explanation of the money.
  const base = esc(p.baseSymbol ?? 'ETH');
  const sym = esc(p.tokenSymbol ?? p.pair.split('/').map((s) => s.trim()).find((s) => s !== p.baseSymbol) ?? 'token');
  const isLadderLeg = !!p.ladder && p.ladder.legCount > 1;
  // A ladder leg being absorbed is NOT a failure — it is the job. A red "OUT OF
  // RANGE" on one rung reads as though the whole position is in trouble when the
  // ladder is working fine. A filled leg gets its own wording and colour.
  const statusEmoji =
    p.inRange === null ? '🔷' : p.inRange ? '🟢' : p.converted && isLadderLeg ? '🟡' : '🔴';
  const status =
    p.inRange === null
      ? bold('UNKNOWN')
      : p.inRange
        ? bold('IN RANGE')
        : p.converted
          ? isLadderLeg
            ? `${bold('LEG FILLED')} — bought, ladder still running`
            : `${bold('OUT OF RANGE')} — fully converted`
          : `${bold('OUT OF RANGE')} — waiting`;
  const explain =
    p.inRange === null
      ? `Range status could not be read: the value above may be stale.`
      : p.inRange
        ? `Your liquidity is ${bold('active')} and earning fees. Fees keep accruing as long as ${sym} stays inside this range.`
        : p.converted
          ? p.ladder && p.ladder.legCount > 1
            // A fully absorbed ladder leg is NORMAL, not a sign the ladder failed —
            // the rungs fill one at a time from the top. Name its share of the
            // capital so "OUT OF RANGE" on ONE leg's card does not read as though
            // the entire ladder has turned into tokens.
            ? `This rung bought its ${bold(`${p.ladder.sharePct !== undefined ? `${p.ladder.sharePct.toFixed(1)}%` : 'share'}`)} of the ladder. The rungs below still hold ${base}, waiting lower.`
            : `Fully converted to ${bold(`100% ${sym}`)} — the buy-dip target is done. Hold for a bounce, or close.`
          : `Your liquidity is not active yet. It converts to ${sym} and starts earning fees once the price ${bold('drops')} into your range (${esc(p.rangeLabel)}).`;

  const isLeg = p.ladder && p.ladder.legCount > 1;
  // One tree block: the pool's own numbers first, then this position's, then the range
  // read as market cap. Status is carried by the header's emoji, so it is not repeated
  // as a line of its own.
  const fields: string[] = [
    `Fee: ${esc(p.feeLabel)}`,
    // The pool figures are absent, not zero, when the index has not picked this pool up.
    // Printing "$0" would describe a dead pool, which is a different thing entirely.
    `TVL: ${p.pool ? esc(p.pool.tvl) : '—'}`,
    // What the pool PAYS, next to what it holds. '?' means the volume behind it could not
    // be read, and 'hook fee' that the pool's own fee is not what the LP earns -- neither
    // is a zero, and printing one as a number would be the card inventing a yield.
    `APR: ${p.pool ? esc(p.pool.apr) : '—'}`,
    `Fills: ${esc(p.fillsLabel ?? '—')}`,
    // The window is named: an unlabelled "Volume" beside a TVL invites reading it as
    // all-time, which would make a young pool look far busier than it is. A pool the
    // index has not picked up reads '—', never '$0' -- unknown is not the same as idle.
    // '$0' is a claim that nothing traded. An unread volume is not that, and the fallback
    // source leaves it empty whenever it has no figure -- so an unknown reads '—', the same
    // as a pool the index has never seen.
    `Volume: ${esc(p.pool?.vol ?? '—')} (24h)`,
    // The POOL's liquidity at the price, not this position's capital: that is what
    // decides whether a trade through it moves the price, and it is readable on-chain
    // even when the index has no TVL for the pool yet.
    `Liquidity: ${esc(p.poolDepth ?? '—')}`,
  ];
  // The range is carried by the LIST card now (one row per position, pinned to the entry
  // values), so repeating it here only gave the two cards a way to disagree.
  void p.mcRange;
  const lines = [
    // Same header the list card uses, so the card you land on is recognisably the row
    // you tapped: state emoji, pair, id, protocol.
    `${statusEmoji} ${bold(`$${posPair(p.pair, p.baseSymbol)}`)} | #${esc(p.tokenId)} (V4)`,
    ...fields.map((f, i) => `${i === fields.length - 1 ? '└' : '├'} ${f}`),
    ...(isLeg
      ? [
          '',
          bold(`LADDER, ${p.ladder!.legCount} legs`),
          ...(p.ladder!.groupDeposit ? [`Deposit: ${esc(p.ladder!.groupDeposit)} ${base}`] : []),
          ...(p.ladder!.valueLabel ? [`Value now: ${esc(p.ladder!.valueLabel)}`] : []),
          ...(p.ladder!.pnlText ? [`Ladder PnL: ${esc(p.ladder!.pnlText)}`] : []),
          ...(p.ladder!.filled !== undefined
            ? [`Rungs: ${p.ladder!.filled} filled, ${p.ladder!.active} active, ${p.ladder!.waiting} waiting`]
            : []),
          note(`leg ${p.ladder!.legIndex + 1} of ${p.ladder!.legCount}${p.ladder!.sharePct !== undefined ? `, ${p.ladder!.sharePct.toFixed(1)}% of ladder capital` : ''}`),
        ]
      : []),
  ];
  void status;
  void explain;
  if (p.priceWarn) lines.push('', `⚠️ ${bold('Thin pool')} — ${esc(p.priceWarn)}`);
  // The explanatory sentence closes the card's content, leaving the timestamp as the
  // last trace. The "Uniswap v4 · managed by the bot" line was dropped: the protocol
  // is already implied by the card's contents, and the line only added length without
  // supporting a decision.
  lines.push('', note(nowWib()));
  if (!p.tracked) lines.push(note('read-only: opened outside the bot'));
  return lines.join('\n');
}

/** The result of closing a v4 position (or a dry-run simulation). */
export function msgV4Closed(o: {
  tokenId: string;
  base: 'ETH' | 'USDG' | null;
  cashedOut?: string;
  leftover?: boolean;
  txHash?: string;
  pnlText?: string;
  dryRun: boolean;
}): string {
  if (o.dryRun) {
    return card(`⚪ ${title('CLOSE v4 (DRY)', `#${o.tokenId}`)}`, [
      note(`simulation valid: when live, funds return${o.base ? ` and are cashed out to ${o.base}` : ''}.`),
    ]);
  }
  const body: string[] = [];
  if (o.cashedOut) body.push(`💰 ${bold(`all converted to ${o.base}`)}`);
  else if (o.leftover) body.push(`⚠️ ${bold('dust token has no swap route')} — it stays in your wallet (sell it later via /sell).`);
  else body.push(`💰 ${bold('funds returned to your wallet')}`);
  if (o.pnlText) body.push('', bold(`PnL  ${o.pnlText}`));
  if (o.txHash) body.push('', ...hrows([['tx', shortAddr(o.txHash)]]));
  return card(`✅ ${title('CLOSED v4', `#${o.tokenId}`)}`, body, nowWib());
}

/** The result of adding v4 liquidity (or a dry-run simulation). */
export function msgV4Added(o: {
  tokenId?: string;
  sizeEth: string;
  rangeLabel: string;
  txHash?: string;
  /** "$ARENA/USDG" — the same label the list and position cards use. */
  pair?: string;
  dryRun: boolean;
}): string {
  if (o.dryRun) {
    return card(`⚪ ${title('ADD v4 (DRY)')}`, [
      ...hrows([
        ['Deposit', o.sizeEth],
        ['Range', o.rangeLabel],
      ]),
      '',
      note('simulation valid: no transaction was sent.'),
    ]);
  }
  // Same card as the v3 path: one shape for "a position now exists", whichever protocol
  // minted it. The full hash, because a shortened one cannot be pasted into an explorer.
  return [
    `\u2705 ${bold('POSITION OPENED')}`,
    '',
    `${bold(o.pair ?? '')} | #${esc(o.tokenId ?? '?')} (V4)`,
    ...(o.txHash ? ['', `tx: ${code(o.txHash)}`] : []),
    '',
    note(nowWib()),
  ].join('\n');
}

/** Confirmation for closing a Uniswap v4 position. */
export function msgV4CloseConfirm(tokenId: string): string {
  return [
    `🔴 ${bold('Confirm Close (v4)')}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)} (Uniswap v4)`,
    '',
    '⚠️ The position is burned; ALL liquidity plus fees (both tokens) return to your wallet: with no auto-swap.',
    '',
    bold('Close this position?'),
  ].join('\n');
}

/** Monitor alert: a v4 position (bot-managed) entering or leaving range. */
export function msgV4Range(tokenId: string, inRange: boolean): string {
  return inRange
    ? [
        `🟢 ${bold('Alert: v4 Position In Range')}`,
        '',
        `Position ${bold(`#${tokenId}`)} (Uniswap v4) is back inside its price range: fees are flowing again.`,
        '',
        `⏱️ <i>Triggered at: ${nowWib()}</i>`,
      ].join('\n')
    : [
        `🔴 ${bold('Alert: v4 Position Out of Range')}`,
        '',
        `Position ${bold(`#${tokenId}`)} (Uniswap v4) has left its effective price range.`,
        'Fee income has stopped. Consider closing or repositioning it.',
        '',
        `⏱️ <i>Triggered at: ${nowWib()}</i>`,
      ].join('\n');
}


/**
 * Numbers arriving with nothing waiting for them. Almost always a reply to a prompt that
 * expired or was lost to a restart, and the owner needs the next step, not a shrug.
 */
export function msgNumbersNoPrompt(txt: string): string {
  return [
    `\u{1F7E1} ${bold('NOTHING IS WAITING FOR A NUMBER')}`,
    '',
    `You typed ${bold(txt)}, but no step is asking for it: the prompt expired, or the bot restarted since.`,
    '',
    note('to set percentages: /settings, then the button for that flow'),
    note('to open a position: paste the CA again'),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgUnknown(txt: string): string {
  const shown = (txt || '').trim().slice(0, 40) || '…';
  return card(
    title('UNKNOWN'),
    [
      fieldBlock([['input', shown]]),
      '',
      note('type /help for the command list · paste a CA for its audit card'),
    ],
  );
}

type Holding = { symbol: string; amount: number; usd: number | null };

export function msgStatus(opts: {
  dryRun: boolean;
  positions: number;
  /** Per chain: the native balance plus any stablecoin bases held there. */
  chains: Array<{
    label: string;
    amount: string;
    symbol: string;
    usd: number | null;
    stables?: Array<{ symbol: string; amount: string; usd: number | null }>;
    /** True where the chain's GAS token is the stablecoin itself (Arc pays gas in USDC). */
    stableNative?: boolean;
    /** Every other token held there, already valued. */
    tokens?: Holding[];
  }>;
  /** The Solana wallet, native first; null when none is connected or it could not be read. */
  sol?: Holding[] | null;
  totalUsd: number | null; // null means the native price could not be read; never 0
  lpUsd?: number | null; // the value of the active LP positions
  lpFailed?: number; // positions that failed to read, so the total is incomplete
}): string {
  // An unreadable USD figure becomes '—' (neutral). NEVER '$0.00', which reads as a fact.
  const usdCol = (u: number | null | undefined) => (u === null || u === undefined ? '—' : usdPlain(u));
  const equity = opts.totalUsd === null ? '—' : usdPlain(opts.totalUsd + (opts.lpUsd ?? 0));

  // Dust: anything under a dime is noise and is left off. An unpriced NATIVE balance is
  // kept (unknown is not worthless), but an unpriced token is not: on Solana those are
  // almost all airdropped spam, dozens of them.
  const DUST_USD = 0.1;
  const NAME: Record<string, string> = {
    Robinhood: 'Robinhood (RH)',
    BSC: 'Binance Smart Chain (BSC)',
    HyperEVM: 'HyperEVM (HYPE)',
    Base: 'Base (BASE)',
    Arc: 'Arc (ARC)',
    Ink: 'Ink (INK)',
    Solana: 'Solana (SOL)',
  };
  const amt = (n: number) =>
    n >= 1e6
      ? `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`
      : n >= 1e4
        ? `${(n / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`
        : n.toLocaleString('en-US', { maximumSignificantDigits: 4 });

  const groups: Array<{ name: string; rows: Holding[] }> = opts.chains.map((c) => ({
    name: NAME[c.label] ?? c.label,
    rows: [
      { symbol: c.symbol, amount: Number(c.amount) || 0, usd: c.usd, native: true },
      ...(c.stables ?? []).map((t) => ({ symbol: t.symbol, amount: Number(t.amount.replace(/\./g, '').replace(',', '.')), usd: t.usd })),
      ...(c.tokens ?? []),
    ] as Holding[],
  }));
  if (opts.sol?.length) groups.push({ name: NAME.Solana, rows: opts.sol.map((h, i) => ({ ...h, native: i === 0 }) as Holding) });

  const shown = groups
    .map((g) => {
      const rows = g.rows
        .filter((h: any) => (h.usd === null ? h.native && h.amount > 0 : h.usd >= DUST_USD))
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
      const unread = rows.some((h) => h.usd === null);
      return { name: g.name, rows, sum: unread ? null : rows.reduce((t, h) => t + (h.usd ?? 0), 0) };
    })
    .filter((g) => g.rows.length)
    .sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0));

  const tree = (rows: string[], indent = ''): string[] =>
    rows.map((r, i) => `${indent}${i === rows.length - 1 ? '└' : '├'}  ${r}`);

  const parts: string[] = [
    `\u{1F4B0} ${bold('PORTFOLIO')}`,
    '',
    bold('TOTAL EQUITY :'),
    ...tree([
      `Total: ${bold(equity)}`,
      ...(opts.lpUsd === undefined
        ? []
        : [`In LP/Staked : ${bold(usdCol(opts.lpUsd))} | ${opts.positions} position${opts.positions === 1 ? '' : 's'}`]),
      `Liquid/Free: ${bold(usdCol(opts.totalUsd))}`,
    ]),
  ];

  if (shown.length) {
    parts.push('', bold('BY CHAIN :'));
    for (const g of shown) {
      parts.push(`➤ ${bold(esc(g.name))} | ${usdCol(g.sum)}`);
      parts.push(...tree(g.rows.map((h) => `${esc(amt(h.amount))} ${esc(h.symbol)} / ${usdCol(h.usd)}`), '    '));
    }
  }

  if (opts.lpFailed) parts.push('', `⚠️ ${note(`${opts.lpFailed} position(s) failed to read — total is incomplete`)}`);
  parts.push('', opts.dryRun ? `⚪ ${bold('DRY RUN')} · ${note(nowWib())}` : note(nowWib()));
  return parts.join('\n');
}

/** A signed ETH amount: '+0.14811 ETH' / '-0.02 ETH'. */
function sgEth(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(5)} ETH`;
}

export function msgPnlPicker(chains: Array<{ label: string; trades: number; scored?: number }>): string {
  // The count shown is the SCORED one: break-even trades under ~$0.1 are left out, the
  // same rule the recap card applies. Showing the raw total here instead made those
  // trades look like they went missing between the two screens.
  const count = (c: { trades: number; scored?: number }) => c.scored ?? c.trades;
  // "All chains" is a total, not a chain -- it sits apart, after the per-chain list.
  const all = chains.find((c) => c.label === 'All chains');
  const per = chains.filter((c) => c !== all);
  const out = [`\u{1F9FE} ${bold('PnL RECAP')}`, ''];
  if (per.length) {
    out.push(
      'Pick a chain to recap its closed trades :',
      ...per.map((c, i) => `${i === per.length - 1 ? '└' : '├'} ${esc(c.label)}: ${bold(String(count(c)))} positions`),
    );
  } else {
    out.push('No closed trades yet.');
  }
  if (all) out.push('', `${bold('All chains')}: ${bold(String(count(all)))} positions`);
  out.push('', note(nowWib()));
  return out.join('\n');
}

/**
 * The PnL recap card for one period. ONE BOOK PER DENOMINATION: ETH, BNB, USDG and
 * USDT each get their own row. Adding them into a single "net ETH" figure is plainly
 * wrong — and the old version avoided that by DISCARDING the non-ETH books, so the
 * entire BSC history was never visible at all.
 */
export function msgPnl(opts: {
  dryRun: boolean;
  chainLabel: string;
  periodLabel: string;
  /** Scored positions -- a ladder counts once, break-even under ~$0.1 is left out. */
  trades: number;
  grossWin: number;
  grossLoss: number;
  winratePct: number;
  /** Set when the period holds no scored trade at all. */
  empty?: boolean;
}): string {
  // Everything on this card is already valued in dollars (statsFor converts each book
  // through its own chain's rate), so the unit belongs in the symbol, not trailing every
  // figure as "USD" -- which also invited reading the ETH book as if it were still ETH.
  const usd = (v: number) => `${v >= 0 ? '+' : '-'}${usdPlain(Math.abs(v))}`;
  const out = [bold(opts.chainLabel.toUpperCase()), ''];
  if (opts.empty || opts.trades === 0) {
    out.push(italic(`No closed trades with a measured result in ${opts.periodLabel.toLowerCase()}.`));
  } else {
    out.push(
      `${esc(opts.periodLabel)} ${bold('Statistics :')}`,
      `1. Trade: ${bold(String(opts.trades))} Positions`,
      `2. Profit: ${bold(usd(opts.grossWin))}`,
      `3. Loss: ${bold(usd(opts.grossLoss))}`,
      '',
      `${bold('Win Rate')}: ${bold(`${Math.round(opts.winratePct)}%`)}`,
    );
  }
  out.push('', note(opts.dryRun ? 'DRY RUN' : 'LIVE'));
  return out.join('\n');
}

/**
 * A fully converted position: the base side turned
 * into the token as price FALLS, the token side turns into base as price RISES — so
 * the recovery advice is inverted too.
 */
export function msgConverted(tokenId: string, baseSym: string, tokenSym: string): string {
  // One direction only: the base was deposited and price fell through the whole range, so
  // it is now the token.
  const from = baseSym;
  const into = tokenSym;
  return [
    `🔴 ${bold('Alert: Position Converted')} \u2B07\uFE0F`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSym)} / ${esc(tokenSym)}`,
    '',
    `⚠️ ${bold('RISK NOTICE:')} Your ${esc(from)} has been 100% converted to ${esc(into)}.`,
    `💡 ${bold('Suggestion:')} Your principal will only recover if the ${esc(tokenSym)} price rises again. Open the position to withdraw part of it, or /stop to close and cash out.`,
    '',
    `⏱️ <i>Triggered at: ${nowWib()}</i>`,
  ].join('\n');
}

export function msgIlAlert(tokenId: string, symbol: string, lossPct: number, limit: number): string {
  return [
    `⚠️ ${bold('Alert: Net Loss Threshold Crossed')}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)} · ${bold(symbol)}`,
    '',
    `📉 Position value plus fees is now ${bold(`${lossPct.toFixed(1)}% below your deposit`)} (your threshold: ${limit}%).`,
    '',
    note('this already accounts for the fees collected: it is not theoretical IL.'),
    '',
    `⏱️ <i>Triggered at: ${nowWib()}</i>`,
  ].join('\n');
}

export function msgPriceDrop(
  tokenId: string,
  symbol: string,
  dropPct: number,
  baseSymbol = 'WETH',
  tier?: number, // the rung just crossed, which marks this as a FOLLOW-UP alert
): string {
  // A second and subsequent alert has to read differently from the first; if they look
  // identical, a deepening drop is easily mistaken for an old notification repeating.
  const deep = tier !== undefined && tier >= 50;
  return [
    `${deep ? '🚨' : '🔴'} ${bold(`Alert: Price Drop${tier !== undefined ? ` · past −${tier}%` : ''}`)}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSymbol)} / ${esc(symbol)}`,
    '',
    `📉 ${bold(`${symbol} is down ${fmtPct(-dropPct)} from your entry price.`)}`,
    '',
    // The '⛔ Close Now' button ships with this message (monitor.ts), so the microcopy
    // points at that button rather than asking the user to type a command as price falls.
    note('close it now with the button below, or hold if you still believe in it.'),
  ].join('\n');
}

export function msgCloseAllPick(countV3: number, countV4 = 0): string {
  const total = countV3 + countV4;
  return [
    `\u26D4 ${bold('CLOSE A POSITION')}`,
    '',
    `${bold(`${total} active position${total === 1 ? '' : 's'}`)}${countV4 ? ` (${countV3} v3, ${countV4} v4)` : ''}`,
    'Pick one below, then close it from its card.',
    '',
    note('each close still goes through its own confirmation.'),
    note(nowWib()),
  ].join('\n');
}

// ─── /buy /sell token (base<->token, best route) ────────────────────────
export function msgBuyAskCA(
  dryRun: boolean,
  quick: Array<{ symbol: string; chain: string; ca: string }> = [],
): string {
  const out = [
    `📈 ${bold('Buy Token')}`,
    '',
    `💬 Paste the token ${bold('contract address (CA)')} (0x…).`,
  ];
  if (quick.length) {
    out.push('', `💵 ${bold('Stablecoins :')}`);
    for (const q of quick) out.push(`• ${bold(q.symbol)} · ${esc(q.chain)} — ${code(q.ca)}`);
    out.push('', note('tap a button below to buy one without pasting its address.'));
  }
  out.push('', note('the chain is detected automatically from the CA.'), note(`${dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
  return out.join('\n');
}

export function msgBuySafetyHint(sym: string): string {
  // note() -> italic() -> esc(): any HTML inside gets escaped too (the user sees a raw
  // '<b>PONS</b>'). Assemble it here rather than inventing a new primitive.
  return `${italic('Review the details and safety of ')}${bold(sym)}${italic(' above. Continue to pick the asset and amount.')}`;
}

export function msgSellList(n: number): string {
  return [
    `\u267B\uFE0F ${bold('SWAP TOKEN')}`,
    '',
    `You hold ${bold(String(n))} token${n === 1 ? '' : 's'}, pick one to swap :`,
  ].join('\n');
}

export function msgSellNoHoldings(): string {
  return [
    `📉 ${bold('Sell Token')}`,
    '',
    note('no tokens with a balance in your wallet (other than base assets).'),
  ].join('\n');
}

export function msgSellAmount(holdingLine: string): string {
  return [bold(holdingLine), '', 'How much do you want to swap?'].join('\n');
}

/** One flow's card in /settings: the value currently in use. */
export function msgPctPreset(
  label: string,
  values: number[],
  defaults: number[],
  o: { unit: string; min: number; max: number; noteLine?: string },
): string {
  const same = values.length === defaults.length && values.every((v, i) => v === defaults[i]);
  const u = o.unit === '%' ? '%' : ` ${o.unit}`;
  return [
    `⚙️ ${bold(`${label} · quick picks`)}`,
    '',
    `🎚 ${bold('Now:')} ${values.map((v) => code(`${v}${u}`)).join('  ')}`,
    `${note(`default: ${defaults.join(' / ')}${same ? ' (unchanged)' : ''}`)}`,
    '',
    o.unit === '%'
      ? `These are the buttons shown when you pick an amount in ${bold(label)}.`
      : 'These are the buttons shown when a bid-ask ladder asks how many legs to open.',
    ...(o.noteLine ? ['', note(o.noteLine)] : []),
  ].join('\n');
}

/** Prompt to type a list of values. */
/** The Buy preset prompt, opened straight from /settings. */
/** The Buy Token prompt: four amounts (native coin) and four percentages in one line. */
export function msgBuyPresetAsk(amounts: number[], pcts: number[], saved = false, title = '🛒 BUY TOKEN'): string {
  const [icon, ...words] = title.split(' ');
  return [
    `${icon} ${bold(words.join(' '))} | ${saved ? 'Preset Saved ✅' : 'Change Preset'}`,
    '',
    `For example: ${code('10 25 50 90 & 1% 2% 3% 4%')}`,
    '',
    `current: ${bold(`${amounts.join(' ')} & ${pcts.map((p) => `${p}%`).join(' ')}`)}`,
  ].join('\n');
}

/** A typing mistake, not a transaction: no "TRANSACTION ERROR", no service log. */
export function msgBuyPresetInvalid(): string {
  return [
    `⚠️ ${bold('Preset not saved')}`,
    '',
    'Exactly 4 amounts, then &, then exactly 4 percentages (0.01–100), no repeats.',
    `For example: ${code('0.001 2 3 4 & 0.01% 2% 3% 4%')}`,
  ].join('\n');
}

export function msgPctAsk(label: string, current: number[], o: { unit: string; min: number; max: number }): string {
  const example = o.unit === '%' ? '10 25 50 90' : '4 8 12 20';
  return [
    `✏️ ${bold(`Edit ${label}`)}`,
    '',
    `💬 Type up to 6 numbers, separated by spaces. For example ${code(example)}.`,
    '',
    `${note(`current: ${current.join(' / ')}`)}`,
    note(`each one ${o.min}–${o.max}, duplicates dropped, sorted automatically.`),
  ].join('\n');
}

export function msgPctInvalid(o: { unit: string; min: number; max: number }): string {
  const example = o.unit === '%' ? '10 25 50 90' : '4 8 12 20';
  return msgError(
    o.unit === '%' ? 'percentages' : 'leg counts',
    `Give 1 to 6 whole numbers between ${o.min} and ${o.max}. For example ${example}.`,
  );
}

export function msgSellTypeAmount(holdingLine: string, sym: string): string {
  return [
    ...(holdingLine ? [bold(holdingLine), ''] : []),
    `Type how much ${bold(sym)} to swap (or ${code('all')}).`,
  ].join('\n');
}

export function msgTSwapBase(chainLabel: string, buy: boolean): string {
  return [
    `${buy ? '📈' : '📉'} ${bold(buy ? 'Buy Token' : 'Sell Token')}`,
    '',
    `🔗 ${bold('Network:')} ${esc(chainLabel)}`,
    '',
    bold(buy ? 'Pick the asset you want to pay with :' : 'Pick the asset you want to receive :'),
  ].join('\n');
}

export function msgTSwapConfirm(o: {
  buy: boolean;
  chainLabel: string;
  tokenSym: string;
  amountInLabel: string;
  estOutLabel: string;
  route: string;
  dryRun: boolean;
  danger?: boolean; // a DANGER audit verdict, carried through to the card that sends the transaction
  screenFailed?: boolean;
  balanceLabel?: string;
  shortLabel?: string | null; // how much is missing; when something is missing, the Confirm button is not rendered
}): string {
  const body: string[] = [
    `${o.buy ? '📈' : '📉'} ${bold(o.buy ? 'Buy Order Preview' : 'Sell Order Preview')}`,
    '',
    `🔗 ${bold('Token:')} ${esc(o.tokenSym)} (${esc(o.chainLabel)})`,
    '',
    `📤 ${bold('You pay:')} ${bold(o.amountInLabel)}`,
    `📥 ${bold('You receive ≈')} ${bold(o.estOutLabel)}`,
    `🛣️ ${bold('Route:')} ${esc(o.route)}`,
    // The 1->3% ladder applies to router routes only; relay/LI.FI routes are protected
    // by the provider's own quoter.
    `🛡️ ${bold('Slippage:')} ${o.route.startsWith('uniswap') ? 'auto 1% → 3%' : `${esc(o.route)} (auto)`}`,
  ];
  if (o.balanceLabel) body.push(`💰 ${bold('Balance:')} ${esc(o.balanceLabel)}`);
  if (o.shortLabel) {
    body.push('', `🔴 ${bold(`Short by ${o.shortLabel}`)} — top up your wallet, then try again.`);
  }
  if (o.danger) {
    body.push('', `⚠️ ${bold('AUDIT: HIGH RISK')} — this token may not be sellable again. Cancel if unsure.`);
  } else if (o.screenFailed) {
    body.push('', `🟡 ${bold('AUDIT: FAILED')} — token could not be verified.`);
  } else {
    body.push('', note('estimate only; the exact amount is protected by the on-chain quoter at execution.'));
  }
  body.push(note(`${o.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
  return body.join('\n');
}

/** Router name as a reader knows it: "lifi" and "uniswap(slip 2%)" are internal labels. */
function routeLabel(route?: string): string {
  if (!route) return 'the best route';
  const r = route.toLowerCase();
  if (r.startsWith('lifi')) return 'Li.fi';
  if (r.startsWith('relay')) return 'Relay';
  if (r.startsWith('uniswap')) return 'Uniswap';
  return route;
}

export function msgTSwapDone(o: {
  buy: boolean;
  tokenSym: string;
  amountInLabel: string;
  outLabel: string;
  route?: string;
  /** Gas actually burned, in dollars. null when no receipt could be read. */
  feeUsd?: number | null;
  /** How far below the quote the fill landed. null when there was no quote to compare. */
  slipPct?: number | null;
  dryRun: boolean;
}): string {
  if (o.dryRun) {
    // Never the filled card in dry run: it would claim a trade that never happened.
    return [
      `\u26AA ${bold('DRY RUN')}`,
      '',
      `Would receive ${bold(`+${o.outLabel}`)}`,
      `Paying ${bold(o.amountInLabel)} using ${esc(routeLabel(o.route))}`,
      '',
      note(`DRY RUN \u00B7 ${nowWib()}`),
    ].join('\n');
  }
  // Each half is dropped on its own when unmeasurable: a missing receipt must not blank
  // out a slippage figure that was read correctly.
  return [
    `\u2705 ${bold('ORDER FILLED')}`,
    '',
    `» Received ${bold(`+${o.outLabel}`)}`,
    `» Paid ${bold(o.amountInLabel)} using ${esc(routeLabel(o.route))}`,
    ...(o.feeUsd === null || o.feeUsd === undefined ? [] : [`» Fee ${bold(`$${o.feeUsd < 0.01 ? o.feeUsd.toFixed(4) : o.feeUsd.toFixed(2)}`)}`]),
    ...(o.slipPct === null || o.slipPct === undefined ? [] : [`» Slippage ${bold(`${o.slipPct.toFixed(2)}%`)}`]),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgError(where: string, err: unknown): string {
  // `retryOnce` marks errors whose transaction ALREADY landed. Without the warning
  // line below, this card says "failed" for a mint that in fact succeeded — and the
  // owner opens a second position with the same capital.
  const landed = typeof err === 'object' && err !== null && (err as { landed?: boolean }).landed === true;
  // An ethers revert is a multi-line block (reason/code/transaction) that buries the
  // "do this" line. Take the first line only; the full detail stays in the service log.
  // Callers may pass a string OR an Error object (the latter is needed for `landed`).
  // `String(err)` on an Error yields "Error: message", so the prefix is stripped.
  const raw = err instanceof Error ? err.message : String(err);
  // A known custom error is explained instead of being shown as hex. ethers only decodes
  // reverts that are in the ABI it holds, so Permit2's own errors arrive as "unknown
  // custom error" with the answer sitting unread in the payload.
  const known = explainRevert(raw);
  const first = known?.text ?? (raw.split('\n')[0].trim().slice(0, 200) || 'unknown error');
  // The card promises "details are in the service log" — and that promise used to be
  // a LIE: 156 of 177 catch blocks wrote nothing, so the truncated part vanished
  // entirely and errors could not be audited afterwards. One line here covers all 42
  // callers.
  console.error(`[error:${where}] ${raw.replace(/\s+/g, ' ').slice(0, 500)}`);
  return [
    hdr('❌ TRANSACTION ERROR'),
    '',
    `${esc('Step')}   : ${bold(where)}`,
    `${esc('Reason')} : ${code(first)}`,
    '',
    landed
      ? note('the transaction DID land on-chain. Check /positions before retrying.')
      : note('try again. Full details are in the service log.'),
    note(nowWib()),
  ].join('\n');
}

export function msgProgress(text: string): string {
  return italic(`… ${text}`);
}

export function msgCancelled(): string {
  return card(title('CANCELLED'), [note('action cancelled.')]);
}

export function msgChainPick(): string {
  return card(
    title('CHAIN'),
    [note('token found on several chains. Pick one below.')],
  );
}

export function msgPositionCard(opts: {
  tokenId: string;
  symbol: string;
  fee: number;
  invest: string;
  pnlText: string;
  range: string;
  mcRange?: string; // the same range, read as market cap
  inRange: boolean;
  age: string;
  dryRun: boolean;
  chain?: string;
  baseSymbol?: string; // WETH (the default, and older positions) | USDG
  side?: 'base'; // kept so older records still read; the token side no longer exists
  converted?: boolean; // the price crossed the whole range, so the position is 100% the other asset
  feeIsTickSpacing?: boolean; // Velodrome Slipstream: `fee` is the tickSpacing, since its fee is dynamic
  /** The pool's own depth and activity. `onchain` marks a TVL measured from the pool
   *  contract itself rather than the index -- real, but with no volume or APR behind it. */
  pool?: { tvl: string; vol?: string; apr?: string; onchain?: boolean };
  /** How far price must still move before this position starts filling. '0%' in range. */
  fillsLabel?: string;
  /** The POOL's liquidity on the base side, read on-chain. */
  poolDepth?: string;
  ladder?: {
    legIndex: number; legCount: number; shape: string; groupInvest?: string;
    // A summary of the WHOLE ladder, which is the point of the bid-ask feature.
    // Without it a leg card shows a single rung when what the user deposited was a ladder.
    ladderValue?: string; ladderFees?: string; ladderMcRange?: string; ladderPnl?: string;
    sharePct?: number; legValue?: string; legFees?: string;
    filled?: number; active?: number; waiting?: number; unread?: number;
  }; // the legs of a ladder group
}): string {
  const base = esc(opts.baseSymbol ?? 'WETH');
  const sym = esc(opts.symbol);

  // The status appears ONLY on its own line, not in the title too: one fact in one
  // place, so there is no chance of the two disagreeing after a change.
  const status = opts.inRange
    ? bold('IN RANGE')
    : opts.converted
      ? `${bold('OUT OF RANGE')} — fully converted`
      : `${bold('OUT OF RANGE')} — waiting`;
  const strategy = `${base} Single Side (buy the dip)`;
  const investUnit = base;
  const range = esc(opts.range);

  // The closing sentence explains WHAT is happening to the money, and that differs by
  // status and by side — so do not collapse it into one generic sentence.
  const isLeg = opts.ladder && opts.ladder.legCount > 1;
  const explain = opts.converted && isLeg
    ? `This rung has done its job: leg ${opts.ladder!.legIndex + 1} of ${opts.ladder!.legCount} is now ${bold(`100% ${opts.symbol}`)}. The remaining rungs are still waiting further down.`
    : opts.inRange
    ? `Your liquidity is ${bold('active')} and earning fees. Fees keep accruing as long as ${sym} stays inside this range.`
    : opts.converted
      ? `Price moved through your entire range, so this position is now ${bold(`100% ${opts.symbol}`)} and no longer earning fees. Your target is done. Withdraw, or leave it and wait for price to come back into range.`
      : `Your liquidity is not active yet. It converts to ${sym} and starts earning fees once the price ${bold('drops')} into your range (${range}).`;

  // Same tree block as the v4 card: one protocol must not read differently from the
  // other for the same position shape.
  const fields: string[] = [
    `Fee: ${opts.feeIsTickSpacing ? `ts ${opts.fee}, dynamic` : feeLabel(opts.fee)}${opts.chain ? ` \u00B7 ${esc(opts.chain)}` : ''}`,
    // An on-chain TVL carries no volume behind it, so that column is left off rather than
    // filled with a question mark.
    `TVL: ${opts.pool ? `${esc(opts.pool.tvl)}${opts.pool.onchain ? ' (on-chain)' : ''}` : '—'}`,
    // What the pool PAYS, beside what it holds. An on-chain TVL has no volume behind it,
    // so there is nothing to annualise and the row reads '?' rather than a made-up yield.
    `APR: ${opts.pool && !opts.pool.onchain ? esc(opts.pool.apr ?? '?') : '—'}`,
    `Fills: ${esc(opts.fillsLabel ?? '—')}`,
    // Same rule as the v4 card: an unread volume is '—'. '$0' would claim nothing traded.
    `Volume: ${opts.pool && !opts.pool.onchain ? esc(opts.pool.vol ?? '—') : '—'} (24h)`,
    // The POOL's liquidity, not this position's capital -- the same meaning as on the v4
    // card. Read on-chain, so it survives a pool the index has not picked up yet.
    `Liquidity: ${esc(opts.poolDepth ?? '—')}`,
  ];
  // The range lives on the LIST card now, pinned to the entry values. Printing it here as
  // well gave the two cards a way to disagree about the same position.
  void opts.mcRange;
  return [
    // Same header the list card uses, so the card you land on is recognisably the row
    // you tapped: state emoji, pair, id, protocol.
    `${opts.inRange ? '🟢' : opts.converted ? '🟡' : '🔴'} ${bold(`$${posPair(`${base} / ${sym}`, base)}`)} | #${esc(opts.tokenId)} (V3)`,
    ...fields.map((f, i) => `${i === fields.length - 1 ? '└' : '├'} ${f}`),
    ...(isLeg
      ? [
          '',
          bold(`LADDER, ${opts.ladder!.legCount} legs`),
          ...(opts.ladder!.groupInvest ? [`Deposit: ${esc(opts.ladder!.groupInvest)} ${investUnit}`] : []),
          ...(opts.ladder!.ladderValue ? [`Value now: ${esc(opts.ladder!.ladderValue)}`] : []),
          ...(opts.ladder!.ladderPnl ? [`Ladder PnL: ${esc(opts.ladder!.ladderPnl)}`] : []),
          ...(opts.ladder!.filled !== undefined
            ? [`Rungs: ${opts.ladder!.filled} filled, ${opts.ladder!.active} active, ${opts.ladder!.waiting} waiting`]
            : []),
          note(
            `leg ${opts.ladder!.legIndex + 1} of ${opts.ladder!.legCount}` +
              (opts.ladder!.sharePct !== undefined ? `, ${opts.ladder!.sharePct.toFixed(1)}% of ladder capital` : ''),
          ),
        ]
      : []),
    '',
    note(nowWib()),
    ...(opts.dryRun ? [modeLabel(true)] : []),
  ].join('\n');
}

export function msgPositionGone(tokenId: string, symbol: string, baseSymbol = 'WETH'): string {
  return card(
    `✅ ${title('CLOSED', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      note('already closed on-chain: removed from the active list.'),
    ],
    nowWib(),
  );
}

export function msgPositionReadFail(tokenId: string, err: string): string {
  return card(
    title('READ FAIL', `#${tokenId}`),
    [esc(err)],
    nowWib(),
  );
}

export function msgPositionDetail(opts: {
  tokenId: string;
  symbol: string;
  fee: number;
  composition: string;
  value: string;
  fees: string;
  inRange: boolean;
  chain?: string;
  baseSymbol?: string;
}): string {
  const base = opts.baseSymbol ?? 'WETH';
  return [
    `\u{1F4C4} ${bold(`FULL DETAILS #${opts.tokenId}`)}`,
    '',
    `Pair: ${bold(`$${opts.symbol}`)} / ${esc(base)} (${feeLabel(opts.fee)} fee)`,
    `Protocol: Uniswap v3${opts.chain ? ` on ${esc(opts.chain)}` : ''}`,
    `Status: ${opts.inRange ? '🟢' : '🔴'} ${bold(opts.inRange ? 'IN RANGE' : 'OUT OF RANGE')}`,
    '',
    `Assets: ${esc(opts.composition)}`,
    `Value: ${bold(opts.value)}`,
    `Unclaimed fees: ${bold(opts.fees)}`,
    '',
    note(nowWib()),
  ].join('\n');
}

/** Consolidated position list: a summary plus a per-position tree, in one message. */
/**
 * "$JACOB/USDG": the token leads, the base follows.
 *
 * The stored pair is base-first and sometimes already carries both sides, so the base is
 * matched out rather than appended -- appending blindly produced "USDG / JACOB/USDG".
 * Exported because the list card and its buttons must show the SAME label.
 */
export function posPair(pair: string, baseSymbol?: string | null): string {
  const parts = pair.split('/').map((x) => x.trim()).filter(Boolean);
  if (!baseSymbol) return parts.join('/');
  const token = parts.find((x) => x.toLowerCase() !== baseSymbol.toLowerCase()) ?? parts[parts.length - 1];
  return `${token}/${baseSymbol}`;
}

export function msgPositionsList(opts: {
  dryRun: boolean;
  activeCount: number;
  totalInvestLabel: string | null; // null means the positions span several denominations
  totalPnlUsd: number | null;
  outOfRange: number;
  totalFeesLabel?: string | null;
  listDegraded?: boolean; // the indexer failed, so the list may be incomplete
  rows: Array<{
    id: string;
    pair: string;
    investLabel: string;
    age: string;
    pnlUsd: number | null;
    pnlPct: number | null;
    inRange: boolean;
    protocol?: string | null; // 'V3' | 'V4'
    chain?: string | null; // chain label — a list can span chains, and the card must say which
    rangeLabel?: string | null;
    mcRange?: string | null; // '$1.68M ⇄ $165.5K / now $1.70M'
    feesLabel?: string | null;
    feesUsdLabel?: string | null; // fees in USD, falling back to feesLabel when the price cannot be read
    legCount?: number | null; // a ladder's leg count, drawn as a badge beside the pair
    strategy?: string | null; // always the base side; kept for older callers
    baseSymbol?: string | null; // the asset DEPOSITED, used for the side label
    converted?: boolean; // the price has crossed the ENTIRE range, so the position is 100% the other asset
    convertedInto?: string | null; // the symbol of the asset it converted into
  }>;
}): string {
  const MAX_ROWS = 12;
  const shown = opts.rows.slice(0, MAX_ROWS);
  const blocks = shown.map((r) => {
    const base = r.baseSymbol ?? null;
    const pair = posPair(r.pair, base);
    // The side is written from the perspective of the asset DEPOSITED: "USDG Side" means
    // the base went in. Naming ETH on a USDG position would name an asset never deposited.
    const side = `${base ?? 'Base'} Single Side (buy the dip)`;
    // Three states, not two: not yet reached the range, inside it, and already through
    // the WHOLE range (capital fully converted, no longer earning). Without the third, a
    // position whose buy is FINISHED reads exactly like one that has not started.
    const status = r.inRange
      ? 'Active (in range)'
      : r.converted
        ? `Fully converted (out of range) → ${r.convertedInto ?? 'token'}`
        : 'Waiting (out of range)';
    // Percent alone hides the size: +2.8% on a 350 USDG leg and on a 3 ETH one read the
    // same. The dollar figure rides alongside, compact, and is dropped (not faked as $0)
    // when the price could not be read.
    const pnl =
      r.pnlPct === null
        ? `— ${italic('(entry unknown)')}`
        : fmtPct(r.pnlPct) + (r.pnlUsd === null ? '' : ` / ${usdCompact(r.pnlUsd)}`);
    const fields = [
      ...(r.chain ? [`Chain: ${esc(r.chain)}`] : []),
      `Strategy: ${esc(side)}`,
      `Invested: ${esc(r.investLabel)}`,
      `Total Fees: ${esc(r.feesUsdLabel ?? r.feesLabel ?? '—')}`,
      `PnL: ${pnl}`,
      // The range in MARKET CAP, the same reading the detail card gives, pinned to the
      // stored entry values -- a wobbling range is worse than no range.
      //
      // Falling back to the PRICE range matters for Solana: a DLMM position has no entry
      // market cap to pin anything to, so the market-cap line was simply never emitted and
      // those rows printed no range at all.
      ...(r.mcRange || r.rangeLabel ? [`Range: ${esc(r.mcRange || r.rangeLabel!)}`] : []),
      `Status: ${esc(status)}, ${esc(r.age)}`,
    ];
    return [
      // The badge sits AFTER the pair, outside the bold, and is never part of the name:
      // it describes the position, not the token.
      `${r.inRange ? '🟢' : '🔴'} ${bold(`$${pair}`)}${r.legCount && r.legCount > 1 ? ` ◣×${esc(r.legCount)}` : ''} | #${esc(r.id)}${r.protocol ? ` (${esc(r.protocol)})` : ''}`,
      ...fields.map((f, i) => `${i === fields.length - 1 ? '└' : '├'} ${f}`),
    ].join('\n');
  });

  const out = [`\u{1F4CA} ${bold('POSITIONS')}`, '', blocks.join('\n\n')];
  // The v4 list is the bot's records combined with the indexer's enumeration. If the
  // indexer fails, positions the bot did NOT record vanish without a trace -- this used
  // to be silent, server-log only.
  if (opts.listDegraded) {
    out.push('', note('the indexer is lagging, positions opened outside the bot may be missing from this list.'));
  }
  if (opts.rows.length > MAX_ROWS) out.push('', note(`+${opts.rows.length - MAX_ROWS} more positions, close some to see them`));
  // One sentence, chosen from what is ACTUALLY in the list. A fixed line would lie about
  // the very thing this card is read to decide: whether the money is earning right now.
  // "Converted" is kept apart from "waiting" -- a position that has been through its whole
  // range is finished buying and will not recover on its own, which is the opposite
  // situation from one that has not started.
  const inCount = shown.filter((r) => r.inRange).length;
  const convCount = shown.filter((r) => !r.inRange && r.converted).length;
  const waitCount = shown.length - inCount - convCount;
  const tail =
    inCount === shown.length
      ? 'Your liquidity is in range and earning fees.'
      : inCount > 0
        ? convCount > 0 && waitCount === 0
          ? 'Part of your liquidity is in range and earning fees, the rest has fully converted.'
          : 'Part of your liquidity is in range and earning fees, the rest is out of range.'
        : convCount === shown.length
          ? 'Your liquidity has fully converted and stopped earning fees.'
          : convCount > 0
            ? 'Part of your liquidity has fully converted, the rest is out of range and waiting.'
            : 'Your liquidity is out of range and not earning fees yet.';
  out.push('', tail, '', note(nowWib()));
  return out.join('\n');
}

export function msgNoPositions(): string {
  return [
    `\u{1F4CA} ${bold('POSITIONS')}`,
    '',
    // /add_lp is menu-hidden now; pasting the CA is the way in, so that is what this says.
    note('no LP positions recorded yet'),
    note('open one with paste your CA'),
    '',
    note(nowWib()),
  ].join('\n');
}

/** Trade history — one aligned table; the count in the header is what is actually shown. */
export function msgJournal(
  items: Array<{
    tokenId: string;
    symbol: string;
    pnlPct: number;
    pnlEth: number;
    reason: 'cashed' | 'gone' | 'burned' | 'recovery';
    ca?: string;
    chain?: string;
    baseKind?: BaseKind;
    closedAt?: number;
  }>,
  totalInJournal?: number,
): string {
  if (items.length === 0) {
    return [`🧾 ${bold('Trade History')}`, '', note('no closed trades yet.')].join('\n');
  }
  const reasonId: Record<string, string> = {
    cashed: 'cashed',
    gone: 'gone',
    burned: 'closed outside',
    recovery: 'swept',
  };
  const header = ['id', 'token', 'pnl eth', 'pnl %', 'age'];
  const rows = items.map((r) => [
    r.tokenId,
    r.symbol.length > 10 ? r.symbol.slice(0, 9) + '…' : r.symbol,
    r.reason === 'cashed' ? (r.pnlEth >= 0 ? '+' : '') + r.pnlEth.toFixed(5) : reasonId[r.reason] ?? r.reason,
    r.reason === 'cashed' ? fmtPct(r.pnlPct) : '—',
    r.closedAt ? fmtAge(Date.now() - r.closedAt) : '—',
  ]);
  // pnlEth on a USDG/USDT entry is DOLLARS, and on a BSC entry it is BNB — summing
  // them all and labelling it "ETH" produces a number wrong by 3-4 orders of
  // magnitude. Only base-native entries are summed; the rest are counted, not mixed in.
  const cashed = items.filter((r) => r.reason === 'cashed');
  const sameBase = cashed.filter((r) => (r.baseKind ?? 'weth') === 'weth' && (r.chain ?? 'robinhood') === 'robinhood');
  const net = sameBase.reduce((a, r) => a + r.pnlEth, 0);
  const otherCount = cashed.length - sameBase.length;
  // The table stays monospace (number columns have to line up); status uses a dynamic
  // emoji on the summary line rather than inside the table, where emoji break column width.
  const out = [
    `🧾 ${bold('Trade History')}`,
    '',
    pre(alignTable(header, rows, [false, false, true, true, true])),
    '',
    `💰 ${bold('Net')} of the ${sameBase.length} ETH trades shown : ${dot(net)} ${bold(`${net >= 0 ? '+' : ''}${net.toFixed(5)} ETH`)}`,
  ];
  if (otherCount > 0) {
    out.push(note(`${otherCount} more closed trade${otherCount > 1 ? 's' : ''} in other denominations (stablecoin / other chain), not summed above.`));
  }
  if (totalInJournal && totalInJournal > items.length) {
    out.push(`📜 ${bold('Journal total')} : ${totalInJournal} trades stored: full recap in /pnl`);
  }
  out.push('', note(nowWib()));
  return out.join('\n');
}

// ─── wizard steps ──────────────────────────────────────────────────

export function msgPoolStep(
  tokenLabel?: string,
  pools?: Array<{ pair: string; ver: string; feeLabel: string; tvl: string; vol?: string; apr: string; tight: string }>,
): string {
  const out = [bold('OPEN LP | Choose Pool'), ''];
  if (pools?.length) {
    out.push(bold('AVAILABLE POOLS :'));
    pools.forEach((p, i) => {
      // The pair is deliberately NOT repeated here: its button sits right below carrying
      // `TOKEN / BASE (fee)`, so the line would duplicate that text while pushing the
      // numbers -- the thing that actually separates one pool from another -- down a
      // line. Row order matches button order, which is what the number refers to.
      out.push(`${i + 1}. ${italic(`(${p.ver}, ${p.feeLabel} Fee)`)}`);
      // 'fills<=' lives here rather than on the button: it is the price distance before
      // a single-sided position STARTS filling -- the number that decides which pool
      // really works -- and a Telegram button is too narrow to hold it.
      out.push(`  TVL: ${esc(p.tvl)} / Vol 24h: ${esc(p.vol ?? '?')} / APR: ${esc(p.apr)} / fills≤${esc(p.tight)}`);
    });
    // What the two numbers on the right actually mean for the money, said once. The
    // trade-off is stated with it: a lower fee tier fills sooner BECAUSE its ticks are
    // finer, but every trade through it pays you less -- leaving that out would sell the
    // cheapest pool as strictly better, which it is not.
    out.push(
      '',
      note('a smaller fee and a smaller fills≤ mean your liquidity starts filling sooner, so it begins earning earlier.'),
      note('the trade-off: a lower fee tier pays less per trade, so it needs more volume to earn the same.'),
    );
  } else {
    out.push(bold('Pick the deepest pool (v3 & v4):'));
  }
  void tokenLabel; // the token is named on every button below; a header line repeats it
  return out.join('\n');
}

/**
 * The Solana token card: market data and the DLMM pools we could actually use.
 *
 * Every figure arrives pre-formatted, exactly as the v3/v4 pool card above takes its
 * strings. That is not laziness, it is what keeps aprLabel's cap in ONE place: the caller
 * already owns that formatting, and a second copy here is how "~373,403,973%" reached a
 * card in the first place.
 *
 * The three counts at the bottom carry the whole point of the card. Filtering to DLMM
 * discards live pools, so a token with none of ours is a token we cannot serve YET, not a
 * token that does not exist. Saying "not found" there would be a lie the owner would act
 * on.
 */
export function msgSolToken(opts: {
  symbol: string;
  name: string;
  ca: string;
  /** Pre-formatted, in display order. The caller owns the formatting so the shared usd
   *  helpers stay in one place. */
  rows: Array<[string, string]>;
  pools: Array<{ pair: string; binStep: string; fee: string; tvl: string; vol: string; feeTvl: string; bin?: string }>;
  otherVenueCount: number;
  offBaseCount: number;
  chainReadSkipped: boolean;
  /** DLMM pools found beyond the ones listed, so the list can say it was trimmed. */
  morePools?: number;
  /** Shared by every chain's CA card: defaults are Solana's. */
  chainLabel?: string;
  poolTitle?: string;
  poolDetail?: (p: { binStep: string; fee: string }) => string;
  /** Label of the last pool figure: Solana shows 24h Fee/TVL, EVM an annual APR. */
  feeLabel?: string;
  /** Replaces the default second line of each pool (the EVM card's own layout). */
  poolLine?: (p: { tvl: string; vol: string; feeTvl: string; bin?: string }) => string;
}): string {
  const out: string[] = [];
  // bold() and italic() escape their own argument. Wrapping esc() around them turns
  // AT&T into "AT&amp;amp;T", which is the exact bug that guard smoke-doubleescape exists
  // for, so the raw value goes in here.
  const sym = opts.symbol.replace(/^\$+/, '');
  out.push(`\u{1F4CA} ${bold('TOKEN STATISTICS')}`);
  out.push(`${bold(`$${sym}`)} | ${esc(opts.name)} ${italic(`(${opts.chainLabel ?? 'Solana'})`)}`);
  // A tree, not a <pre> block: these are five labelled facts, not a column of numbers to
  // compare down the page, and the glyphs line them up without a monospace font.
  opts.rows.forEach(([k, v], i) => {
    out.push(`${i === opts.rows.length - 1 ? '\u2514' : '\u251C'} ${esc(k)}: ${esc(v)}`);
  });
  out.push('');

  if (opts.pools.length > 0) {
    out.push(opts.poolTitle ? opts.poolTitle : `${bold('DLMM Pools')} :`);
    opts.pools.forEach((p, i) => {
      out.push(`${i + 1}. ${esc(p.pair)} ${italic(opts.poolDetail ? opts.poolDetail(p) : `(bin ${p.binStep}, fee ${p.fee})`)}`);
      // Fee over TVL for the last 24 hours, NOT an annualised APR. The two differ by 365x
      // and a card that showed one under the other's name would be off by that much.
      out.push(`   \u2514 ${opts.poolLine ? esc(opts.poolLine(p)) : `TVL: ${esc(p.tvl)} | Vol: ${esc(p.vol)} | ${esc(opts.feeLabel ?? '24h Fee/TVL')}: ${esc(p.feeTvl)}`}`);
    });
    // No "N deeper pools not shown" note, on any chain (the owner's call, 24 Sep 2026): the
    // card lists the top pools by TVL and says nothing about the rest.
    void opts.morePools;
  } else {
    // The distinction the owner has to be able to act on.
    out.push(bold(opts.otherVenueCount > 0 ? 'NO DLMM POOL' : 'NO POOL'));
    out.push(
      opts.otherVenueCount > 0
        ? note(
            `this token trades on ${opts.otherVenueCount} other pool${opts.otherVenueCount === 1 ? '' : 's'} (DAMM v2, Raydium, pumpswap), none of which PHILIPS uses. The token is real; the venue is not one we LP in.`,
          )
        : note('DexScreener lists no Solana pool for this address at all.'),
    );
  }

  if (opts.offBaseCount > 0) {
    out.push(
      '',
      note(
        `${opts.offBaseCount} DLMM pool${opts.offBaseCount === 1 ? ' is' : 's are'} quoted in something other than SOL or USDC, so ${opts.offBaseCount === 1 ? 'it is' : 'they are'} not offered.`,
      ),
    );
  }
  if (opts.chainReadSkipped && opts.pools.length > 0) {
    // Not '?': a question mark reads as "the data is unavailable" when the real cause is
    // "you have not configured this", and the two need different actions.
    out.push('', note('bin step and fee need SOLANA_RPC_URL; set it in .env to see them.'));
  }
  out.push('', `${bold('CA')} : ${code(opts.ca)}`);
  return card(out.shift() as string, out, footerMode());
}

/** The amount step of a Solana buy: how much SOL to spend. */
/** Step 1 of every buy: the NET balance ready to spend (fees and reserves already taken off). */
export function msgBuyStart(o: { symbol: string; chainLabel: string; amount: number; unit: string; usd: number | null }): string {
  const sym = o.symbol.replace(/^\$+/, '');
  const amt = o.amount.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const usd = o.usd === null ? '—' : usdPlain(o.usd);
  return [
    `🛒 ${bold(`BUY $${esc(sym)}`)} (${esc(o.chainLabel)})`,
    '',
    `» Balance: ${bold(`${esc(amt)} ${esc(o.unit)}`)} / ${bold(usd)}`,
    '',
    note(nowWib()),
  ].join('\n');
}

/** The confirm step: the numbers being risked, before anything is signed. */
export function msgSolBuyConfirm(o: {
  symbol: string;
  spendSol: string;
  receive: string;
  worstCase: string;
  priceImpact: string;
  slippage: string;
  route: string;
  dryRun: boolean;
}): string {
  const sym = o.symbol.replace(/^\$+/, '');
  return card(
    `\u{1F6D2} ${bold('CONFIRM BUY')} $${esc(sym)}`,
    [
      `\u251C Spend: ${esc(o.spendSol)} SOL`,
      `\u251C Receive: \u2248 ${esc(o.receive)} $${esc(sym)}`,
      `\u251C Worst case: ${esc(o.worstCase)} $${esc(sym)}`,
      `\u251C Impact: ${esc(o.priceImpact)}`,
      `\u251C Slippage: ${esc(o.slippage)}`,
      `\u2514 Route: ${esc(o.route)}`,
      '',
      // The one number that is actually at stake, named rather than left to "are you sure?".
      `\u{1F4B0} ${bold(`Spending ${o.spendSol} SOL`)}`,
      '',
      quoteHtml(
        esc(
          'a quote is a moment in time. If the price moves past the slippage before the swap lands, the transaction fails and the SOL stays in your wallet.',
        ),
      ),
    ],
    footerMode(o.dryRun),
  );
}

/** The result of a Solana buy that landed. */
export function msgSolBuyDone(o: { symbol: string; spendSol: string; received: string; sig: string; gas?: string | null }): string {
  const sym = o.symbol.replace(/^\$+/, '');
  // The same card as an EVM fill. Fee and slippage are not measured on this path yet, so
  // those lines are left out rather than printed as guesses.
  return [
    `\u2705 ${bold('ORDER FILLED')}`,
    '',
    `» Received ${bold(`+${o.received} ${sym}`)}`,
    `» Paid ${bold(`${o.spendSol} SOL`)} using Jupiter`,
    ...(o.gas ? [`» Fee ${bold(esc(o.gas))}`] : []),
    '',
    `${bold('Tx')} : ${code(o.sig)}`,
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgSolSellDone(o: { symbol: string; sold: string; received: string; sig: string; gas?: string | null }): string {
  const sym = o.symbol.replace(/^\$+/, '');
  return card(
    `\u2705 ${bold('SWAP FILLED')}`,
    [
      `${bold(`${esc(o.sold)} $${esc(sym)}`)} \u2192 ${bold(esc(o.received))}`,
      ...(o.gas ? [`Gas fee: ${bold(esc(o.gas))}`] : []),
      '',
      `${bold('Tx')} : ${code(o.sig)}`,
    ],
    footerMode(),
  );
}

/** Refused before sending: opening would leave rent behind that never comes back. */
export function msgSolLpNonRefund(o: { pair: string; cost: { refundable: number; nonRefundable: number; total: number } | null }): string {
  const sol = (n: number) => `${n.toFixed(5)} SOL`;
  if (!o.cost)
    return [
      `⛔ ${bold('LP REFUSED')} | ${esc(o.pair)}`,
      '',
      'The position cost could not be read, so a non-refundable fee cannot be ruled out.',
      '',
      note('nothing was sent · try again in a minute'),
    ].join('\n');
  return [
    `⛔ ${bold('LP REFUSED')} | ${esc(o.pair)}`,
    '',
    `<pre>cost to open  : ${sol(o.cost.total)}\nrefunded      : ${sol(o.cost.refundable)}\nnon-refundable: ${sol(o.cost.nonRefundable)}</pre>`,
    '',
    `🔴 ${bold(`only ${((o.cost.refundable / o.cost.total) * 100).toFixed(1)}% comes back, 90% is the minimum`)}`,
    '',
    '<blockquote>This range is the first to use part of the pool, so Meteora charges rent to create it. Nothing was sent. Try a narrower range, or a pool with more activity.</blockquote>',
    '',
    note(nowWib()),
  ].join('\n');
}

/** Step 1 of a Solana LP: how wide. */
export function msgSolLpRange(o: { pair: string }): string {
  return card(`${bold('OPEN LP')} | ${esc(o.pair)}`, ['How wide should the range be?'], footerMode());
}

/** Step 2: how much. */
export function msgSolLpAmount(o: { pair: string; rangePct: string; bins: string; balanceSol: string }): string {
  return card(
    `${bold('OPEN LP')} | ${esc(o.pair)}`,
    [
      // The bins are what the range BECAME, so the two are read together on one line.
      `${bold('Range')}: ${esc(o.rangePct)} (${esc(o.bins)} bins)`,
      `${bold('Balance')}: ${esc(o.balanceSol)} SOL`,
      '',
      'Pick an amount in SOL, a share of the balance, or type an amount.',
    ],
    footerMode(),
  );
}

/** The result of an LP that opened. */
export function msgSolLpOpened(o: {
  pair: string;
  amountSol: string;
  /** The range as the owner set it, e.g. '-5%'. Signed, because the direction IS the trade. */
  rangeLabel: string;
  baseSymbol: string;
  sig: string;
}): string {
  return card(
    `\u2705 ${bold('POSITION OPENED')}`,
    [
      // One line, one position: what went in, which pool, and which way it is pointing.
      `${bold(`${o.amountSol} SOL`)} \u2192 ${bold(o.pair)} ${italic(`(${o.rangeLabel} $${o.baseSymbol} Single Side)`)}`,
      '',
      `${bold('Tx')} : ${code(o.sig)}`,
    ],
    footerMode(),
  );
}

export function msgRangeStep(tokenSide = false): string {
  return [
    bold('OPEN LP | Set Price Range'),
    '',
    // The range's direction defines what this whole step means: the base side waits for
    // price to FALL into the token, the token side waits for it to RISE into base. One
    // sentence covering both is guaranteed to be wrong about one of them.
    italic(
      tokenSide
        ? 'a wider range means slower conversion back to the base asset, but a longer duration to earn trading fees.'
        : 'a wider range means slower conversion to the token, but a longer duration to earn trading fees.',
    ),
  ].join('\n');
}


export function msgLegStep(tokenSym: string, rangePct: number): string {
  return [
    bold('OPEN LP · Bid-Ask · How many legs?'),
    '',
    `More legs means a smoother ladder across the −${rangePct}% range, more ${esc(tokenSym)} bought as it dips.`,
    'All legs open in one batched transaction (auto-split if large).',
    '',
    `${bold('8–10 = sweet spot')} (free-tier RPC). ~95% of the Bid-Ask benefit, fast /positions.`,
    `${bold('69')} needs a ${bold('paid RPC')} — on free-tier it makes /positions & monitor slow.`,
    '',
    italic('Legs are auto-capped to what the pool tick-spacing allows.'),
  ].join('\n');
}

/** Every "position now exists" card, whichever protocol or shape minted it. */
export function msgPositionOpened(o: { pair: string; tokenId: string; protocol: 'V3' | 'V4' | 'DLMM'; size: string; gas: string | null; txHash: string | null; legs?: number }): string {
  return [
    `\u2705 ${bold('POSITION OPENED')}`,
    '',
    `» ${bold(o.pair)} | #${esc(o.tokenId)} (${o.protocol})${o.legs && o.legs > 1 ? ` · ${o.legs} legs` : ''}`,
    `» Size: ${bold(o.size)}`,
    `» Gas: ${bold(o.gas ?? '—')}`,
    // The FULL hash: a shortened one cannot be pasted into an explorer.
    ...(o.txHash ? ['', 'tx :', code(o.txHash)] : []),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgLadderOpened(opened: number, total: number, pair: string, deposit: string, txHash?: string | null): string {
  return [
    `\u2705 ${bold('POSITION OPENED')} \u00B7 ladder ${opened}/${total} legs`,
    '',
    `${bold(pair)}`,
    `Deposit: ${bold(deposit)}, split across ${opened} legs`,
    ...(txHash ? ['', `tx: ${code(txHash)}`] : []),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgAmountStep(
  symbol: string,
  maxLabel: string,
  balanceLabel?: string,
  example = '0.05',
): string {
  // The balance is shown here on purpose: picking blind and only being told
  // "INSUFFICIENT" on the plan card wastes a step and a round-trip.
  void maxLabel; // the per-tx limit lives in /settings; it never changed a choice here
  return [
    bold('OPEN LP | Deposit Amount'),
    '',
    `\u{1F4BC} ${bold('Balance')} = ${bold(balanceLabel ?? '?')}`,
    '',
    italic(`tap a percentage below, or type the exact amount of ${symbol} in the chat.`),
    '',
    italic(`Example: ${example}`),
  ].join('\n');
}

export function msgPlanStep(opts: {
  screenDanger: boolean;
  screenFailed?: boolean;
  baseSymbol: string;
  symbol: string;
  fee: number;
  depositAmount: string;
  depositUsd?: number; // the entry value in USD, an estimate of the capital going in
  pctHigh: number;
  pctLow: number;
  currentPrice: string;
  gasEth: string;
  needLabel: string;
  balanceLabel: string;
  shortLabel: string | null;
  costFailed?: boolean; // the cost estimate failed, so never claim the balance is sufficient
  priceLower?: string;
  priceUpper?: string;
  depositSymbol?: string;
  protocol?: string; // 'V3' | 'V4'
  dryRun: boolean;
}): string {
  const body: string[] = [bold('OPEN LP · Step [5/5] Review & Confirm'), ''];
  if (opts.screenDanger) body.push(`⚠️ ${bold('AUDIT: HIGH RISK')} — consider cancelling.`, '');
  else if (opts.screenFailed) body.push(`🟡 ${bold('AUDIT: FAILED')} — token could not be verified.`, '');
  // tickLower/Upper is TICK order; in PRICE terms it can be reversed depending on
  // which side the base sits on — sort ascending so "a - b" never displays backwards.
  let bounds: string | null = null;
  if (opts.priceLower && opts.priceUpper) {
    const [lo, hi] =
      Number(opts.priceLower) <= Number(opts.priceUpper)
        ? [opts.priceLower, opts.priceUpper]
        : [opts.priceUpper, opts.priceLower];
    bounds = `${lo} - ${hi} ${opts.baseSymbol} per ${opts.symbol}`;
  }
  body.push(
    `🔗 ${bold('Transaction Details :')}`,
    `• Pair: ${esc(opts.baseSymbol)} / ${esc(opts.symbol)} ${italic(`(${opts.protocol ?? 'V3'}, ${feeLabel(opts.fee)} Fee)`)}`,
    `• Strategy: ${esc(`${opts.baseSymbol} Single Side (Buy the dip)`)}`,
    `• Depositing: ${bold(`${opts.depositAmount} ${opts.depositSymbol ?? opts.baseSymbol}`)}${opts.depositUsd ? ` ${italic(`(≈ ${usdPlain(opts.depositUsd)})`)}` : ''}`,
    `• Target Range: ${fmtPct(opts.pctLow)} → ${fmtPct(opts.pctHigh)} from market price`,
    ...(bounds ? [`• Estimated Bounds: ${esc(bounds)}`] : []),
    `• Market Price: 1 ${esc(opts.symbol)} = ${esc(opts.currentPrice)} ${esc(opts.baseSymbol)}`,
    `• Status: ${italic('Out of Range (Will activate on price drop)')}`,
    // Gas and balance figures STAY on this card: it is the last one before money
    // moves, and "make sure you have enough ETH" without a number is not usable information.
    `• Est. Gas: ~${esc(opts.gasEth)} ETH`,
    `• Total Needed: ${esc(String(opts.needLabel))} ${italic(`(balance: ${String(opts.balanceLabel)})`)}`,
    '',
  );
  if (opts.costFailed) {
    body.push(`🟡 ${bold('Balance not verified')} — cost RPC failed. Check /portfolio first.`);
  } else if (opts.shortLabel) {
    body.push(`🔴 ${bold('Insufficient balance')} — short by ${bold(opts.shortLabel)}. Top up, then retry.`);
  }
  body.push(
    italic(
      opts.dryRun
        ? '*DRY RUN: no transaction will be sent.'
        : '*PHILIPS will auto-sign this transaction using your connected wallet. Ensure you have enough ETH balance for gas fees.',
    ),
  );
  return body.join('\n');
}

export function msgPlanStepV4(opts: {
  screenDanger: boolean;
  screenFailed?: boolean;
  baseSymbol: string;
  symbol: string;
  fee: number;
  tvlUsd: number;
  depositAmount: string;
  depositUsd?: number; // the entry value in USD, an estimate of the capital going in
  rangePctHigh: number;
  rangePctLow: number;
  dryRun: boolean;
}): string {
  const body: string[] = [bold('OPEN LP · Step [5/5] Review &amp; Confirm'), ''];
  if (opts.screenDanger) {
    body.push(`⚠️ ${bold('AUDIT: HIGH RISK')} — consider cancelling.`, '');
  } else if (opts.screenFailed) {
    body.push(`🟡 ${bold('AUDIT: FAILED')} — token could not be verified.`, '');
  }
  body.push(
    `🔗 ${bold('Transaction Details :')}`,
    `• Pair: ${esc(opts.baseSymbol)} / ${esc(opts.symbol)} ${italic(`(V4, ${feeLabel(opts.fee)} Fee)`)}`,
    `• Pool TVL: ${usdCompact(opts.tvlUsd)}`,
    `• Strategy: ${esc(opts.baseSymbol)} Side (Buy the dip)`,
    `• Depositing: ${bold(`${opts.depositAmount} ${opts.baseSymbol}`)}${opts.depositUsd != null ? ` ${italic(`(≈ $${opts.depositUsd.toFixed(2)})`)}` : ''}`,
    `• Target Range: ${fmtPct(opts.rangePctLow)} → ${fmtPct(opts.rangePctHigh)} from market price`,
    `• Status: ${italic('Out of Range (Will activate on price drop)')}`,
    // The dry-run staticCall already ran before this card was rendered, so report its
    // result — it is the only assurance the v4 mint will not revert.
    `• Simulation: ${italic('mint simulated successfully')}`,
    '',
    italic(
      opts.dryRun
        ? '*DRY RUN: no transaction will be sent.'
        : '*PHILIPS will auto-sign this transaction using your connected wallet. Ensure you have enough ETH balance for gas fees.',
    ),
  );
  return body.join('\n');
}

/** A v4 pool was picked but its base is not native ETH (not supported for opening yet). */
export function msgV4BaseUnsupported(): string {
  return card(`ℹ️ ${title('V4 POOL USES WRAPPED WETH')}`, [
    note('this v4 pool pairs wrapped WETH (not native ETH), not supported yet.'),
    note('pick a native-ETH / USDG v4 pool, or a v3 pool from the list.'),
  ]);
}

export function msgPairPicker(n: number): string {
  return [
    `💧 ${bold('Open Single-Side Liquidity')}`,
    '',
    'Provide liquidity with only one token. The position works like a passive limit order: you earn trading fees while waiting for the price to reach your target.',
    '',
    n ? bold('Pick the pair you want :') : italic('Top pools failed to load. Use "Search Your Own Pair".'),
  ].join('\n');
}

export function msgPairCustom(): string {
  return [
    `🔍 ${bold('Search Your Own Pair')}`,
    '',
    'Paste the contract address (CA) of the token you are targeting into this chat.',
    '',
    note('PHILIPS audits it first, then offers to open an LP.'),
  ].join('\n');
}

export function msgInvalidAddress(): string {
  return card(
    title('INVALID'),
    [
      note('invalid token address.'),
      note('use an EVM contract address (0x…), not a Solana mint.'),
    ],
  );
}

export function msgNoPools(baseLabel = 'WETH/USDG'): string {
  return card(
    `⚪ ${title('NO POOLS')}`,
    [note(`no liquid ${baseLabel} pool exists for this token on this chain.`)],
  );
}

export function msgScreeningFailed(): string {
  return card(
    title('SCREENING'),
    [note('could not reach the data sources: continuing without the audit.')],
  );
}

export function msgDryRunAddDone(): string {
  return card(
    title('DRY RUN DONE'),
    [
      note('no transaction was sent.'),
      note('set DRY_RUN=false in .env for real execution.'),
    ],
  );
}

export function msgOpeningLp(): string {
  return msgProgress('opening LP…');
}

/**
 * The OPENED POSITION card.
 *
 * `notes` arrive from executeAdd shaped like "Wrap 0.06 ETH (tx 0x...)". The hash is
 * split onto its own line inside <code> so it can be tap-copied on a phone — mid
 * sentence, a 66-character hash is impossible to select with a thumb.
 * Notes without a hash are shown as they are (a retry warning, say).
 */
export function msgLpOpened(
  tokenId: string,
  notes: string[],
  pair?: string,
  rangeLabel?: string | null,
  protocol: 'V3' | 'V4' = 'V3',
): string {
  void rangeLabel; // the range is on the position card, one tap away
  const out = [`\u2705 ${bold('POSITION OPENED')}`, '', `${bold(pair ?? '')} | #${esc(tokenId)} (${protocol})`];
  // The FULL hash, as <code>: a shortened one cannot be pasted into an explorer, and this
  // is the only place the opening transaction is ever shown.
  for (const n of notes) {
    const mt = n.match(/\(tx (0x[0-9a-fA-F]+)\)/);
    if (mt) out.push('', `tx: ${code(mt[1])}`);
  }
  out.push('', note(nowWib()));
  return out.join('\n');
}

// ─── wallet: /settings (connect and disconnect via buttons) ────────

export function msgAlerts(a: { rangeNotify: boolean; dropPct: number | null; ilPct: number | null }): string {
  const on = (v: boolean) => (v ? '✅' : '⬜️');
  return [
    `\u{1F514} ${bold('POSITION ALERTS')}`,
    '',
    'PHILIPS notifies you when :',
    // Range and "converted" share one switch, and the card has to say so: turning range
    // alerts off silently removes the converted warning too, which is the one alert that
    // reports capital no longer able to recover on its own.
    `${on(a.rangeNotify)} A position enters or leaves its range v3 and v4`,
    `${on(a.rangeNotify)} A position converts fully to the other token and stops earning`,
    // The thresholds live on the buttons, which is also where they are changed.
    `${on(a.dropPct !== null)} The token drops below your entry`,
    `${on(a.ilPct !== null)} Value plus fees falls below your deposit`,
    '',
    // Recoveries are not a preference: they report money that has already moved.
    `${bold('Always on :')} leftover tokens swept back to base, and stuck wrapped native unwrapped.`,
    '',
    note('the buttons cycle each value; OFF disables that notification.'),
    note('"net loss" already counts the fees collected, not theoretical IL that ignores them.'),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgNeedWallet(): string {
  return [
    `🔗 ${bold('Wallet Not Connected')}`,
    '',
    'This command moves funds, so PHILIPS needs a wallet first.',
    '',
    `Open ${code('/settings')} and tap ${bold('Connect Wallet')}.`,
  ].join('\n');
}

export function msgConnectPrompt(): string {
  return [
    bold('CONNECT WALLET'),
    '',
    `Paste your ${bold('private key')} (0x\u2026) or ${bold('12/24-word seed phrase')} in this chat.`,
    'PHILIPS signs your LP and swap transactions with it.',
    '',
    note(`LIVE \u00B7 ${nowWib()}`),
  ].join('\n');
}

export function msgConnectSolPrompt(): string {
  return [
    bold('CONNECT SOLANA WALLET'),
    '',
    `Paste the ${bold('private key')} of your Solana wallet in this chat, base58, the way Phantom exports it.`,
    'It is stored in its own encrypted keystore and never touches your EVM key.',
    '',
    note(`LIVE \u00B7 ${nowWib()}`),
  ].join('\n');
}

export function msgConnectImporting(): string {
  return [`⏳ ${bold('Importing wallet…')}`, '', 'Encrypting the key and checking network access.'].join('\n');
}

export function msgConnectFailed(reason: string): string {
  return [
    `❌ ${bold('Connection Failed')}`,
    '',
    esc(reason),
    '',
    note('try again from /settings → Connect Wallet, then paste a private key (0x + 64 chars) or a 12/24-word seed.'),
  ].join('\n');
}

export function msgConnected(_addr: string): string {
  // One line. The address, the chain and the mode all appear on the WELCOME card that
  // follows immediately, so repeating them here only pushes that card off the screen.
  // The pasted message is deleted by handleSecret before this is ever sent.
  return `\u2705 ${bold('Wallet Successfully Connected!')}`;
}

export function msgAlreadyConnected(addr: string): string {
  return [
    `🔗 ${bold('Wallet Already Connected')}`,
    '',
    `${bold('Address:')} ${code(shortAddr(addr))}`,
    '',
    `Want to switch? Disconnect first from ${code('/settings')}.`,
  ].join('\n');
}

/** The prompt that waits for a photo to use as the PnL card's backdrop. */
export function msgPnlBgPrompt(hasCustom: boolean): string {
  return [
    `\u{1F5BC}\uFE0F ${bold('PNL BACKGROUND')}`,
    '',
    'Send a photo now and it becomes the backdrop of every PnL card.',
    '',
    `Currently: ${bold(hasCustom ? 'your own image' : 'the default artwork')}`,
    note('landscape works best, around 1200x630; the card draws it from the right edge'),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgPnlBgSaved(): string {
  return [
    `\u2705 ${bold('BACKGROUND SAVED')}`,
    '',
    'Every PnL card from now on uses this image.',
    note('change it again, or restore the default, from /settings'),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgPnlBgReset(): string {
  return [
    `\u267B\uFE0F ${bold('DEFAULT RESTORED')}`,
    '',
    'The PnL card is back to the artwork it ships with.',
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgSettings(
  dryRun: boolean,
  maxPerTx: string,
  gasCeiling?: string | null, // the per-transaction gas cost ceiling; null means none
  /** Default deposit shape, chosen here instead of on every /add. Shared by both chains. */
  lpShape?: 'spot' | 'bidask',
  /** Ladder leg choices, e.g. "3/5/8". EVM only: Meteora shapes its own bid-ask. */
  legs?: string,
): string {
  // Wallet, chain and the quick-% list are deliberately NOT here: the first two already
  // head the WELCOME card, and each percentage is shown by the button that changes it.
  // Split by chain because the two paths share almost nothing: the tx limit and gas ceiling
  // are never checked on Solana, and its slippage is a different constant.
  const shape = lpShape ? bold(lpShape === 'bidask' ? 'BID-ASK' : 'SPOT') : null;
  const evm = [
    `Tx limit: ${esc(maxPerTx)}`,
    'Gas: high, from the official RPC',
    // These match what the code ACTUALLY does: a swap steps 1% -> 2% -> 3% and never
    // beyond, while an LP mint is a separate, far tighter figure.
    `Swap slippage: 1%, retried at 2% then ${TRADE_LIMIT_PCT}% max`,
    `Price impact: max ${TRADE_LIMIT_PCT}% to buy, ${SELL_IMPACT_PCT}% to sell`,
    'LP mint slippage: 0.5%',
    ...(shape ? [`LP shape: ${shape}${lpShape === 'bidask' && legs ? `, legs ${esc(legs)}` : ''}`] : []),
  ];
  const sol = [
    `Slippage: ${TRADE_LIMIT_PCT}%`,
    `Price impact: max ${TRADE_LIMIT_PCT}% to buy, ${SELL_IMPACT_PCT}% to sell`,
    'Priority fee: high, from the official RPC',
    ...(shape ? [`LP shape: ${shape}`] : []),
  ];
  const list = (xs: string[]) => xs.map((f, i) => `${i + 1}. ${f}`);
  return [
    `\u2699\uFE0F ${bold('SETTINGS')}`,
    '',
    `${bold('Mode')} : ${bold(dryRun ? 'DRY RUN' : 'LIVE')}  ${dryRun ? '\u26AA' : '\u{1F7E2}'}`,
    '',
    bold('EVM'),
    ...list(evm),
    '',
    bold('Solana'),
    ...list(sol),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgChainsToggle(): string {
  return [
    `🔌 ${bold('CHAINS')}`,
    '',
    'Tap a chain to switch it on or off.',
    'An off chain leaves portfolio, swap, buy, bridge and pool lists.',
    '',
    `⚠️ ${italic('open positions on an off chain are not monitored until it is back on')}`,
  ].join('\n');
}

export function msgSolDisconnectConfirm(addr: string, openLp: number | null): string {
  const out = [
    `🔴 ${bold('Disconnect SOL Wallet')}`,
    '',
    `Disconnect ${code(shortAddr(addr))} from PHILIPS?`,
    '',
    `⚠️ ${bold('Warning :')}`,
    '• Your encrypted Solana key will be permanently DELETED from this server.',
    '• Your funds are not lost, but you will have to manage your DLMM positions yourself on Meteora.',
    '• Your EVM wallet stays connected.',
  ];
  if (openLp) {
    out.push(`• ${bold(`You still have ${openLp} open DLMM position(s).`)} PHILIPS will stop tracking them.`);
  } else if (openLp === null) {
    out.push("• Open positions could not be checked right now. Look on Meteora before you continue.");
  }
  return out.join('\n');
}

export function msgDisconnectConfirm(addr: string, openLp: number): string {
  const out = [
    `🔴 ${bold('Disconnect Wallet')}`,
    '',
    `Disconnect ${code(shortAddr(addr))} from PHILIPS?`,
    '',
    `⚠️ ${bold('Warning :')}`,
    '• Your encrypted key will be permanently DELETED from this server.',
    '• Your funds are not lost, but you will have to manage your LP positions yourself in the Robinhood/Uniswap app.',
  ];
  if (openLp) {
    out.push(
      `• ${bold(`You still have ${openLp} open LP position(s).`)} PHILIPS will stop monitoring them, and unclaimed fees can no longer be harvested from here.`,
    );
  }
  return out.join('\n');
}

export function msgDisconnected(envKeyStillThere = false): string {
  return [
    `✅ ${bold('Wallet Disconnected')}`,
    '',
    'Your encrypted key has been deleted from this server.',
    // The .env copy is a SECOND copy of the same key, and deleting the keystore does
    // not touch it. Saying nothing here would let the owner believe the key is gone
    // from the machine when a plain-text copy is still sitting in a file.
    ...(envKeyStillThere
      ? [
          '',
          `⚠️ ${bold('A copy is still in your .env')}`,
          `PHILIPS will refuse to load it, but it remains on this server in plain text. Remove the ${code('PRIVATE_KEY')} line to delete it for good.`,
        ]
      : []),
    '',
    `Want to use PHILIPS again later? Open ${code('/settings')}. Stay safe!`,
  ].join('\n');
}

// ─── /claim_fees and partial withdrawals ───────────────────────────────

export function msgNoFees(): string {
  return [
    `💵 ${bold('Harvest Fees')}`,
    '',
    note('no harvestable fees on your active positions yet.'),
  ].join('\n');
}

export function msgClaimPick(rows: Array<{ symbol: string; id: string; label: string }>): string {
  const out = [`\u{1F4B5} ${bold('UNCLAIMED FEES')}`, '', 'Fees on your active positions :'];
  rows.forEach((r, i) => out.push(`${i + 1}. ${bold(`$${r.symbol}`)} / #${esc(r.id)}: ${bold(r.label)}`));
  out.push('', note('fees go straight to wallet and your LP position stays open.'));
  return out.join('\n');
}

export function msgClaimDone(id: string, label: string, txHash: string | null): string {
  return [
    `✅ ${bold('Fees Harvested!')}`,
    '',
    `Position ${bold(`#${id}`)} → ${bold(label)} is now in your wallet.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN: no transaction was sent.')]),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgRemovePct(id: string): string {
  return [
    // "Remove liquidity", not "withdraw": a withdrawal now means sending funds out to an
    // address. This pulls part of an LP back into the wallet, which is a different act.
    `\u2796 ${bold('REMOVE LIQUIDITY')} · #${esc(id)}`,
    '',
    'How much of this position do you want to pull out?',
    '',
    note('25/50/75% is partial, the position stays alive and keeps earning fees.'),
    note('100% closes it entirely: the NFT is burned and the proceeds are swapped back to base.'),
  ].join('\n');
}

export function msgRemoveConfirm(id: string, symbol: string, pct: number, est: string, dryRun: boolean): string {
  return [
    `\u2796 ${bold('REMOVE LIQUIDITY REVIEW')}`,
    '',
    `${bold(`${pct}%`)} of ${bold(`$${symbol}`)} / #${esc(id)}`,
    `Estimated out: ${bold(est)} plus any unclaimed fees`,
    `Left in the pool: ${bold(`${100 - pct}%`)}, still earning`,
    '',
    // The cost basis shrinks along with a partial removal -- without this note, the
    // smaller PnL afterwards reads like a sudden loss.
    note('your recorded cost basis is scaled down by the same share, so PnL stays comparable.'),
    note(dryRun ? 'DRY RUN, no transaction will be sent.' : `LIVE \u00B7 ${nowWib()}`),
  ].join('\n');
}

export function msgRemoveDone(id: string, pct: number, txHash: string | null): string {
  return [
    `\u2705 ${bold('LIQUIDITY REMOVED')}`,
    '',
    `${bold(`${pct}%`)} of #${esc(id)} is now in your wallet, along with any unclaimed fees.`,
    `The remaining ${bold(`${100 - pct}%`)} is still working in the pool.`,
    ...(txHash ? ['', bold('Tx Hash :'), code(txHash)] : ['', note('DRY RUN, no transaction was sent.')]),
    '',
    note(nowWib()),
  ].join('\n');
}

// ─── stop / close ──────────────────────────────────────────────────

export function msgStopConfirm(opts: {
  tokenId: string;
  symbol: string;
  fee: number;
  age: string;
  pnlText: string;
  feeText: string;
  baseAmt: string;
  baseSymbol: string;
  otherAmt: string;
}): string {
  return [
    `\u26D4 ${bold(`CLOSE POSITION #${opts.tokenId}`)}`,
    '',
    `Pair: ${bold(`$${opts.symbol}`)} / ${esc(opts.baseSymbol)} (${feeLabel(opts.fee)} fee)`,
    `Age: ${esc(opts.age)}`,
    `Fees: ${bold(opts.feeText)}`,
    `Out: ${bold(`${opts.baseAmt} ${opts.baseSymbol}`)} + ${esc(opts.otherAmt)} ${esc(opts.symbol)}`,
    `PnL: ${bold(opts.pnlText)}`,
    '',
    // This one keeps its confirm step: closing burns the position and cannot be undone.
    note(`closing removes the liquidity and swaps everything to ${esc(opts.baseSymbol)}. This cannot be undone.`),
    note(nowWib()),
  ].join('\n');
}

export function msgNoActiveToStop(): string {
  return card(
    title('STOP LP'),
    [note('no active positions.')],
  );
}

export function msgDryRunClose(tokenId: string): string {
  return card(
    title('DRY RUN'),
    [note(`position #${tokenId} was not closed (simulation).`)],
  );
}

export function msgClosing(baseSymbol = 'ETH'): string {
  return msgProgress(`closing position & cashing out to ${baseSymbol}…`);
}

export function msgAlreadyClosed(tokenId: string): string {
  return card(
    title('ALREADY CLOSED', `#${tokenId}`),
    [note('marked STOPPED and cleaned up.')],
    nowWib(),
  );
}

export function msgCashOut(opts: {
  tokenId: string;
  notes: string[];
  ethOut: string;
  txHashes: string[];
  legs?: number; // for a ladder, how many legs were closed together
  baseSymbol?: string; // the asset cashed out into, which decides the closing sentence
  native?: boolean; // the proceeds were unwrapped into the chain's native asset, not a stablecoin
  leftover?: boolean; // token dust is still left unswept
  pair?: string; // "$富贵/USDG": the same label the position card uses
  protocol?: 'V3' | 'V4' | 'DLMM';
}): string {
  const ladder = (opts.legs ?? 0) > 1;
  const out = [
    `\u2705 ${bold('POSITION CLOSED')}`,
    '',
    `${bold(opts.pair ?? '')} | #${esc(opts.tokenId)}${opts.protocol ? ` (${opts.protocol})` : ''}${ladder ? ` \u00B7 ladder, ${opts.legs} legs` : ''}`,
  ];

  // The steps that were ACTUALLY executed, straight from the executor, numbered. The tx
  // hash is stripped out of each line and collected below: mid-sentence, 66 characters
  // are impossible to select with a thumb.
  const steps = opts.notes.map((n) => n.replace(/\s*\(tx 0x[0-9a-fA-F]+\)/, '').trim()).filter(Boolean);
  steps.push(`Received ${opts.ethOut}`);
  out.push('', bold('Step by step :'), ...steps.map((t, i) => `${i + 1}. ${esc(t)}`));

  // Every hash the close produced, including any that never made it into a note.
  const inNotes = opts.notes.join(' ');
  const hashes = [
    ...(opts.notes.map((n) => n.match(/\(tx (0x[0-9a-fA-F]+)\)/)?.[1]).filter(Boolean) as string[]),
    ...opts.txHashes.filter((h) => !inNotes.includes(h)),
  ];
  if (hashes.length) {
    out.push('', bold('Tx Hash :'));
    for (const h of hashes) out.push(code(h));
  }

  // This sentence used to ALWAYS read "unwrapped back into native ETH" -- including on
  // closes that returned USDT or USDG, which are never unwrapped and are not ETH. It
  // follows the asset actually received.
  const sym = opts.baseSymbol ?? 'ETH';
  // A failed swap on Solana: the token is in the wallet and nothing retries it later, so
  // the card must not claim it was swapped.
  if (opts.leftover && opts.protocol === 'DLMM') {
    out.push('', 'The token swap failed, so it is still in your wallet. Sell it with /swap.', '', note(nowWib()));
    return out.join('\n');
  }
  out.push(
    '',
    opts.native
      ? `The paired token was swapped and unwrapped back into ${bold(`native ${sym}`)}, now in your wallet.`
      : `The paired token was swapped into ${bold(sym)} and is in your wallet.`,
  );
  if (opts.leftover) {
    out.push(note('some dust had no swap route and stays in your wallet, the monitor will retry, or swap it yourself.'));
  }
  out.push('', note(nowWib()));
  return out.join('\n');
}

// ─── monitor ───────────────────────────────────────────────────────

/** Entering range: fees start flowing. `tokenSide` flips the conversion's direction. */
export function msgRangeEnter(tokenId: string, symbol: string, baseSymbol = 'WETH'): string {
  const from = baseSymbol;
  const into = symbol;
  return [
    `🟢 ${bold('Alert: Position In Range')}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSymbol)} / ${esc(symbol)}`,
    '',
    `💧 ${bold('Fees are now flowing!')}`,
    `Your liquidity is active. Your ${esc(from)} is currently converting to ${esc(into)} as the price ${bold('drops')} through your target range.`,
    '',
    `⏱️ <i>Triggered at: ${nowWib()}</i>`,
  ].join('\n');
}

export function msgRangeExit(
  tokenId: string,
  symbol: string,
  side: 'above' | 'below',
  baseSymbol = 'WETH',
): string {
  const up = side === 'above';
  return [
    `${up ? '🟡' : '🔴'} ${bold('Alert: Position Out of Range')}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSymbol)} / ${esc(symbol)}`,
    '',
    up
      ? `📈 The price moved ${bold('above')} your range. The position is back to ${bold(baseSymbol)} plus collected fees, and has stopped earning.`
      : `📉 The price moved ${bold('below')} your range. Your ${esc(baseSymbol)} is now fully converted to ${esc(symbol)}, and the position has stopped earning.`,
    '',
    italic(
      up
        ? 'It will start earning again if the price comes back down into range.'
        : 'It will start earning again if the price comes back up into range.',
    ),
    '',
    `⏱️ <i>Triggered at: ${nowWib()}</i>`,
  ].join('\n');
}

export function msgCrash(kind: string, err: string): string {
  // The first line (the message) only, NOT the stack — that avoids leaking internals
  // or RPC detail and causing panic. Reassure: it restarts automatically, and funds
  // and positions are safe on-chain.
  const firstLine = String(err).split('\n')[0].trim().slice(0, 160) || 'unknown error';
  return card(
    `⚠️ ${title('BRIEF OUTAGE')}`,
    [
      `😵 unexpected error (${bold(kind)}).`,
      '',
      note(`technical: ${firstLine}`),
      note('the bot restarts automatically: funds and positions are safe on-chain.'),
    ],
    nowWib(),
  );
}

export function msgInvalidAmount(): string {
  return card(title('INVALID'), [note('enter a valid amount, e.g. 0.02')]);
}

/** A wizard or swap session expired (left too long). */
export function msgSessionExpired(): string {
  return card(`⌛ ${title('SESSION EXPIRED')}`, [note('the old session was closed. Start again from the menu.')]);
}

export function msgOverLimit(maxLabel: string): string {
  return card(title('LIMIT'), [note(`above the ${maxLabel} limit.`)]);
}

// ─── /unwrap — stuck WETH back to ETH ──────────────────────────────

// The wrapped/native pair follows the chain: WETH->ETH on Robinhood, WBNB->BNB on BSC.
export function msgUnwrapNone(dust: string, wrapped = 'WETH', native = 'ETH', chains?: string[]): string {
  // The check spans EVERY chain, so the wording has to say so — "No stuck WETH" alone
  // reads as though only the active chain was looked at, and the user has no way to
  // know whether WBNB on BSC was covered.
  const scope = chains?.length ? `on any chain (${esc(chains.join(', '))})` : 'in your wallet';
  return [
    `🔄 ${bold(chains?.length ? 'Unwrap wrapped native → native' : `Unwrap ${wrapped} → ${native}`)}`,
    '',
    `No stuck wrapped native ${scope} — every balance is below ${bold(dust)}.`,
    '',
    note(`Wrapped native only ever sits here as an intermediate step (opening an LP, swapping).`),
  ].join('\n');
}

export function msgUnwrapConfirm(
  amount: string,
  usd: string | null,
  dryRun: boolean,
  wrapped = 'WETH',
  native = 'ETH',
  // Stuck wrapped-native can sit on SEVERAL chains at once (WETH on Base, WBNB on
  // BSC, WHYPE on HyperEVM). When populated, the card names them one by one — this
  // command used to look only at the active chain.
  perChain?: Array<{ label: string; amount: string }>,
): string {
  const multi = perChain && perChain.length > 1;
  return [
    `🔄 ${bold(multi ? 'Unwrap wrapped native → native' : `Unwrap ${wrapped} → ${native}`)}`,
    '',
    ...(multi
      ? perChain!.map((c) => `• ${esc(c.label)}: ${bold(c.amount)}`)
      : [`💰 ${bold(`Stuck ${wrapped}:`)} ${bold(amount)}${usd ? ` ${italic(`(${usd})`)}` : ''}`]),
    '',
    multi
      ? `All of it will be unwrapped back to each chain's native asset. One transaction per chain, no swap, no slippage.`
      : `All of it will be unwrapped back to native ${esc(native)}. One transaction, no swap, no slippage.`,
    ...(dryRun ? ['', note('DRY RUN: no transaction will be sent.')] : []),
  ].join('\n');
}

export function msgUnwrapDone(amount: string, txHash: string | null, wrapped = 'WETH', native = 'ETH'): string {
  return [
    `✅ ${bold('Unwrapped')}`,
    '',
    `${bold(amount)} ${esc(wrapped)} → native ${esc(native)}, now in your wallet.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN: no transaction was sent.')]),
    '',
    note(nowWib()),
  ].join('\n');
}

// ─── /bridge — move funds between chains (Relay) ───────────────────

export function msgBridgePick(routes: Array<{ from: string; to: string }>): string {
  // Grouped by source chain: one line per chain you can leave from, with every
  // destination on it. Listing each pair on its own line made twelve near-identical
  // rows for four chains.
  const byFrom = new Map<string, string[]>();
  for (const r of routes) byFrom.set(r.from, [...(byFrom.get(r.from) ?? []), r.to]);
  return [
    `\u{1F309} ${bold('BRIDGE CROSS CHAIN')}`,
    '',
    `${bold('Available Routes :')}`,
    ...[...byFrom].map(([from, tos], i) => `${i + 1}. ${esc(from)} \u2192 ${esc(tos.join('/'))}`),
    '',
    note('a bridge cannot be undone, funds land on the destination chain and only another bridge brings them back.'),
  ].join('\n');
}

export function msgBridgeAsset(fromLabel: string, toLabel: string): string {
  return [
    bold(`${fromLabel} \u2192 ${toLabel}`),
    '',
    'Which asset do you want to bridge?',
    '',
    note('a stablecoin arrives as the matching stablecoin on the destination chain, native arrives as native.'),
  ].join('\n');
}

export function msgBridgeAmount(fromLabel: string, toLabel: string, balanceLabel: string, symbol: string): string {
  return [
    bold(`${fromLabel} \u2192 ${toLabel}`),
    ...(balanceLabel ? [bold(balanceLabel)] : []),
    '',
    `Please type the amount of ${bold(symbol)} to bridge.`,
    // Gas is paid on the SOURCE chain: sending the entire balance makes the tx itself fail.
    note('leave some for gas on the origin chain, sending your whole balance will fail.'),
  ].join('\n');
}

export function msgBridgeConfirm(o: {
  fromLabel: string;
  toLabel: string;
  inLabel: string;
  outLabel: string;
  impactPct: number | null;
  feeUsd: number | null;
  etaSec: number | null;
  dryRun: boolean;
}): string {
  return [
    bold('BRIDGE REVIEW'),
    '',
    `🔗 ${bold('Transaction Details :')}`,
    `- Route: ${esc(o.fromLabel)} → ${esc(o.toLabel)}`,
    `- You send: ${bold(o.inLabel)}`,
    `- You receive ≈ ${bold(o.outLabel)}`,
    ...(o.impactPct !== null ? [`- Value Impact: ${fmtPct(o.impactPct)}`] : []),
    ...(o.feeUsd !== null ? [`- Relayer Fee: ${usdPlain(o.feeUsd)}`] : []),
    ...(o.etaSec !== null ? [`- Estimated Time: ~${Math.max(1, Math.round(o.etaSec))}s`] : []),
    '',
    // The quote is refreshed at confirmation; the figure above becomes its floor.
    italic(
      o.dryRun
        ? '*DRY RUN, nothing will be withdrawn.'
        : '*the quote is refreshed the moment you confirm, if the route moves against you, nothing is sent. Bridges cannot be reversed.',
    ),
  ].join('\n');
}

export function msgBridgeDone(o: {
  fromLabel: string;
  toLabel: string;
  inLabel: string;
  outLabel: string;
  txHashes: string[];
  dryRun: boolean;
}): string {
  const out = [
    `\u2705 ${bold(o.dryRun ? 'BRIDGE (DRY RUN)' : 'BRIDGE SUCCESS')}`,
    '',
    `${esc(o.fromLabel)} \u2192 ${esc(o.toLabel)}`,
    `${bold(o.inLabel)} \u2192 ${bold(o.outLabel)}`,
  ];
  if (o.txHashes.length) {
    out.push('', `${bold('Tx Hash :')}`);
    // Own line each, as <code>: a hash is copied, and a wrapped one copies broken.
    for (const h of o.txHashes) out.push(code(h));
  }
  if (o.dryRun) out.push('', note('DRY RUN: no transaction was sent.'));
  out.push(
    '',
    'Funds usually arrive within seconds. Check /portfolio once the destination chain updates.',
    '',
    note(nowWib()),
  );
  return out.join('\n');
}

export function msgBridgeUnavailable(): string {
  return [
    `🌉 ${bold('Bridge Unavailable')}`,
    '',
    note('bridging needs at least two chains enabled. Only one chain is active right now.'),
  ].join('\n');
}

// ─── /send: transfer to another address ─────────────────────────────────────

export function msgSendAskAddress(): string {
  return [
    `\u{1F4E5} ${bold('WITHDRAW')}`,
    '',
    'Paste the destination address',
    '',
    note('an EVM address is the same on every chain, so the bot cannot tell which one you mean from the address alone. It will show you where you have a balance and let you pick.'),
  ].join('\n');
}

export function msgSendPickAsset(to: string, _chains: string[], anyContract: boolean): string {
  const out = [
    // The FULL address, not the short form: this is the last screen before an amount is
    // chosen, and a withdrawal to the wrong address has no appeal.
    `\u{1F4EE} ${bold('To:')} ${code(to)}`,
    '',
    'Pick what to withdraw.',
  ];
  if (anyContract) {
    out.push(
      '',
      note('this address is a contract on at least one chain. Contracts can reject or trap plain transfers, so those rows are marked.'),
    );
  }
  return out.join('\n');
}

export function msgSendAmount(o: {
  to: string;
  chainLabel: string;
  symbol: string;
  balance: string;
  usable: string;
  nativeReserve: boolean;
  isContract: boolean;
}): string {
  const out = [
    `\u{1F4EE} ${bold('To:')} ${code(shortAddr(o.to))}`,
    // The holding line stays from the button that was tapped, so the figure being split
    // into a percentage is still on screen while the amount is chosen.
    bold(`${o.chainLabel}: ${o.usable}`),
    '',
    'How much do you want to withdraw?',
    '',
    // italic() escapes its argument, so code() inside it would print the tags literally.
    `Tap a percentage, or type ${code('0.5')} or ${code('12.5%')}.`,
  ];
  if (o.nativeReserve) out.push(note('a gas reserve is kept aside, so 100% still leaves enough to pay for the transfer.'));
  if (o.isContract) out.push(note('the destination is a contract on this chain.'));
  return out.join('\n');
}

export function msgSendConfirm(o: {
  to: string;
  chainLabel: string;
  amount: string;
  isContract: boolean;
  dryRun: boolean;
}): string {
  const out = [
    `\u{1F4E4} ${bold('WITHDRAW REVIEW')}`,
    '',
    `${bold(o.amount)} on ${esc(o.chainLabel)}`,
    // FULL address on the last screen before signing: the short form hides exactly the
    // middle characters that tell two similar addresses apart.
    `\u2192 ${code(o.to)}`,
  ];
  if (o.isContract) {
    out.push('', `\u26A0\uFE0F ${bold('That address is a contract on this chain.')}`,
      italic('A contract that does not handle plain transfers keeps the funds for good.'));
  }
  out.push(
    '',
    note(
      o.dryRun
        ? 'DRY RUN, nothing will be withdrawn.'
        : 'check the address one more time. A transfer cannot be reversed, and there is nobody to appeal to.',
    ),
  );
  return out.join('\n');
}

export function msgSendDone(o: {
  to: string;
  chainLabel: string;
  amount: string;
  txHash: string | null;
  dryRun: boolean;
}): string {
  const out = [
    `\u2705 ${bold(o.dryRun ? 'WITHDRAW (DRY RUN)' : 'WITHDRAW SUCCESS')}`,
    '',
    `${bold(o.amount)} on ${esc(o.chainLabel)}`,
    `\u2192 ${code(o.to)}`,
  ];
  if (o.txHash) out.push('', bold('Tx Hash :'), code(o.txHash));
  if (o.dryRun) out.push('', note('DRY RUN, nothing was withdrawn.'));
  out.push('', note(nowWib()));
  return out.join('\n');
}

/**
 * Leftover token recovered after a position closed.
 *
 * The money lands here LONG after the close card was sent, so this is the only place
 * the recovery is ever shown. It names the position it belongs to: without the id the
 * line reads as a windfall from nowhere, when it is really the tail of a trade already
 * in the journal.
 */
export function msgSwept(o: {
  symbol: string;
  tokenId: string;
  amountLabel: string;
  dryRun: boolean;
}): string {
  return [
    `\u267B\uFE0F ${bold('LEFTOVER SWEPT')}`,
    '',
    `${bold(`$${o.symbol}`)} / #${esc(o.tokenId)}: ${bold(`+${o.amountLabel}`)}`,
    'recovered from a closed position, and added to its PnL.',
    '',
    // Chain and route stay in the service log: neither changes what the reader does
    // with this, and both pushed the figure off the first line on a phone.
    note(`${o.dryRun ? 'DRY RUN' : 'LIVE'} \u00B7 ${nowWib()}`),
  ].join('\n');
}

/** Summary after Close All. Names what failed rather than reporting a round number. */
export function msgCloseAllDone(done: number, total: number, failed: string[]): string {
  const ok = failed.length === 0;
  return [
    `${ok ? '\u2705' : '\u{1F7E1}'} ${bold(ok ? 'ALL POSITIONS CLOSED' : 'CLOSE ALL PARTLY DONE')}`,
    '',
    `${bold(String(done))} of ${bold(String(total))} closed`,
    ...(failed.length ? ['', bold('Still open :'), ...failed.map((f) => `\u2022 ${esc(f)}`)] : []),
    '',
    note(nowWib()),
  ].join('\n');
}
