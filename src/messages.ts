/**
 * PHILIPS — Telegram message cards (HTML only).
 *
 * Design: teks biasa — judul tebal + bullet 'label · value'.
 * TIDAK ada <pre>, box-drawing, atau alignment padEnd: font Telegram
 * proporsional, jadi tampilan "terminal" selalu berantakan di HP.
 *
 *  <b>POSITION · #178449</b>
 *  • Pair · WETH / TENDIES (1.00%)
 *  • Deposit · 0.09 WETH
 */
import { ethers } from 'ethers';
import type { BaseKind } from './chains.js';

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

/** Satu baris "label · value" (teks biasa, bukan monospace). */
export function field(label: string, value: string, _width = 0): string {
  return `${label} · ${value}`;
}

/** Beberapa baris label·value; nilai kosong dibuang. */
export function fieldBlock(rows: Array<[string, string]>, _minWidth = 6): string {
  const clean = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (clean.length === 0) return '';
  return clean.map(([l, v]) => `${esc(l)} · ${bold(String(v))}`).join('\n');
}

/** Baris label · value (value ditebalkan, bukan monospace). */
export function hrow(label: string, value: string | number): string {
  return `${esc(label)} · ${bold(value)}`;
}

/** Beberapa baris hybrid; skip value kosong. */
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

/** Blok 'label · value' (teks biasa). */
/** Daftar baris; tiap baris = sel-sel digabung ' · '. Header dibuang (tak ada kolom). */
export function alignTable(header: string[], rows: string[][], _right: boolean[] = []): string {
  return rows.map((cells) => cells.filter((c) => c !== '' && c != null).join(' · ')).join('\n');
}

// ─── header ────────────────────────────────────────────────────────

/** Judul kartu — teks tebal biasa (tanpa box/monospace). */
export function hdr(text: string): string {
  return `<b>${esc(text)}</b>`;
}

/** Emoji dinamis untuk angka PnL: hijau/merah/netral (perbaikan.md §1.2). */
export function dot(n: number | null | undefined): string {
  if (n === null || n === undefined) return '⚪';
  return n > 0 ? '🟢' : n < 0 ? '🔴' : '⚪';
}

/** Daftar bullet 'label · value' (tanpa garis pohon). */
export function tree(rows: Array<[string, string]>, _width = 12): string[] {
  return rows.map(([k, v]) => `• ${esc(k)} · ${v}`);
}

/** Teks polos (dulu blok <pre>). */
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
  return Number(ethers.formatUnits(wei, dec)).toLocaleString('en-US', {
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
  return '$' + n.toFixed(2);
}

/** USD ringkas: $1.5M / $50.9K / $79. Untuk daftar pool & kedalaman. */
export function usdCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}

/** Persen bertanda, SATU format untuk seluruh bot: '+13.3%' / '-0.7%'. */
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

/** Jam lokal pemilik bot (WIB, UTC+7) — bukan UTC: kartu dibaca dari HP di Jakarta. */
export function nowWib(): string {
  const d = new Date(Date.now() + 7 * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} WIB`;
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

  // "Robinhood 0.0376 ETH" → label chain, value amount
  return parts.map((p) => {
    const m = p.match(/^(\S+)\s+(.+)$/);
    return m ? ([m[1].toLowerCase(), m[2]] as [string, string]) : (['balance', p] as [string, string]);
  });
}

// ─── cards ─────────────────────────────────────────────────────────

// Badan cockpit bersama /start & /help: VIEW/EXECUTION/EMERGENCY dalam pohon.
function cockpitLines(dryRun: boolean): string[] {
  const grp = (rows: Array<[string, string]>) => rows.map(([c, d]) => `• ${c} — ${esc(d)}`);
  return [
    `📊 ${bold('View & Analytics :')}`,
    ...grp([
      ['/status', 'Balance, equity & wallet breakdown'],
      ['/positions', 'Live monitoring of active LPs'],
      ['/pnl', 'PnL recap & closed-trade journal'],
      ['/alerts', 'Position notification settings'],
    ]),
    '',
    `⚙️ ${bold('Execution & Trade :')}`,
    ...grp([
      ['/add_lp', 'Open a new LP position'],
      ['/claim_fees', 'Harvest fees without closing'],
      ['/remove_lp', 'Withdraw 25/50/75% of liquidity'],
      ['/stop', 'Close an LP position completely'],
      ['/unwrap', 'Return stuck wrapped native to native'],
      ['/buy', 'Buy a token (best route)'],
      ['/sell', 'Sell a token from your wallet'],
      ['/bridge', 'Move native funds between chains'],
    ]),
    '',
    `⚠️ ${bold('Notice :')}`,
    `Commands under ${bold('Execution & Trade')} will move funds on-chain. Always double-check details before signing.`,
    // Jalur masuk yang tak punya command sendiri — satu-satunya tempat ia disebut.
    '',
    note('Tip: paste a token CA straight into this chat to open its audit card.'),
    // Mode simulasi mengubah arti SELURUH daftar di atas (tak ada uang bergerak).
    ...(dryRun ? ['', note('mode: DRY RUN — no transaction is ever sent.')] : []),
  ];
}

/** Kartu daftar perintah (/help). */
export function msgHelp(dryRun: boolean): string {
  return [bold('PHILIPS · LP Cockpit'), '', ...cockpitLines(dryRun)].join('\n');
}

/**
 * Kartu /start — PENANDA BOT HIDUP saja (Telegram mengirim /start otomatis saat
 * chat dibuka & tombol Start ditekan). Daftar perintah ada di /help; di sini cukup
 * satu keadaan + hasil sinkron, supaya tak jadi dua bubble.
 */
export function msgStarted(o: {
  dryRun: boolean;
  chainLabel: string;
  chainId: string | number | bigint;
  positions: number;
  imported: number;
  gone: number;
  walletShort?: string | null;
}): string {
  const sync =
    o.imported || o.gone
      ? [o.imported ? `+${o.imported} imported` : '', o.gone ? `${o.gone} closed outside the bot` : '']
          .filter(Boolean)
          .join(' · ')
      : '';
  return [
    `🤖 ${bold('Welcome to PHILIPS!')}`,
    '',
    `PHILIPS is your personal assistant for managing Single-Side Liquidity Pools (LP) on ${bold('Uniswap')}. PHILIPS goal is to make DeFi simple, secure, and efficient. Whether you are automatically buying the dip, taking profit on the rip, or tracking your fees, I've got you covered.`,
    '',
    `🛠️ ${bold('Core Features :')}`,
    '• Connect your Robinhood Wallet (Manual Import)',
    '• Single-Side LP (Provide liquidity with only 1 token)',
    '• Automated Token Security Audit &amp; Rug Pull Check',
    '• Track active LP positions, APR, and earned fees',
    '',
    `⚠️ ${bold('Security Notice :')}`,
    // Pintu resminya kini tombol Connect Wallet di /settings — /connect sudah dihapus,
    // dan menyuruh user mengetik perintah yang tak ada persis membuka celah yang
    // peringatan ini coba tutup (dia mencari "alur resmi" lalu percaya yang palsu).
    `PHILIPS will ${bold('never')} ask for your Seed Phrase outside of the official Connect Wallet flow in ${code('/settings')}. DeFi involves risks, including Impermanent Loss (IL). ${bold('Always DYOR.')}`,
    '',
    // Blok "Bot Status" dibuang atas permintaan. Dua hal tetap disebut karena
    // mengubah arti kartu ini: mode simulasi (tak ada uang bergerak) dan hasil
    // sinkronisasi posisi (bot menemukan/menutup posisi tanpa kamu minta).
    ...(o.dryRun ? [`⚪ ${bold('DRY RUN')} — simulation mode, no funds will move.`, ''] : []),
    ...(sync ? [`🔄 ${bold('Sync:')} ${esc(sync)}`, ''] : []),
    `👉 ${bold('Get Started :')}`,
    o.walletShort
      ? 'Tap the button below to open a new Single-Side LP and start earning trading fees.'
      : 'Tap the button below to Connect your Robinhood Wallet and start earning trading fees.',
  ].join('\n');
}

/** Cara memulai LP — dipakai tombol "Buka LP" di /start (belum ada wizard tanpa CA). */
export function msgAddHowTo(): string {
  return [
    `💧 ${bold('Open a Single-Side LP')}`,
    '',
    'Provide liquidity using only one token. This acts as a passive limit order where you earn trading fees while waiting for your target price.',
    '',
    `📝 ${bold('How to Start :')}`,
    `• ${bold('Quick Method ->')} Paste a token Contract Address (CA) directly in this chat.`,
    `• ${bold('Wizard Method ->')} Type ${code('/add_lp [CA]')} to enter the step-by-step setup.`,
    // Jalur ketiga yang benar-benar ada: /add_lp tanpa CA membuka pemilih pair.
    // Tanpa disebut, satu-satunya cara menemukannya adalah tak sengaja.
    `• ${bold('No CA? ->')} Type ${code('/add_lp')} on its own to pick from the top pools.`,
    '',
    note(nowWib()),
  ].join('\n');
}

/** Kartu "How it Works" — penjelasan statis, dipanggil dari tombol di /start. */
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
    note('any key that has already been sent to a chat should be treated as compromised — move the funds.'),
    note('if that was just a tx hash (0x + 64 chars), ignore this — the bot never takes a tx hash as input.'),
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
    `3️⃣ ${bold('Open a single-side LP')} — /add_lp. You deposit only one token; the position works like a passive limit order that keeps earning fees while it waits for your price.`,
    '',
    `4️⃣ ${bold('Monitor & harvest')} — /positions for in/out of range status, /claim_fees to harvest, /remove_lp to withdraw.`,
    '',
    `⚠️ ${bold('Risk')}: price can move through your range (impermanent loss), and new tokens can rug. PHILIPS blocks the clearly dangerous ones, but the final call is always yours.`,
  ].join('\n');
}

export function msgV4Position(p: {
  tokenId: string;
  pair: string;
  feeLabel: string;
  valueLabel: string; // "$12.34" / "0.02 ETH" / "—"
  feesLabel?: string; // fee belum diklaim, sudah termasuk di valueLabel
  rangeLabel: string; // "+5.2% / -3.1%" / "—"
  inRange: boolean | null;
  pnlText?: string; // hanya bila dikelola bot (entry diketahui)
  tracked: boolean;
  priceWarn?: string | null; // pool sekarat: harga on-chain melenceng dari pasar
  baseSymbol?: string; // ETH | USDG
  tokenSymbol?: string; // sisi token (non-base)
  age?: string;
  chain?: string;
  mcRange?: string; // rentang yang sama dibaca sebagai kapitalisasi pasar
  converted?: boolean; // out-of-range & 100% token seberang (target tercapai)
  ladder?: { legIndex: number; legCount: number; shape: string; groupDeposit?: string; sharePct?: number; progress?: string;
    // Ringkasan SELURUH ladder — inti fitur bid-ask. Tanpa ini kartu leg hanya
    // memperlihatkan satu anak tangga, padahal yang disetor user adalah ladder.
    valueLabel?: string; feesLabel?: string; pnlText?: string; mcRange?: string;
    filled?: number; active?: number; waiting?: number }; // leg dari grup ladder
}): string {
  // Samakan layout dengan kartu V3 (msgPositionCard): satu fakta satu baris,
  // status di barisnya sendiri, ada strategi + penjelasan uang.
  const base = esc(p.baseSymbol ?? 'ETH');
  const sym = esc(p.tokenSymbol ?? p.pair.split('/').map((s) => s.trim()).find((s) => s !== p.baseSymbol) ?? 'token');
  const isLadderLeg = !!p.ladder && p.ladder.legCount > 1;
  // Leg ladder yang terserap BUKAN kegagalan — itu tugasnya. "OUT OF RANGE"
  // merah pada satu anak tangga terbaca seperti seluruh posisi bermasalah,
  // padahal ladder-nya masih jalan. Leg terisi dapat kata & warnanya sendiri.
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
      ? `Range status couldn't be read right now — the value above may be stale.`
      : p.inRange
        ? `Your liquidity is ${bold('active')} and earning fees right now. As long as ${sym} stays inside this range, fees keep accruing.`
        : p.converted
          ? p.ladder && p.ladder.legCount > 1
            // Leg ladder yang habis terserap itu NORMAL, bukan tanda ladder-nya
            // gagal — anak tangga terisi satu per satu dari atas. Sebut porsi
            // modalnya supaya "OUT OF RANGE" pada kartu SATU leg tak terbaca
            // seolah seluruh modal ladder sudah berubah jadi token.
            ? `Price dropped through ${bold('this leg')}'s range, so leg ${p.ladder.legIndex + 1} of ${p.ladder.legCount} is now ${bold(`100% ${sym}`)}${p.ladder.sharePct !== undefined ? ` — ${bold(`${p.ladder.sharePct.toFixed(1)}%`)} of the ladder` : ''}. That is how a ladder works: rungs fill one at a time from the top. The legs below still hold ${base} and are waiting for lower prices. Judge the ladder as a whole, not this rung alone.`
            : `Price dropped through this position's entire range, so it is now ${bold(`100% ${sym}`)} — the buy-dip target here is done. The value above is that ${sym} priced back in ${base}; it falls further if ${sym} keeps dropping. Hold and wait for a bounce, or close.`
          : `Your liquidity is currently inactive. It will automatically convert to ${sym} and start earning fees once the token price ${bold('drops')} into your target range (${esc(p.rangeLabel)}).`;

  const isLeg = p.ladder && p.ladder.legCount > 1;
  const lines = [
    `📊 ${bold(`Position Details: #${esc(p.tokenId)}`)}`,
    '',
    `🔗 ${bold('Pair:')} ${esc(p.pair)} ${italic(`(${esc(p.feeLabel)} Fee)`)}${p.chain ? ` · ${esc(p.chain)}` : ''}`,
    `🎯 ${bold('Strategy:')} ${base} Side (Buy the dip)${isLeg ? ` · ${bold(`◣ ${p.ladder!.shape === 'bidask' ? 'Bid-Ask' : 'Spot'} ladder`)}` : ''}`,
    // ── Blok LADDER dulu (yang disetor user adalah ladder), baru blok leg. ──
    ...(isLeg
      ? [
          '',
          `🪜 ${bold(`LADDER · ${p.ladder!.legCount} legs`)}`,
          ...(p.ladder!.groupDeposit ? [`💰 ${bold('Deposit:')} ${esc(p.ladder!.groupDeposit)} ${base}`] : []),
          ...(p.ladder!.valueLabel
            ? [
                `💰 ${bold('Value now:')} ${esc(p.ladder!.valueLabel)}`,
                ...(p.ladder!.feesLabel ? [italic(`↳ termasuk fee ${esc(p.ladder!.feesLabel)}`)] : []),
              ]
            : []),
          ...(p.ladder!.pnlText ? [`📈 ${bold('Ladder PnL:')} ${esc(p.ladder!.pnlText)}`] : []),
          ...(p.ladder!.mcRange ? [`📉 ${bold('Ladder Range:')} ${italic(esc(p.ladder!.mcRange))}`] : []),
          ...(p.ladder!.filled !== undefined
            ? [`🎚 ${bold('Rungs:')} ${p.ladder!.filled} terisi · ${p.ladder!.active} aktif · ${p.ladder!.waiting} menunggu`]
            : []),
          '',
          `${italic(`— leg ${p.ladder!.legIndex + 1} dari ${p.ladder!.legCount}${p.ladder!.sharePct !== undefined ? `, ${p.ladder!.sharePct.toFixed(1)}% modal ladder` : ''} —`)}`,
        ]
      : []),
    `💰 ${bold(isLeg ? 'Leg Value:' : 'Value:')} ${esc(p.valueLabel)}`,
    ...(p.feesLabel ? [italic(`↳ termasuk fee ${esc(p.feesLabel)}`)] : []),
    `📉 ${bold(isLeg ? 'Leg Range:' : 'Target Range:')} ${esc(p.rangeLabel)} ${italic('dari harga kini')}`,
    ...(p.mcRange ? [italic(`↳ market cap ${esc(p.mcRange)}`)] : []),
    ...(p.pnlText ? [`📈 ${bold('Current PnL:')} ${esc(p.pnlText)}`] : []),
    `${statusEmoji} ${bold('Status:')} ${status}`,
  ];
  if (p.priceWarn) lines.push('', `⚠️ ${bold('Pool tipis')} — ${esc(p.priceWarn)}`);
  lines.push(
    '',
    `⏱️ <i>${p.age ? `Age ${esc(p.age)} · ` : ''}Updated Live: ${nowWib()}</i>`,
    '',
    `<i>${explain}</i>`,
    '',
    note(p.tracked ? 'Uniswap v4 · dikelola bot' : 'Uniswap v4 · baca-saja (dibuka di luar bot)'),
  );
  return lines.join('\n');
}

/** Hasil tutup posisi v4 (atau simulasi dry-run). */
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
      note(`simulation valid — when live, funds return${o.base ? ` and are cashed out to ${o.base}` : ''}.`),
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

/** Hasil tambah likuiditas v4 (atau simulasi dry-run). */
export function msgV4Added(o: {
  tokenId?: string;
  sizeEth: string;
  rangeLabel: string;
  txHash?: string;
  dryRun: boolean;
}): string {
  if (o.dryRun) {
    return card(`⚪ ${title('ADD v4 (DRY)')}`, [
      ...hrows([
        ['Deposit', o.sizeEth],
        ['Range', o.rangeLabel],
      ]),
      '',
      note('simulation valid — no transaction was sent.'),
    ]);
  }
  const body: string[] = [
    `🟢 ${bold('new v4 position opened')} — monitoring is active`,
    '',
    ...hrows([
      ['Deposit', o.sizeEth],
      ['Range', o.rangeLabel],
    ]),
  ];
  if (o.txHash) body.push('', ...hrows([['tx', shortAddr(o.txHash)]]));
  return card(`✅ ${title('ADDED v4', o.tokenId ? `#${o.tokenId}` : '')}`, body, nowWib());
}

/** Konfirmasi tutup posisi Uniswap v4. */
export function msgV4CloseConfirm(tokenId: string): string {
  return [
    `🔴 ${bold('Confirm Close (v4)')}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)} (Uniswap v4)`,
    '',
    '⚠️ The position is burned; ALL liquidity plus fees (both tokens) return to your wallet — with no auto-swap.',
    '',
    bold('Close this position?'),
  ].join('\n');
}

/** Alert monitor: posisi v4 (dikelola bot) masuk/keluar range. */
export function msgV4Range(tokenId: string, inRange: boolean): string {
  return inRange
    ? [
        `🟢 ${bold('Alert: v4 Position In Range')}`,
        '',
        `Position ${bold(`#${esc(tokenId)}`)} (Uniswap v4) is back inside its price range — fees are flowing again.`,
        '',
        `⏱️ <i>Triggered at: ${nowWib()}</i>`,
      ].join('\n')
    : [
        `🔴 ${bold('Alert: v4 Position Out of Range')}`,
        '',
        `Position ${bold(`#${esc(tokenId)}`)} (Uniswap v4) has left its effective price range.`,
        'Fee income has stopped. Consider closing or repositioning it.',
        '',
        `⏱️ <i>Triggered at: ${nowWib()}</i>`,
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

export function msgStatus(opts: {
  dryRun: boolean;
  chainId: string | number | bigint;
  positions: number;
  limitLabel: string; // '∞' atau mis. '0.5 ETH'
  wallet: string;
  /** Per chain: saldo native + stablecoin base yang dipegang di chain itu. */
  chains: Array<{
    label: string;
    amount: string;
    symbol: string;
    usd: number | null;
    stables?: Array<{ symbol: string; amount: string; usd: number | null }>;
  }>;
  totalUsd: number | null; // null = harga native tak terbaca (JANGAN 0)
  holdingsCount: number | null; // null = pembacaan gagal (BUKAN 'bersih')
  lpUsd?: number | null; // nilai posisi LP aktif
  lpFailed?: number; // posisi yang gagal dibaca → total belum lengkap
  realizedEth?: number; // PnL cashout seumur hidup
  explorerUrl?: string | null; // base URL explorer → alamat jadi tautan (null = teks biasa)
  sellInto?: string; // aset tujuan yang disarankan saat menjual token nganggur
}): string {
  // USD tak terbaca → '—' (netral), JANGAN '$0.00' yang terbaca sebagai fakta.
  const usdCol = (u: number | null | undefined) => (u === null || u === undefined ? '—' : usdPlain(u));
  const equity = opts.totalUsd === null ? '—' : usdPlain(opts.totalUsd + (opts.lpUsd ?? 0));

  const held = opts.chains.filter((c) => Number(c.amount) > 0 || (c.stables ?? []).length > 0);
  const assetNames = [
    ...new Set(
      held.flatMap((c) => [
        ...(Number(c.amount) > 0 ? [c.symbol] : []),
        ...(c.stables ?? []).map((t) => t.symbol),
      ]),
    ),
  ];

  const parts: string[] = [
    bold('PORTFOLIO'),
    '',
    `💰 ${bold('Equity Summary :')}`,
    `• Total Equity = ${bold(equity)}`,
    `• Unstaked Balance = ${bold(usdCol(opts.totalUsd))}${assetNames.length ? ` ${italic(`(${assetNames.join(', ')})`)}` : ''}`,
  ];
  if (opts.lpUsd !== undefined) {
    parts.push(
      `• Active in LP = ${bold(usdCol(opts.lpUsd))} ${italic(`(${opts.positions} Position${opts.positions === 1 ? '' : 's'})`)}`,
    );
  }
  if (opts.realizedEth !== undefined) {
    parts.push(
      `• Realized PnL = ${bold(`${opts.realizedEth >= 0 ? '+' : ''}${opts.realizedEth.toFixed(5)} ETH`)}`,
    );
  }

  // Rincian per CHAIN, bukan per aset lepas: stablecoin ikut baris chain tempat ia
  // benar-benar berada. Baris "USDG" berdiri sendiri dulu menyamarkan chain-nya.
  if (held.length) {
    parts.push('', `📊 ${bold('Asset Breakdown :')}`);
    for (const c of held) {
      const cells: string[] = [];
      if (Number(c.amount) > 0) {
        cells.push(`${esc(c.amount)} ${esc(c.symbol)}${c.usd === null ? '' : ` (${usdPlain(c.usd)})`}`);
      }
      for (const t of c.stables ?? []) {
        cells.push(`${esc(t.amount)} ${esc(t.symbol)}${t.usd === null ? '' : ` (${usdPlain(t.usd)})`}`);
      }
      parts.push(`• ${bold(c.label)} = ${cells.join(' | ')}`);
    }
  }

  if (opts.lpFailed) parts.push('', `⚠️ ${note(`${opts.lpFailed} position(s) failed to read — total is incomplete`)}`);
  if (opts.holdingsCount === null) {
    parts.push('', `⚠️ ${note('token read failed — try Refresh')}`);
  } else if (opts.holdingsCount > 0) {
    parts.push(
      '',
      `⚠️ ${bold('Action Required :')}`,
      `• You have ${bold(`${opts.holdingsCount} idle token${opts.holdingsCount === 1 ? '' : 's'}`)} sitting in your wallet earning nothing.`,
      `• Use /sell to convert them back to ${esc(opts.sellInto ?? 'WETH/USDG')}.`,
    );
  }

  const short = esc(shortAddr(opts.wallet));
  const link = opts.explorerUrl
    ? `<a href="${esc(opts.explorerUrl)}/address/${esc(opts.wallet)}">${short}</a>`
    : `<code>${short}</code>`;
  parts.push(
    '',
    `🔗 ${bold('Wallet')} → ${link}`,
    `<code>${esc(opts.wallet)}</code>`,
    '',
    `${opts.dryRun ? '⚪ DRY RUN' : '🟢 LIVE'} · max/tx ${esc(opts.limitLabel)}`,
    `<i>Last Updated: ${nowWib()}</i>`,
  );

  return parts.join('\n');
}

/** Nilai ETH bertanda: '+0.14811 ETH' / '-0.02 ETH'. */
function sgEth(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(5)} ETH`;
}

export function msgPnlPicker(chains: Array<{ label: string; trades: number }>): string {
  const out = [`📈 ${bold('PnL Recap')}`, '', 'Pick a chain to recap its closed trades.', ''];
  if (chains.length) {
    out.push(...tree(chains.map((c) => [c.label, `${c.trades} closed trade${c.trades === 1 ? '' : 's'}`]), 12), '');
  }
  out.push(note('Books stay per denomination — ETH, BNB, USDG and USDT are never summed together.'));
  return out.join('\n');
}

/**
 * Kartu rekap PnL untuk satu periode. SATU BUKU PER DENOMINASI: ETH, BNB, USDG,
 * USDT punya baris sendiri. Menjumlahkannya jadi satu angka "net ETH" itu salah —
 * dan versi lama menghindarinya dengan MEMBUANG buku non-ETH, sehingga seluruh
 * riwayat BSC tak pernah kelihatan sama sekali.
 */
export function msgPnl(opts: {
  dryRun: boolean;
  chainLabel: string;
  periodLabel: string;
  known: number;
  count?: number;
  untracked?: number;
  excluded?: number;
  recovered?: number;
  books: Array<{
    unit: string;
    known: number;
    wins: number;
    losses: number;
    flats?: number;
    net: number;
    grossWin: number;
    grossLoss: number;
    best?: { symbol: string; pnl: number };
    worst?: { symbol: string; pnl: number };
  }>;
}): string {
  const head = `📈 ${bold('PnL Recap')} · ${bold(esc(opts.chainLabel))} · ${esc(opts.periodLabel)}`;
  if (opts.known === 0) {
    const out = [head, '', note('no closed trades with a measured result in this period.')];
    if (opts.untracked) out.push(note(`${opts.untracked} closed outside the bot (result unknown).`));
    out.push('', note(`${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
    return out.join('\n');
  }
  const num = (v: number, unit: string): string => {
    const d = unit === 'USDG' || unit === 'USDT' ? 2 : 5;
    return `${v >= 0 ? '+' : ''}${v.toFixed(d)} ${unit}`;
  };
  const out = [head, ''];
  for (const b of opts.books) {
    // Impas (PnL tepat 0) tak masuk penyebut winrate — kalau ikut, winrate naik
    // tanpa satu pun trade tambahan yang benar-benar menang.
    const winrate = b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses)) * 100 : 0;
    // b.known SUDAH hanya menang+kalah (impas tak dihitung), jadi tak perlu dikurangi.
    const pf = b.grossLoss < 0 ? b.grossWin / Math.abs(b.grossLoss) : null;
    const avgWin = b.wins > 0 ? b.grossWin / b.wins : 0;
    const avgLoss = b.losses > 0 ? b.grossLoss / b.losses : 0;
    out.push(
      `${dot(b.net)} ${bold(`${esc(b.unit)} book`)} : ${bold(num(b.net, b.unit))}`,
      ...tree(
        [
          ['Trades', `${b.known} (${b.wins}W / ${b.losses}L)`],
          ['Winrate', `🎯 ${bold(`${winrate.toFixed(1)}%`)}`],
          // Impas dipisah supaya jelas ia TAK ikut menghitung winrate/PF.
          ...((b.flats ? [['Flat', `${b.flats} trade (under ~$0.1 — not scored)`]] : []) as Array<[string, string]>),
          // Profit factor <1 = rugi, seberapa pun tingginya winrate.
          ['Profit factor', pf === null ? '—' : `${pf < 1 ? '🔴' : '🟢'} ${bold(pf.toFixed(2))}`],
          ['Avg win', `🟢 ${num(avgWin, b.unit)}`],
          ['Avg loss', `🔴 ${num(avgLoss, b.unit)}`],
          ['Profit', `🟢 ${num(b.grossWin, b.unit)}`],
          ['Loss', `🔴 ${num(b.grossLoss, b.unit)}`],
          ...((b.best ? [['Best', `${b.best.symbol} (${num(b.best.pnl, b.unit)})`]] : []) as Array<[string, string]>),
          ...((b.worst && b.worst.pnl < 0
            ? [['Worst', `${b.worst.symbol} (${num(b.worst.pnl, b.unit)})`]]
            : []) as Array<[string, string]>),
        ],
        9,
      ),
      '',
    );
  }
  const tail: string[] = [];
  if (opts.recovered)
    out.push(note(`Includes ${opts.recovered} leftover sweep(s) credited to the books above (not counted as trades).`));
  if (opts.untracked) tail.push(`${opts.untracked} closed outside the bot (result unknown)`);
  if (opts.excluded) tail.push(`${opts.excluded} legacy entries without result data`);
  if (tail.length) out.push(note(`Not counted: ${tail.join(' · ')}.`));
  out.push(note(`${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
  return out.join('\n');
}

/**
 * Posisi terkonversi penuh. `tokenSide` menentukan arah: sisi base berubah jadi
 * token saat harga JATUH, sisi token berubah jadi base saat harga NAIK — jadi
 * saran pemulihannya juga berlawanan.
 */
export function msgConverted(tokenId: string, baseSym: string, tokenSym: string, tokenSide: boolean): string {
  const from = tokenSide ? tokenSym : baseSym;
  const into = tokenSide ? baseSym : tokenSym;
  return [
    `🔴 ${bold('Alert: Position Converted')} ${tokenSide ? '⬆️' : '⬇️'}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSym)} / ${esc(tokenSym)}`,
    '',
    `⚠️ ${bold('RISK NOTICE:')} Your ${esc(from)} has been 100% converted to ${esc(into)}.`,
    `💡 ${bold('Suggestion:')} Your principal will only recover if the ${esc(tokenSym)} price ${tokenSide ? 'falls' : 'rises'} again. Consider /remove_lp to withdraw, or /stop to close and cash out.`,
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
    note('this already accounts for the fees collected — it is not theoretical IL.'),
    '',
    `⏱️ <i>Triggered at: ${nowWib()}</i>`,
  ].join('\n');
}

export function msgPriceDrop(
  tokenId: string,
  symbol: string,
  dropPct: number,
  baseSymbol = 'WETH',
  tier?: number, // anak tangga yang baru dilewati — menandai ini alert LANJUTAN
): string {
  // Alert kedua & seterusnya harus terbaca beda dari yang pertama; kalau tampilannya
  // identik, penurunan yang makin dalam gampang dikira notifikasi lama yang terulang.
  const deep = tier !== undefined && tier >= 50;
  return [
    `${deep ? '🚨' : '🔴'} ${bold(`Alert: Price Drop${tier !== undefined ? ` · past −${tier}%` : ''}`)}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSymbol)} / ${esc(symbol)}`,
    '',
    `📉 ${bold(`${esc(symbol)} is down ${fmtPct(-dropPct)} from your entry price.`)}`,
    '',
    // Tombol '⛔ Close Now' menyertai pesan ini (monitor.ts) — microcopy menunjuk ke
    // tombol itu, bukan menyuruh mengetik command saat harga jatuh.
    note('close it now with the button below, or hold if you still believe in it.'),
  ].join('\n');
}

export function msgCloseAllPick(countV3: number, countV4 = 0): string {
  const total = countV3 + countV4;
  return [
    `⛔ ${bold('Close LP Position')}`,
    '',
    `Found ${bold(`${total} active LP position${total === 1 ? '' : 's'}`)}${countV4 ? ` (${countV3} v3 · ${countV4} v4)` : ''}.`,
    'Pick the one to close — tap ⛔ Close on its card.',
    '',
    note('each close still goes through its own confirmation.'),
  ].join('\n');
}

// ─── /buy /sell token (base↔token, rute terbaik) ───────────────────────
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
  // note() → italic() → esc(): apa pun HTML di dalamnya ikut ter-escape (user melihat
  // '<b>PONS</b>' mentah). Rakit di sini, jangan bikin primitif baru.
  return `${italic('Review the details and safety of ')}${bold(sym)}${italic(' above. Continue to pick the asset and amount.')}`;
}

export function msgSellList(n: number): string {
  return [
    `📉 ${bold('Sell Token')}`,
    '',
    `You hold ${bold(String(n))} token${n === 1 ? '' : 's'} — pick one to sell :`,
  ].join('\n');
}

export function msgSellNoHoldings(): string {
  return [
    `📉 ${bold('Sell Token')}`,
    '',
    note('no tokens with a balance in your wallet (other than base assets).'),
  ].join('\n');
}

export function msgSellAmount(sym: string, balLabel: string): string {
  return [
    `📉 ${bold('Sell Token')}`,
    '',
    `🔗 ${bold('Token:')} ${esc(sym)}`,
    `💰 ${bold('Balance:')} ${esc(balLabel)}`,
    '',
    'How much do you want to sell?',
    note('the receiving asset is picked automatically — whichever route returns the most value.'),
  ].join('\n');
}

/** Kartu satu alur di /settings: angka yang dipakai sekarang. */
export function msgPctPreset(label: string, values: number[], defaults: number[], noFull: boolean): string {
  const same = values.length === defaults.length && values.every((v, i) => v === defaults[i]);
  return [
    `⚙️ ${bold(`${esc(label)} — quick percentages`)}`,
    '',
    `🎚 ${bold('Now:')} ${values.map((v) => code(`${v}%`)).join('  ')}`,
    `${note(`default: ${defaults.join(' / ')}${same ? ' (unchanged)' : ''}`)}`,
    '',
    `These are the buttons shown when you pick an amount in ${bold(esc(label))}.`,
    ...(noFull
      ? ['', note('100% is not allowed here — withdrawing everything closes the position, which has its own button.')]
      : []),
  ].join('\n');
}

/** Prompt ketik daftar persen. */
export function msgPctAsk(label: string, current: number[], noFull: boolean): string {
  return [
    `✏️ ${bold(`Edit ${esc(label)} percentages`)}`,
    '',
    `💬 Type up to 4 numbers, separated by spaces — e.g. ${code('10 25 50 90')}.`,
    '',
    `${note(`current: ${current.join(' / ')}`)}`,
    note(`each one 1–${noFull ? '99' : '100'}, duplicates dropped, sorted automatically.`),
  ].join('\n');
}

export function msgPctInvalid(noFull: boolean): string {
  return msgError(
    'percentages',
    `Give 1–4 whole numbers between 1 and ${noFull ? '99' : '100'} (e.g. ${'10 25 50 90'}).` +
      (noFull ? ' 100% is not allowed here — that would close the position.' : ''),
  );
}

export function msgSellTypeAmount(sym: string): string {
  return [`📉 ${bold('Sell Token')}`, '', `💬 Type how much ${bold(sym)} to sell (or ${code('all')}).`].join('\n');
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

export function msgTSwapAmountPrompt(buy: boolean, sym: string, balanceLine: string): string {
  return [
    `${buy ? '📈' : '📉'} ${bold(buy ? 'Buy Amount' : 'Sell Amount')}`,
    '',
    balanceLine,
    '',
    `💬 Type how much ${bold(sym)} to ${buy ? 'spend' : 'sell'}${buy ? '' : ` (or ${code('all')})`}.`,
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
  danger?: boolean; // verdikt audit BAHAYA (ikut sampai kartu pengirim tx)
  screenFailed?: boolean;
  balanceLabel?: string;
  shortLabel?: string | null; // kurang berapa (bila kurang → tombol Konfirmasi tak dirender)
}): string {
  const body: string[] = [
    `${o.buy ? '📈' : '📉'} ${bold(o.buy ? 'Buy Order Preview' : 'Sell Order Preview')}`,
    '',
    `🔗 ${bold('Token:')} ${esc(o.tokenSym)} (${esc(o.chainLabel)})`,
    '',
    `📤 ${bold('You pay:')} ${bold(o.amountInLabel)}`,
    `📥 ${bold('You receive ≈')} ${bold(o.estOutLabel)}`,
    `🛣️ ${bold('Route:')} ${esc(o.route)}`,
    // 5%→15% hanya berlaku untuk rute router; rute relay dilindungi quoter penyedia.
    `🛡️ ${bold('Slippage:')} ${o.route.startsWith('uniswap') ? 'auto 5% → 15%' : `${esc(o.route)} (auto)`}`,
  ];
  if (o.balanceLabel) body.push(`💰 ${bold('Balance:')} ${esc(o.balanceLabel)}`);
  if (o.shortLabel) {
    body.push('', `🔴 ${bold(`Short by ${esc(o.shortLabel)}`)} — top up your wallet, then try again.`);
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

export function msgTSwapDone(o: {
  buy: boolean;
  tokenSym: string;
  amountInLabel: string;
  outLabel: string;
  route?: string;
  dryRun: boolean;
}): string {
  if (o.dryRun) {
    return [
      `⚪ ${bold('Swap (DRY RUN)')}`,
      '',
      note('DRY RUN mode — nothing was executed.'),
      '',
      ...tree([['Pay', bold(o.amountInLabel)], ['≈ get', bold(o.outLabel)]], 8),
    ].join('\n');
  }
  return [
    `✅ ${bold(o.buy ? 'Buy Order Filled' : 'Sell Order Filled')}`,
    '',
    `🟢 ${bold('Received:')} ${bold(`+${o.outLabel}`)}`,
    '',
    ...tree(
      [
        ['Paid', esc(o.amountInLabel)],
        ['Token', esc(o.tokenSym)],
        ['Route', esc(o.route ?? '—')],
      ],
      8,
    ),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgError(where: string, err: string): string {
  // Revert ethers = blok multi-baris (reason/code/transaction) yang menutupi baris
  // "lakukan ini". Ambil baris pertama saja; detail lengkap tetap ada di log service.
  const first = String(err).split('\n')[0].trim().slice(0, 200) || 'unknown error';
  // Kartu berjanji "details are in the service log" — dan janji itu dulu BOHONG:
  // 156 dari 177 catch tak menulis apa pun, jadi bagian yang dipotong hilang total
  // dan error tak bisa diaudit sesudahnya. Satu baris di sini menutup ke-42 pemanggil.
  console.error(`[error:${where}] ${String(err).replace(/\s+/g, ' ').slice(0, 500)}`);
  return [
    hdr('❌ TRANSACTION ERROR'),
    '',
    `${esc('Step')}   : ${bold(esc(where))}`,
    `${esc('Reason')} : ${code(first)}`,
    '',
    note('try again — full details are in the service log.'),
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
    [note('token found on several chains — pick one below.')],
  );
}

export function msgPositionCard(opts: {
  tokenId: string;
  symbol: string;
  fee: number;
  invest: string;
  pnlText: string;
  range: string;
  mcRange?: string; // rentang yang sama dibaca sebagai kapitalisasi pasar
  inRange: boolean;
  age: string;
  dryRun: boolean;
  chain?: string;
  baseSymbol?: string; // WETH (default, posisi lama) | USDG
  side?: 'base' | 'token'; // sisi setoran; kosong = base (posisi lama)
  converted?: boolean; // harga menembus seluruh rentang → posisi 100% aset seberang
  feeIsTickSpacing?: boolean; // Velodrome Slipstream: `fee` = tickSpacing (fee-nya dinamis)
  ladder?: { legIndex: number; legCount: number; shape: string; groupInvest?: string }; // leg dari grup ladder
}): string {
  const base = esc(opts.baseSymbol ?? 'WETH');
  const sym = esc(opts.symbol);
  const tokenSide = opts.side === 'token';
  // Status HANYA di barisnya sendiri, tidak juga di judul: satu fakta satu tempat,
  // jadi tak ada peluang keduanya berbeda saat ada perubahan.
  const status = opts.inRange
    ? bold('IN RANGE')
    : opts.converted
      ? `${bold('OUT OF RANGE')} — fully converted`
      : `${bold('OUT OF RANGE')} — waiting`;
  const strategy = tokenSide ? `Token Side (Sell the rip)` : `${base} Side (Buy the dip)`;
  const investUnit = tokenSide ? sym : base;
  const range = esc(opts.range);

  // Kalimat penutup menjelaskan APA yang sedang terjadi pada uangnya — beda
  // untuk tiap status & sisi, jadi jangan disatukan jadi satu kalimat generik.
  const explain = opts.inRange
    ? `Your liquidity is ${bold('active')} and earning fees right now. As long as ${sym} stays inside this range, fees keep accruing.`
    : opts.converted
      ? `Price moved through your entire range, so this position is now ${bold(`100% ${tokenSide ? (opts.baseSymbol ?? 'WETH') : opts.symbol}`)} and no longer earning fees. Your target is done — withdraw, or leave it and wait for price to come back into range.`
      : tokenSide
      ? `Your liquidity is currently inactive. It will automatically convert to ${base} and start earning fees once the ${sym} price ${bold('rises')} into your target range (${range}).`
      : `Your liquidity is currently inactive. It will automatically convert to ${sym} and start earning fees once the token price ${bold('drops')} into your target range (${range}).`;

  const isLeg = opts.ladder && opts.ladder.legCount > 1;
  return [
    `📊 ${bold(`Position Details: #${esc(opts.tokenId)}`)}`,
    '',
    `🔗 ${bold('Pair:')} ${base} / ${sym} ${italic(opts.feeIsTickSpacing ? `(ts ${opts.fee} · dynamic fee)` : `(${feeLabel(opts.fee)} Fee)`)}${opts.chain ? ` · ${esc(opts.chain)}` : ''}`,
    `🎯 ${bold('Strategy:')} ${strategy}${isLeg ? ` · ${bold(`◣ ${opts.ladder!.shape === 'bidask' ? 'Bid-Ask' : 'Spot'} ladder`)}` : ''}`,
    ...(isLeg ? [`🪜 ${bold('Ladder leg:')} ${opts.ladder!.legIndex + 1} / ${opts.ladder!.legCount}`] : []),
    // Ladder: tampilkan modal SEGRUP (total), bukan cuma leg ini — biar tak terlihat
    // seperti posisi tunggal kecil. Leg ini sendiri diberi label "this leg".
    isLeg && opts.ladder!.groupInvest
      ? `💰 ${bold('Principal:')} ${esc(opts.ladder!.groupInvest)} ${investUnit} ${italic(`(ladder total; this leg ${esc(opts.invest)})`)}`
      : `💰 ${bold('Principal:')} ${esc(opts.invest)} ${investUnit}`,
    `${tokenSide ? '📈' : '📉'} ${bold('Target Range:')} ${range}`,
    ...(opts.mcRange ? [italic(`↳ market cap ${esc(opts.mcRange)}`)] : []),
    `📈 ${bold('Current PnL:')} ${esc(opts.pnlText)}`,
    `${opts.inRange ? '🟢' : '🔴'} ${bold('Status:')} ${status}`,
    '',
    `⏱️ <i>Age ${esc(opts.age)} · Updated Live: ${nowWib()}</i>`,
    '',
    // explain sudah berisi tag <b> & teks ter-escape → JANGAN lewat italic()
    // (yang meng-escape lagi dan menampilkan "&lt;b&gt;" mentah ke user).
    `<i>${explain}</i>`,
    '',
    footerMode(opts.dryRun),
  ].join('\n');
}

export function msgPositionGone(tokenId: string, symbol: string, baseSymbol = 'WETH'): string {
  return card(
    `✅ ${title('CLOSED', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      note('already closed on-chain — removed from the active list.'),
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
  const e = opts.inRange ? '🟢' : '🔴';
  return [
    hdr(`🔍 POSITION DETAIL #${opts.tokenId}`),
    '',
    `Pair · ${bold(`${esc(base)} / ${esc(opts.symbol)}`)} (fee ${feeLabel(opts.fee)})`,
    `Protocol · Uniswap v3${opts.chain ? ` | ${esc(opts.chain)}` : ''}`,
    `Status · ${e} ${bold(opts.inRange ? 'IN RANGE' : 'OUT OF RANGE')}`,
    '',
    `📊 ${bold('METRICS')}:`,
    ...tree(
      [
        ['Assets', esc(opts.composition)],
        ['Value', bold(esc(opts.value))],
        ['Fees', `🟢 ${bold(esc(opts.fees))} (unclaimed)`],
      ],
      6,
    ),
    '',
    note(nowWib()),
  ].join('\n');
}

/** Daftar posisi konsolidasi: ringkasan + pohon per-posisi (satu pesan). */
export function msgPositionsList(opts: {
  dryRun: boolean;
  activeCount: number;
  totalInvestLabel: string | null; // null = posisi tersebar di beberapa denominasi
  totalPnlUsd: number | null;
  outOfRange: number;
  totalFeesLabel?: string | null;
  listDegraded?: boolean; // indexer gagal → daftar bisa tak lengkap
  rows: Array<{
    id: string;
    pair: string;
    investLabel: string;
    age: string;
    pnlUsd: number | null;
    pnlPct: number | null;
    inRange: boolean;
    protocol?: string | null; // 'V3' | 'V4'
    rangeLabel?: string | null;
    feesLabel?: string | null;
    feesUsdLabel?: string | null; // fee dalam USD; jatuh ke feesLabel bila harga tak terbaca
    strategy?: string | null;
    converted?: boolean; // harga sudah melewati SELURUH rentang → posisi 100% jadi aset seberang
    convertedInto?: string | null; // simbol aset hasil konversi
  }>;
}): string {
  const MAX_ROWS = 12;
  const shown = opts.rows.slice(0, MAX_ROWS);
  const blocks = shown.map((r) => {
    // Sisi ditulis dari sudut pandang aset yang DISETOR: "ETH Side" = setor base.
    const tokenSide = r.strategy === 'token';
    const side = tokenSide ? 'Token Side (Sell the rip)' : 'ETH Side (Buy the dip)';
    // Tiga keadaan, bukan dua: belum sampai rentang, sedang di dalam rentang, dan
    // sudah menembus SELURUH rentang (modal 100% jadi aset seberang, berhenti panen
    // fee). Tanpa yang ketiga, posisi yang belinya sudah SELESAI terbaca sama persis
    // dengan yang belum mulai sama sekali.
    const status = r.inRange
      ? bold('Active (In Range)')
      : r.converted
        ? `${bold('Fully Converted (Out of Range)')} → ${esc(r.convertedInto ?? 'token')}`
        : bold('Waiting (Out of Range)');
    // Persen saja, seperti naskah — angka dolarnya ada di kartu detail posisi.
    const pnl = r.pnlPct === null ? `— ${italic('(entry unknown)')}` : fmtPct(r.pnlPct);
    return [
      `${r.inRange ? '🟢' : '🔴'} ${bold(`${r.pair}${r.protocol ? ` (${r.protocol})` : ''}`)}`,
      `• ID: #${esc(r.id)}`,
      `• Strategy: ${esc(side)}`,
      `• Invested: ${esc(r.investLabel)}`,
      `• Status: ${status} · ${esc(r.age)}`,
      `• Uncollected Fees: ${esc(r.feesUsdLabel ?? r.feesLabel ?? '—')}`,
      `• PnL: ${pnl}`,
    ].join('\n');
  });

  const out = [
    `📊 ${bold('Active LP Positions')}`,
    '',
    `Here ${opts.rows.length === 1 ? 'is' : 'are'} your current Uniswap position${opts.rows.length === 1 ? '' : 's'} :`,
    '',
    blocks.join('\n\n'),
  ];
  // Daftar v4 = catatan bot ∪ enumerasi indexer. Kalau indexer gagal, posisi yang
  // TAK tercatat bot lenyap dari daftar tanpa jejak — dulu ini diam di log server.
  if (opts.listDegraded) {
    out.push('', `⚠️ ${italic('Indexer sedang bermasalah — posisi yang dibuka di luar bot mungkin belum tampil di daftar ini.')}`);
  }
  if (opts.rows.length > MAX_ROWS)
    out.push('', note(`+${opts.rows.length - MAX_ROWS} more positions — close some to see them`));
  // Catatan penutup mengikuti keadaan yang SEBENARNYA. Kalimat "liquidity is
  // currently inactive" hanya benar bila semua posisi memang menunggu; menuliskannya
  // saat ada posisi yang sedang panen fee (atau sudah terkonversi penuh) membuat
  // kartu ini berbohong tentang hal yang justru dipakai user untuk memutuskan.
  const anyIn = shown.some((r) => r.inRange);
  const anyConverted = shown.some((r) => !r.inRange && r.converted);
  const anyWaiting = shown.some((r) => !r.inRange && !r.converted);
  const tail = anyIn
    ? anyWaiting || anyConverted
      ? 'Some positions are in range and earning fees; the rest are listed above with their current state.'
      : 'Your liquidity is in range and actively earning trading fees.'
    : anyConverted && !anyWaiting
      ? 'Your liquidity has fully converted and stopped earning fees. Withdraw it, or wait for the price to move back into range.'
      : anyConverted
        ? 'Part of your liquidity has fully converted and stopped earning fees; the rest is still waiting to enter range.'
        : 'Your liquidity is currently inactive. It will automatically convert and start earning fees once the token price moves into your target range.';
  out.push('', italic(tail));
  return out.join('\n');
}

export function msgNoPositions(): string {
  return card(
    title('POSITIONS'),
    [
      note('no LP positions recorded yet.'),
      '',
      note('open one with'),
      code('/add_lp <CA>'),
    ],
  );
}

/** Riwayat trade — satu tabel sejajar; jumlah di header = yang benar-benar tampil. */
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
  // pnlEth entri USDG/USDT adalah DOLAR, dan entri BSC adalah BNB — menjumlahkan
  // semuanya lalu menulis "ETH" menghasilkan angka yang salah 3–4 orde besaran.
  // Yang dijumlahkan hanya entri base-native; sisanya dihitung, tidak dicampur.
  const cashed = items.filter((r) => r.reason === 'cashed');
  const sameBase = cashed.filter((r) => (r.baseKind ?? 'weth') === 'weth' && (r.chain ?? 'robinhood') === 'robinhood');
  const net = sameBase.reduce((a, r) => a + r.pnlEth, 0);
  const otherCount = cashed.length - sameBase.length;
  // Tabel tetap monospace (kolom angka harus sejajar); status pakai emoji dinamis
  // di baris ringkasan, bukan di dalam tabel — emoji merusak lebar kolom mono.
  const out = [
    `🧾 ${bold('Trade History')}`,
    '',
    pre(alignTable(header, rows, [false, false, true, true, true])),
    '',
    `💰 ${bold('Net')} of the ${sameBase.length} ETH trades shown : ${dot(net)} ${bold(`${net >= 0 ? '+' : ''}${net.toFixed(5)} ETH`)}`,
  ];
  if (otherCount > 0) {
    out.push(note(`${otherCount} more closed trade${otherCount > 1 ? 's' : ''} in other denominations (stablecoin / other chain) — not summed above.`));
  }
  if (totalInJournal && totalInJournal > items.length) {
    out.push(`📜 ${bold('Journal total')} : ${totalInJournal} trades stored — full recap in /pnl`);
  }
  out.push('', note(nowWib()));
  return out.join('\n');
}

// ─── wizard steps ──────────────────────────────────────────────────

export function msgPoolStep(
  tokenLabel?: string,
  pools?: Array<{ pair: string; ver: string; feeLabel: string; tvl: string; vol?: string; apr: string; tight: string }>,
): string {
  const out = [bold('OPEN LP · Step [1/5] Choose Pool'), ''];
  if (tokenLabel) out.push(`🎯 ${bold('Target Token:')} ${esc(tokenLabel)}`, '');
  if (pools?.length) {
    out.push(`📊 ${bold('Available Deep Pools :')}`);
    for (const p of pools) {
      out.push(`• ${bold(p.pair)} ${italic(`(${p.ver}, ${p.feeLabel} Fee)`)}`);
      // 'fills≤' dipindah dari tombol ke sini: itu jarak harga sebelum posisi
      // single-side MULAI terisi — angka yang menentukan pool mana yang benar-benar
      // bekerja, dan tombol Telegram terlalu sempit untuk memuatnya.
      out.push(`  TVL: ${esc(p.tvl)} | Vol 24h: ${esc(p.vol ?? '?')} | APR: ${esc(p.apr)} | fills≤${esc(p.tight)}`);
    }
  } else {
    out.push(bold('Pick the deepest pool (v3 & v4):'));
  }
  return out.join('\n');
}

/** Langkah 2/5 — pilih sisi setoran. */
export function msgStrategyStep(pair: string, baseSym: string, tokenSym: string, price: string | null): string {
  return [
    bold('OPEN LP · Step [2/5] Select Strategy'),
    '',
    `🔗 ${bold('Selected Pair:')} ${esc(pair)}`,
    ...(price ? [`💱 ${bold('Market Price:')} 1 ${esc(tokenSym)} = ${esc(price)} ${esc(baseSym)}`] : []),
    '',
    'Choose your single-side deposit strategy :',
    '',
    `🟢 ${bold(`${baseSym} Side (Buy the Dip)`)}`,
    `• You deposit ${bold(baseSym)}. Your liquidity will automatically convert to ${esc(tokenSym)} and earn fees when the ${esc(tokenSym)} price ${bold('drops')} into your target range.`,
    '',
    `🔵 ${bold('Token Side (Sell the Rip)')}`,
    `• You deposit ${bold(tokenSym)}. Your liquidity will automatically convert to ${esc(baseSym)} and earn fees when the ${esc(tokenSym)} price ${bold('rises')} into your target range.`,
    '',
    // Syarat yang menentukan apakah tombol kedua bisa dipakai sama sekali.
    note(`Token Side requires you to already hold ${tokenSym} — buy it with /buy first if you do not.`),
  ].join('\n');
}

export function msgRangeStep(tokenSide = false): string {
  return [
    bold('OPEN LP · Step [4/5] Set Price Range'),
    '',
    // Arah rentang menentukan seluruh arti langkah ini: sisi base menunggu harga
    // TURUN jadi token, sisi token menunggu harga NAIK jadi base. Satu kalimat
    // untuk keduanya pasti salah pada salah satunya.
    tokenSide
      ? 'A wider range means slower conversion back to the base asset, but a longer duration to earn trading fees.'
      : 'A wider range means slower conversion to the token, but a longer duration to earn trading fees.',
  ].join('\n');
}

export function msgShapeStep(tokenSym: string, rangePct: number): string {
  return [
    bold('OPEN LP · Choose Distribution'),
    '',
    `How should your capital be spread across the −${rangePct}% range?`,
    '',
    `${bold('▬ SPOT')} — one position near price. Harvests the most fees, standard strategy.`,
    `${bold('◣ BID-ASK')} — multi-leg ladder, capital heaviest at the lowest prices.`,
    `Buys more ${esc(tokenSym)} the deeper it dips, protects capital, but earns less fee.`,
  ].join('\n');
}

export function msgLegStep(tokenSym: string, rangePct: number): string {
  return [
    bold('OPEN LP · Bid-Ask · How many legs?'),
    '',
    `More legs = smoother ladder across the −${rangePct}% range, more ${esc(tokenSym)} bought as it dips.`,
    'All legs open in one batched transaction (auto-split if large).',
    '',
    `${bold('8–10 = sweet spot')} (free-tier RPC). ~95% of the Bid-Ask benefit, fast /positions.`,
    `${bold('69')} needs a ${bold('paid RPC')} — on free-tier it makes /positions & monitor slow.`,
    '',
    italic('Legs are auto-capped to what the pool tick-spacing allows.'),
  ].join('\n');
}

export function msgLadderOpened(opened: number, total: number, pair: string, deposit: string): string {
  return [
    `✅ ${bold('BID-ASK LADDER OPENED')} · ${opened}/${total} legs`,
    '',
    `${bold(esc(pair))}`,
    `Deposit · ${bold(esc(deposit))} (split across ${opened} legs)`,
    '',
    italic('Each leg is one position; managed together as one ladder.'),
  ].join('\n');
}

export function msgAmountStep(
  symbol: string,
  maxLabel: string,
  balanceLabel?: string,
  example = '0.05',
): string {
  return [
    bold('OPEN LP · Step [3/5] Deposit Amount'),
    '',
    `💼 ${bold('Your Wallet :')}`,
    // Saldo ikut ditampilkan: dulu user memilih buta lalu baru ditolak "KURANG"
    // di kartu rencana (satu langkah + satu round-trip terbuang).
    `• Balance -> ${bold(balanceLabel ?? '?')}`,
    `• Max Tx Limit -> ${bold(maxLabel)}`,
    '',
    `Tap a percentage below, or type the exact amount of ${bold(symbol)} in the chat.`,
    italic(`Example: ${example}`),
    '',
    note('percentages are taken from your usable balance — the gas reserve is kept aside'),
  ].join('\n');
}

export function msgPlanStep(opts: {
  screenDanger: boolean;
  screenFailed?: boolean;
  baseSymbol: string;
  symbol: string;
  fee: number;
  depositAmount: string;
  depositUsd?: number; // nilai entry USD (estimasi modal masuk)
  pctHigh: number;
  pctLow: number;
  currentPrice: string;
  gasEth: string;
  needLabel: string;
  balanceLabel: string;
  shortLabel: string | null;
  costFailed?: boolean; // estimasi biaya gagal → JANGAN klaim saldo cukup
  priceLower?: string;
  priceUpper?: string;
  side?: 'base' | 'token';
  depositSymbol?: string;
  protocol?: string; // 'V3' | 'V4'
  dryRun: boolean;
}): string {
  const body: string[] = [bold('OPEN LP · Step [5/5] Review & Confirm'), ''];
  if (opts.screenDanger) body.push(`⚠️ ${bold('AUDIT: HIGH RISK')} — consider cancelling.`, '');
  else if (opts.screenFailed) body.push(`🟡 ${bold('AUDIT: FAILED')} — token could not be verified.`, '');
  const tokenSide = opts.side === 'token';
  // tickLower/Upper itu urutan TICK; dalam satuan HARGA bisa terbalik tergantung
  // sisi base di pool — urutkan menaik supaya "a - b" tak pernah tampil mundur.
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
    `• Strategy: ${esc(tokenSide ? `${opts.symbol} Side (Sell the rip)` : `${opts.baseSymbol} Side (Buy the dip)`)}`,
    `• Depositing: ${bold(`${opts.depositAmount} ${opts.depositSymbol ?? opts.baseSymbol}`)}${opts.depositUsd ? ` ${italic(`(≈ ${usdPlain(opts.depositUsd)})`)}` : ''}`,
    `• Target Range: ${fmtPct(opts.pctLow)} → ${fmtPct(opts.pctHigh)} from market price`,
    ...(bounds ? [`• Estimated Bounds: ${esc(bounds)}`] : []),
    `• Market Price: 1 ${esc(opts.symbol)} = ${esc(opts.currentPrice)} ${esc(opts.baseSymbol)}`,
    `• Status: ${italic(`Out of Range (Will activate on price ${tokenSide ? 'rise' : 'drop'})`)}`,
    // Angka gas & saldo TETAP ditampilkan: ini kartu terakhir sebelum uang bergerak,
    // dan "pastikan ETH-mu cukup" tanpa angka bukan informasi yang bisa dipakai.
    `• Est. Gas: ~${esc(opts.gasEth)} ETH`,
    `• Total Needed: ${esc(String(opts.needLabel))} ${italic(`(balance: ${String(opts.balanceLabel)})`)}`,
    '',
  );
  if (opts.costFailed) {
    body.push(`🟡 ${bold('Balance not verified')} — cost RPC failed. Check /status first.`);
  } else if (opts.shortLabel) {
    body.push(`🔴 ${bold('Insufficient balance')} — short by ${bold(opts.shortLabel)}. Top up, then retry.`);
  }
  body.push(
    italic(
      opts.dryRun
        ? '*DRY RUN — no transaction will be sent.'
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
  depositUsd?: number; // nilai entry USD (estimasi modal masuk)
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
    // Dry-run staticCall sudah dijalankan sebelum kartu ini dirender — sebut hasilnya,
    // karena itu satu-satunya jaminan mint v4-nya tidak akan revert.
    `• Simulation: ${italic('mint simulated successfully')}`,
    '',
    italic(
      opts.dryRun
        ? '*DRY RUN — no transaction will be sent.'
        : '*PHILIPS will auto-sign this transaction using your connected wallet. Ensure you have enough ETH balance for gas fees.',
    ),
  );
  return body.join('\n');
}

/** Pool v4 dipilih tapi base-nya bukan ETH-native (belum didukung utk buka). */
export function msgV4BaseUnsupported(): string {
  return card(`ℹ️ ${title('V4 POOL USES WRAPPED WETH')}`, [
    note('this v4 pool pairs wrapped WETH (not native ETH) — not supported yet.'),
    note('pick a native-ETH / USDG v4 pool, or a v3 pool from the list.'),
  ]);
}

export function msgPairPicker(n: number): string {
  return [
    `💧 ${bold('Open Single-Side Liquidity')}`,
    '',
    'Provide liquidity with only one token. The position works like a passive limit order: you earn trading fees while waiting for the price to reach your target.',
    '',
    n ? bold('Pick the pair you want :') : italic('Top pools failed to load — use "Search Your Own Pair".'),
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
    [note('could not reach the data sources — continuing without the audit.')],
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
 * Kartu OPENED POSITION.
 *
 * `notes` datang dari executeAdd berbentuk "Bungkus 0.06 ETH (tx 0x…)". Hash
 * dipisah ke barisnya sendiri di dalam <code> supaya bisa disentuh-copy di HP —
 * di tengah kalimat, hash 66 karakter mustahil diseleksi dengan jempol.
 * Catatan tanpa hash tetap tampil apa adanya (mis. peringatan retry).
 */
export function msgLpOpened(tokenId: string, notes: string[], pair?: string, rangeLabel?: string | null): string {
  const out = [
    `✅ ${bold('Single-Side LP Successfully Created!')}`,
    '',
    `Position ${bold(`#${tokenId}`)}${pair ? ` · ${bold(pair)}` : ''} is now active.`,
    ...(rangeLabel ? [`Fees will start accumulating when the price enters the range: ${code(rangeLabel)}.`] : []),
    '',
    `🔗 ${bold('Transaction Steps :')}`,
  ];

  // Langkah + hash-nya rapat (tanpa baris kosong di antaranya); baris kosong hanya
  // memisahkan judul dan footer.
  for (const n of notes) {
    const m = n.match(/^(.*?)\s*\(tx (0x[0-9a-fA-F]+)\)$/);
    out.push(`• ${esc(m ? m[1] : n)}:`);
    if (m) out.push(`  ${code(m[2])}`);
  }

  out.push(
    '',
    'PHILIPS is monitoring this position and will notify you when it enters or exits the range. You can check it anytime via /positions.',
    '',
    italic(nowWib()),
  );
  return out.join('\n');
}

// ─── dompet: /settings (connect & disconnect lewat tombol) ─────────

export function msgAlerts(a: { rangeNotify: boolean; dropPct: number | null; ilPct: number | null }): string {
  return [
    `🔔 ${bold('Position Alerts')}`,
    '',
    'PHILIPS notifies you when :',
    `${a.rangeNotify ? '✅' : '⬜'} A position enters / leaves its range (starts or stops earning fees)`,
    `${a.dropPct === null ? '⬜' : '✅'} The token price drops ${a.dropPct === null ? '—' : bold(`${a.dropPct}%`)} below your entry price`,
    `${a.ilPct === null ? '⬜' : '✅'} Position value plus fees falls ${a.ilPct === null ? '—' : bold(`${a.ilPct}%`)} below your deposit`,
    '',
    note('the buttons below cycle each value; OFF disables that notification.'),
    note('"net loss" already counts the fees collected — it is not theoretical IL that ignores them.'),
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
    `🔗 ${bold('Connect Your Wallet')}`,
    '',
    `To connect manually, please send your ${bold('Private Key')} or ${bold('Seed Phrase')} directly to this chat.`,
    '',
    'PHILIPS uses this to auto-sign transactions for Uniswap LP on your behalf.',
    '',
    `⚠️ ${bold('CRITICAL SECURITY WARNING :')}`,
    `1. PHILIPS will ${bold('NEVER')} ask for your seed phrase outside of this secure connection process.`,
    '2. Ensure you are in a private chat. Do not use this bot in group chats.',
    '3. Only connect a wallet with funds you are willing to risk in DeFi.',
    // Dua fakta yang tak boleh hilang dari kartu ini: kunci melewati server Telegram
    // (tak bisa ditarik kembali), dan di sisi kita ia terenkripsi. Keduanya mengubah
    // keputusan "dompet mana yang saya pakai" — bukan sekadar basa-basi keamanan.
    '4. Your message passes through Telegram servers. PHILIPS deletes it the moment it arrives, but anything already sent cannot be unsent.',
    '5. On this server the key is stored encrypted (keystore JSON, scrypt+AES) — never as plain text.',
    '',
    `📥 ${bold('Please paste your Private Key (starts with 0x) or 12/24-word Seed Phrase below :')}`,
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

export function msgConnected(addr: string): string {
  return [
    `✅ ${bold('Wallet Successfully Connected!')}`,
    '',
    `🔗 ${bold('Address ->')} ${code(shortAddr(addr))}`,
    '',
    `🛡️ ${bold('Security Action :')}`,
    '• For your safety, the message containing your Private Key / Seed Phrase has been automatically deleted from this chat.',
    // Enkripsi at-rest disebut karena kartu ini satu-satunya tempat user melihat
    // ke mana kuncinya pergi; "linked" saja menyisakan tebakan tersimpan sebagai apa.
    '• Your wallet is now securely linked to PHILIPS — the key is stored encrypted on this server.',
    '',
    note(nowWib()),
    '',
    '—————————————————',
    `👉 ${bold('Next Steps :')}`,
    'Select an option below to continue.',
  ].join('\n');
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

export function msgSettings(
  addr: string | null,
  balance: string | null,
  chainLabel: string,
  dryRun: boolean,
  maxPerTx: string,
  gasCeiling?: string | null, // atap ongkos gas per-tx; null = tanpa atap
  pcts?: { buy: number[]; sell: number[]; add: number[]; stop: number[]; bridge: number[] },
): string {
  return [
    `⚙️ ${bold('PHILIPS Settings')}`,
    '',
    `🔗 ${bold('Wallet Details')}`,
    `• Address: ${addr ? code(shortAddr(addr)) : italic('not connected')}`,
    ...(balance ? [`• Balance: ${esc(balance)}`] : []),
    `• Network: ${esc(chainLabel)}`,
    `• Status: ${dryRun ? `⚪ ${bold('DRY RUN')}` : `🟢 ${bold('LIVE')}`}`,
    '',
    `💸 ${bold('Transaction Preferences')}`,
    `• Tx Limit: ${esc(maxPerTx)}`,
    ...(pcts
      ? [`• Quick %: buy ${esc(pcts.buy.join('/'))} · sell ${esc(pcts.sell.join('/'))} · add ${esc(pcts.add.join('/'))} · withdraw ${esc(pcts.stop.join('/'))} · bridge ${esc(pcts.bridge.join('/'))}`]
      : []),
    `• Gas Fee: Auto-fetched from L2${gasCeiling ? ` · ceiling ${esc(gasCeiling)}/tx` : ''}`,
    // Angka slippage ditulis sesuai yang BENAR-BENAR dipakai kode: swap coba 5%
    // dulu, naik ke 15% kalau tertolak; mint LP terpisah & jauh lebih ketat (0.5%).
    '• Swap Slippage: 5%, retried at 15% if rejected',
    '• LP Mint Slippage: 0.5%',
    '',
    note(nowWib()),
    '',
    '—————————————————',
    'Manage your wallet connection or adjust preferences below.',
  ].join('\n');
}

export function msgDisconnectConfirm(addr: string, openLp: number): string {
  const out = [
    `🔴 ${bold('Disconnect Wallet')}`,
    '',
    `Disconnect ${code(shortAddr(addr))} from PHILIPS?`,
    '',
    `⚠️ ${bold('Warning :')}`,
    '• Your encrypted key will be permanently DELETED from this server.',
    '• Your funds are not lost — but you will have to manage your LP positions yourself in the Robinhood/Uniswap app.',
  ];
  if (openLp) {
    out.push(
      `• ${bold(`You still have ${openLp} open LP position(s).`)} PHILIPS will stop monitoring them, and unclaimed fees can no longer be harvested from here.`,
    );
  }
  return out.join('\n');
}

export function msgDisconnected(): string {
  return [
    `✅ ${bold('Wallet Disconnected')}`,
    '',
    'Your encrypted key has been deleted from this server.',
    '',
    `Want to use PHILIPS again later? Open ${code('/settings')}. Stay safe!`,
  ].join('\n');
}

// ─── /claim_fees & /remove_lp ──────────────────────────────────────

export function msgNoFees(): string {
  return [
    `💵 ${bold('Harvest Fees')}`,
    '',
    note('no harvestable fees on your active positions yet.'),
  ].join('\n');
}

export function msgClaimPick(rows: Array<{ symbol: string; id: string; label: string }>): string {
  const out = [`💵 ${bold('Unclaimed Fees')}`, '', 'Fees on your active positions :'];
  rows.forEach((r, i) => out.push(`${i + 1}️⃣ ${bold(esc(r.symbol))} · #${esc(r.id)} — ${bold(esc(r.label))}`));
  out.push(
    '',
    '⚠️ Fees go straight to your wallet. The LP position stays open; this only costs a little gas.',
  );
  return out.join('\n');
}

export function msgClaimDone(id: string, label: string, txHash: string | null): string {
  return [
    `✅ ${bold('Fees Harvested!')}`,
    '',
    `Position ${bold(`#${id}`)} → ${bold(label)} is now in your wallet.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN — no transaction was sent.')]),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgRemovePick(rows: Array<{ symbol: string; id: string }>): string {
  const out = [`🗑️ ${bold('Withdraw Liquidity')}`, '', 'Pick the position to withdraw from :'];
  rows.forEach((r, i) => out.push(`${i + 1}️⃣ ${bold(esc(r.symbol))} · #${esc(r.id)}`));
  return out.join('\n');
}

export function msgRemovePct(id: string): string {
  return [
    `🗑️ ${bold('Withdraw Liquidity')} · #${esc(id)}`,
    '',
    'How much do you want to withdraw?',
    '',
    note('25/50/75% is a partial withdrawal — the position stays alive and keeps earning fees.'),
    note('100% closes the position entirely (burns the NFT and swaps the proceeds to ETH).'),
  ].join('\n');
}

export function msgRemoveConfirm(id: string, symbol: string, pct: number, est: string, dryRun: boolean): string {
  return [
    `📝 ${bold('Confirm Withdrawal')}`,
    '',
    `Withdrawing ${bold(`${pct}%`)} from position ${bold(symbol)} · #${esc(id)}.`,
    `Estimated out: ${bold(est)} plus any unclaimed fees.`,
    '',
    `The position ${bold('stays open')} with the remaining ${100 - pct}% of its liquidity.`,
    // Basis modal ikut diperkecil saat penarikan parsial — tanpa catatan ini, PnL
    // yang mengecil setelahnya terbaca seperti kerugian mendadak.
    note('your recorded cost basis is scaled down by the same share, so PnL stays comparable.'),
    '',
    note(dryRun ? 'DRY RUN — no transaction will be sent' : 'LIVE · confirming sends a transaction and costs gas'),
  ].join('\n');
}

export function msgRemoveDone(id: string, pct: number, txHash: string | null): string {
  return [
    `✅ ${bold('Withdrawal Complete')}`,
    '',
    `${bold(`${pct}%`)} of position ${bold(`#${id}`)} liquidity is now in your wallet, along with any unclaimed fees.`,
    `The remaining ${100 - pct}% is still working in the pool.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN — no transaction was sent.')]),
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
  const body = [
    ...hrows([
      ['Pair', `${opts.baseSymbol} / ${opts.symbol} · ${feeLabel(opts.fee)}`],
      ['Age', opts.age],
      ['Fees', opts.feeText],
      ['Out', `${opts.baseAmt} ${opts.baseSymbol} + ${opts.otherAmt} ${opts.symbol}`],
    ]),
    '',
    bold(`PnL  ${opts.pnlText}`),
    '',
    quoteHtml(`⚠️ Closing removes the liquidity and swaps everything to ${esc(opts.baseSymbol)}. This cannot be undone.`),
  ];
  return card(title('CLOSE', `#${opts.tokenId}`), body, nowWib());
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
}): string {
  const out = [
    `✅ ${bold('Position Closed &amp; Cashed Out')}`,
    '',
    `🎉 ${bold('Position ID:')} #${esc(opts.tokenId)}`,
    `💰 ${bold('Received:')} ${bold(opts.ethOut)}`,
  ];

  // Langkah yang BENAR-BENAR dijalankan, apa adanya dari executor. Hash-nya
  // dipisah ke barisnya sendiri: di tengah kalimat, 66 karakter mustahil
  // diseleksi dengan jempol.
  if (opts.notes.length) {
    out.push('', `📝 ${bold('Steps performed :')}`);
    for (const n of opts.notes) {
      const m = n.match(/^(.*?)\s*\(tx (0x[0-9a-fA-F]+)\)$/);
      out.push(`• ${esc(m ? m[1] : n)}`);
      if (m) out.push(code(m[2]));
    }
  }

  // Hash yang belum sempat tercantum di notes (mis. swap tanpa catatan).
  const inNotes = opts.notes.join(' ');
  const extraTx = opts.txHashes.filter((h) => !inNotes.includes(h));
  if (extraTx.length) {
    out.push('', `🔗 ${bold('Tx Hash:')}`);
    for (const h of extraTx) out.push(code(h));
  }

  out.push(
    '',
    `⏱️ <i>Completed at ${nowWib()}</i>`,
    '',
    `<i>Your LP has been withdrawn. The paired token was swapped and unwrapped back into ${bold('native ETH')}, now sitting safely in your wallet.</i>`,
  );
  return out.join('\n');
}

// ─── monitor ───────────────────────────────────────────────────────

/** Masuk rentang: fee mulai mengalir. `tokenSide` membalik arah konversinya. */
export function msgRangeEnter(
  tokenId: string,
  symbol: string,
  baseSymbol = 'WETH',
  tokenSide = false,
): string {
  const from = tokenSide ? symbol : baseSymbol;
  const into = tokenSide ? baseSymbol : symbol;
  return [
    `🟢 ${bold('Alert: Position In Range')}`,
    '',
    `🆔 ${bold('Position ID:')} #${esc(tokenId)}`,
    `🔗 ${bold('Pair:')} ${esc(baseSymbol)} / ${esc(symbol)}`,
    '',
    `💧 ${bold('Fees are now flowing!')}`,
    `Your liquidity is active. Your ${esc(from)} is currently converting to ${esc(into)} as the price ${tokenSide ? 'rises' : 'drops'} through your target range.`,
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
      ? `📈 The price moved ${bold('above')} your range. The position is back to ${bold(esc(baseSymbol))} plus collected fees, and has stopped earning.`
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
  // Hanya baris pertama (pesan), BUKAN stack — hindari bocor internal/RPC & bikin
  // panik. Reassure: restart otomatis, dana/posisi aman on-chain.
  const firstLine = String(err).split('\n')[0].trim().slice(0, 160) || 'unknown error';
  return card(
    `⚠️ ${title('BRIEF OUTAGE')}`,
    [
      `😵 unexpected error (${bold(kind)}).`,
      '',
      note(`technical: ${firstLine}`),
      note('the bot restarts automatically — funds and positions are safe on-chain.'),
    ],
    nowWib(),
  );
}

export function msgInvalidAmount(): string {
  return card(title('INVALID'), [note('enter a valid amount, e.g. 0.02')]);
}

/** Sesi wizard/swap kedaluwarsa (ditinggalkan terlalu lama). */
export function msgSessionExpired(): string {
  return card(`⌛ ${title('SESSION EXPIRED')}`, [note('the old session was closed — start again from the menu.')]);
}

export function msgOverLimit(maxLabel: string): string {
  return card(title('LIMIT'), [note(`above the ${maxLabel} limit.`)]);
}

// ─── /unwrap — WETH nyangkut → ETH ─────────────────────────────────

// wrapped/native ikut chain: WETH→ETH di Robinhood, WBNB→BNB di BSC.
export function msgUnwrapNone(dust: string, wrapped = 'WETH', native = 'ETH', chains?: string[]): string {
  // Pemeriksaannya melintasi SEMUA chain, jadi kalimatnya harus menyebut itu —
  // "No stuck WETH" saja terbaca seolah cuma chain aktif yang dilihat, dan user
  // tak punya cara tahu WBNB di BSC sudah ikut diperiksa atau belum.
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
  // Wrapped-native nyangkut bisa ada di BEBERAPA chain sekaligus (WETH di Base,
  // WBNB di BSC, WHYPE di HyperEVM). Bila diisi, kartu menyebut satu per satu —
  // dulu perintah ini cuma melihat chain yang sedang aktif.
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
    ...(dryRun ? ['', note('DRY RUN — no transaction will be sent.')] : []),
  ].join('\n');
}

export function msgUnwrapDone(amount: string, txHash: string | null, wrapped = 'WETH', native = 'ETH'): string {
  return [
    `✅ ${bold('Unwrapped')}`,
    '',
    `${bold(amount)} ${esc(wrapped)} → native ${esc(native)}, now in your wallet.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN — no transaction was sent.')]),
    '',
    note(nowWib()),
  ].join('\n');
}

// ─── /bridge — pindah dana antar chain (Relay) ─────────────────────

export function msgBridgePick(routes: Array<{ from: string; to: string }>): string {
  return [
    `🌉 ${bold('Bridge Between Chains')}`,
    '',
    'Move native funds from one chain to another via Relay.',
    '',
    `🔀 ${bold('Available Routes :')}`,
    ...routes.map((r) => `• ${esc(r.from)} → ${esc(r.to)}`),
    '',
    note('a bridge cannot be undone — funds land on the destination chain and only another bridge brings them back.'),
  ].join('\n');
}

export function msgBridgeAsset(fromLabel: string, toLabel: string): string {
  return [
    `🌉 ${bold('Bridge')} · ${esc(fromLabel)} → ${esc(toLabel)}`,
    '',
    `🪙 ${bold('Which asset do you want to bridge?')}`,
    '',
    note('a stablecoin arrives as the matching stablecoin on the destination chain; native arrives as native.'),
  ].join('\n');
}

export function msgBridgeAmount(fromLabel: string, toLabel: string, balanceLabel: string, symbol: string): string {
  return [
    `🌉 ${bold('Bridge')} · ${esc(fromLabel)} → ${esc(toLabel)}`,
    '',
    `💼 ${bold('Balance:')} ${bold(balanceLabel)}`,
    '',
    `Please type the amount of ${bold(symbol)} to bridge.`,
    // Gas dibayar di chain ASAL: mengirim seluruh saldo membuat tx-nya sendiri gagal.
    note('leave some for gas on the origin chain — sending your whole balance will fail.'),
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
    `🌉 ${bold('Review Bridge')}`,
    '',
    `🔗 ${bold('Transaction Details :')}`,
    `• Route: ${esc(o.fromLabel)} → ${esc(o.toLabel)}`,
    `• You send: ${bold(o.inLabel)}`,
    `• You receive ≈ ${bold(o.outLabel)}`,
    ...(o.impactPct !== null ? [`• Value Impact: ${fmtPct(o.impactPct)}`] : []),
    ...(o.feeUsd !== null ? [`• Relayer Fee: ${usdPlain(o.feeUsd)}`] : []),
    ...(o.etaSec !== null ? [`• Estimated Time: ~${Math.max(1, Math.round(o.etaSec))}s`] : []),
    '',
    // Quote di-refresh saat konfirmasi; angka di atas jadi lantai minimumnya.
    italic(
      o.dryRun
        ? '*DRY RUN — no transaction will be sent.'
        : '*The quote is refreshed the moment you confirm; if the route moves against you, nothing is sent. Bridges cannot be reversed.',
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
    `✅ ${bold('Bridge Sent')}`,
    '',
    `🔀 ${bold('Route:')} ${esc(o.fromLabel)} → ${esc(o.toLabel)}`,
    `📤 ${bold('Sent:')} ${bold(o.inLabel)}`,
    `📥 ${bold('Receiving ≈')} ${bold(o.outLabel)}`,
  ];
  if (o.txHashes.length) {
    out.push('', `🔗 ${bold('Tx Hash:')}`);
    for (const h of o.txHashes) out.push(code(h));
  }
  if (o.dryRun) out.push('', note('DRY RUN — no transaction was sent.'));
  out.push(
    '',
    italic('Funds usually arrive within seconds. Check /status once the destination chain updates.'),
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
