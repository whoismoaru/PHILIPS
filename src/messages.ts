/**
 * PHILIPS — Telegram message cards (HTML only).
 *
 * Design: monospace field sheet (<pre>)
 *  POSITION · #178449
 *
 *  pair   : WETH / TENDIES · 1.00%
 *  invest : 0.09 WETH
 *  …
 *
 *  LIVE · 22:08 UTC
 */
import { ethers } from 'ethers';

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

/**
 * One aligned monospace row: "pair   : value"
 * Plain text — dipakai di dalam <pre>.
 */
export function field(label: string, value: string, width: number): string {
  return `${label.padEnd(width)} : ${value}`;
}

/**
 * Field sheet monospace (Telegram <pre>).
 * rows = [['pair', 'WETH / TENDIES · 1.00%'], ...]
 * Masih dipakai di tempat yang butuh alignment kaku; kartu utama pakai hybrid.
 */
export function fieldBlock(
  rows: Array<[string, string]>,
  minWidth = 6,
): string {
  const clean = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (clean.length === 0) return '';
  const w = Math.max(minWidth, ...clean.map(([l]) => l.length));
  const text = clean.map(([l, v]) => field(l, String(v), w)).join('\n');
  return `<pre>${esc(text)}</pre>`;
}

/**
 * Hybrid row: label font biasa · value monospace (<code>).
 * Rapi tanpa <pre> penuh; angka tetap tajam.
 */
export function hrow(label: string, value: string | number): string {
  return `${esc(label)} · ${code(value)}`;
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

/** Compat alias used by screening.ts */
export function row(label: string, valueHtml: string, _width = 10): string {
  return kv(label, valueHtml);
}

export function section(name: string): string {
  return bold(name);
}

export function note(text: string): string {
  return italic(text);
}

export function quote(text: string): string {
  return `<blockquote>${esc(text)}</blockquote>`;
}

export function quoteHtml(innerHtml: string): string {
  return `<blockquote>${innerHtml}</blockquote>`;
}

export function pre(text: string): string {
  return `<pre>${esc(text)}</pre>`;
}

export function link(label: string, url: string): string {
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}

export function spoiler(text: string): string {
  return `<tg-spoiler>${esc(text)}</tg-spoiler>`;
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

export function cleanEth(wei: bigint): string {
  return Number(ethers.formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

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

export function pctSigned(n: number): string {
  return (n >= 0 ? '+' : '') + Number(n.toFixed(1)) + '%';
}

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

export function modeMark(dryRun: boolean): string {
  return dryRun ? '◇' : '◆';
}

/** Badge mode dgn emoji semantik (tg-ui): 🟢 LIVE · ⚪ DRY RUN. */
export function modeBadge(dryRun: boolean): string {
  return dryRun ? '⚪ DRY RUN' : '🟢 LIVE';
}

export function rangeStatus(inRange: boolean): string {
  return inRange ? 'IN RANGE' : 'OUT OF RANGE';
}

export function nowUtc(): string {
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

function footerMode(dryRun?: boolean): string {
  if (dryRun === undefined) return nowUtc();
  return `${modeLabel(dryRun)} · ${nowUtc()}`;
}

/** Parse multi-chain balance string into field rows. */
function balanceFields(gasEth: string): Array<[string, string]> {
  const raw = (gasEth || '').trim();
  if (!raw) return [['saldo', '—']];

  const parts = raw.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean);

  if (parts.length === 1 && /^\d+(\.\d+)?$/.test(parts[0])) {
    return [['saldo', `${parts[0]} ETH`]];
  }
  if (parts.length === 1) {
    return [['saldo', parts[0]]];
  }

  // "Robinhood 0.0376 ETH" → label chain, value amount
  return parts.map((p) => {
    const m = p.match(/^(\S+)\s+(.+)$/);
    return m ? ([m[1].toLowerCase(), m[2]] as [string, string]) : (['saldo', p] as [string, string]);
  });
}

// ─── cards ─────────────────────────────────────────────────────────

// Badan cockpit bersama /start & /help: baris mode + VIEW/ACTION/EMERGENCY + risiko.
function cockpitLines(dryRun: boolean): string[] {
  const cmd = (c: string, d: string) => esc(`${c.padEnd(13)}· ${d}`);
  return [
    dryRun ? '⚪ <b>DRY RUN</b>' : '🟢 <b>LIVE</b>',
    '',
    '📊 <b>VIEW</b>',
    cmd('/portfolio', 'ekuitas total'),
    cmd('/status', 'wallet & saldo'),
    cmd('/positions', 'LP aktif'),
    cmd('/history', 'jurnal trade'),
    cmd('/pnl', 'rekap PnL'),
    cmd('/explore', 'pool APR tertinggi'),
    '',
    '⚙️ <b>ACTION</b>',
    cmd('/add <CA>', 'buka LP'),
    cmd('/stop', 'tutup posisi'),
    cmd('/buy', 'beli token (rute terbaik)'),
    cmd('/sell', 'jual token (rute terbaik)'),
    cmd('/bridge', 'antar-chain → USDT @Stable'),
    cmd('/swapbase', 'tukar base ETH ⇄ USDG'),
    cmd('/size', 'preset nominal (ETH & Stablecoin)'),
    '',
    '🚨 <b>EMERGENCY</b>',
    cmd('/closeall', 'tutup SEMUA posisi'),
    '',
    '⚠️ <i>/add /stop /buy /sell /bridge /closeall menggerakkan dana on-chain</i>',
  ];
}

export function msgStart(dryRun: boolean): string {
  return [
    '🟢 <b>PHILIPS · LP COCKPIT</b>',
    'LP single-sided <b>WETH / USDG</b> di Uniswap v3',
    'Full control via Telegram.',
    '━━━━━━━━━━━━━━━━━━━━━━',
    ...cockpitLines(dryRun),
  ].join('\n');
}

/** Hasil sinkron on-chain saat /start. */
export function msgSyncResult(imported: number, gone: number): string {
  const body: string[] = [];
  if (imported) body.push(`🟢 ${bold(String(imported))} posisi on-chain diimpor ${note('(entry tak diketahui)')}`);
  if (gone) body.push(`⚪ ${bold(String(gone))} posisi ditutup di luar bot → ditandai selesai`);
  body.push('', note('buka /positions untuk kelola atau tutup.'));
  return card(`🔄 ${title('SINKRON')}`, body);
}

/** Kartu posisi Uniswap v4 (baca-saja — PHILIPS mengelola v3). */
export function msgV4Position(p: {
  tokenId: string;
  pair: string;
  feeLabel: string;
  valueLabel: string; // "$12.34" / "0.02 ETH" / "—"
  rangeLabel: string; // "+5.2% / -3.1%" / "—"
  inRange: boolean | null;
  pnlText?: string; // hanya bila dikelola bot (entry diketahui)
  tracked: boolean;
}): string {
  const emoji = p.inRange === null ? '🔷' : p.inRange ? '🟢' : '🔴';
  const body: string[] = [
    code(`${p.pair} · ${p.feeLabel}`),
    '',
    ...hrows([
      ['Nilai', p.valueLabel],
      ['Range', p.rangeLabel],
    ]),
  ];
  if (p.pnlText) body.push('', bold(`PnL  ${p.pnlText}`));
  if (p.inRange !== null) body.push('', p.inRange ? `🟢 ${bold('IN RANGE')} — fee mengalir` : `🔴 ${bold('OUT OF RANGE')}`);
  body.push('', note(p.tracked ? 'Uniswap v4 · dikelola bot' : 'Uniswap v4 · baca-saja (dibuka di luar bot)'));
  return card(`${emoji} ${title('V4', `#${p.tokenId}`)}`, body);
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
      note(`simulasi valid — saat live, dana kembali${o.base ? ` & di-cash-out ke ${o.base}` : ''}.`),
    ]);
  }
  const body: string[] = [];
  if (o.cashedOut) body.push(`💰 ${bold(`semua jadi ${o.base}`)}`);
  else if (o.leftover) body.push(`⚠️ ${bold('token receh tak dapat rute swap')} — tetap di wallet (bisa /swap manual).`);
  else body.push(`💰 ${bold('dana kembali ke wallet')}`);
  if (o.pnlText) body.push('', bold(`PnL  ${o.pnlText}`));
  if (o.txHash) body.push('', ...hrows([['tx', shortAddr(o.txHash)]]));
  return card(`✅ ${title('CLOSED v4', `#${o.tokenId}`)}`, body, nowUtc());
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
      note('simulasi valid — tidak mengirim tx.'),
    ]);
  }
  const body: string[] = [
    `🟢 ${bold('posisi v4 baru dibuka')} — monitor aktif`,
    '',
    ...hrows([
      ['Deposit', `${o.sizeEth} ETH`],
      ['Range', o.rangeLabel],
    ]),
  ];
  if (o.txHash) body.push('', ...hrows([['tx', shortAddr(o.txHash)]]));
  return card(`✅ ${title('ADDED v4', o.tokenId ? `#${o.tokenId}` : '')}`, body, nowUtc());
}

/** Konfirmasi tutup posisi Uniswap v4. */
export function msgV4CloseConfirm(tokenId: string): string {
  return card(`🔴 ${title('TUTUP v4', `#${tokenId}`)}`, [
    note('posisi Uniswap v4 di-burn; SELURUH likuiditas + fee (kedua token) kembali ke wallet — tanpa auto-swap.'),
    '',
    bold('Yakin tutup posisi ini?'),
  ]);
}

/** Konfirmasi tambah likuiditas ke posisi/pool v4 (single-sided ETH). */
export function msgV4AddConfirm(tokenId: string, sizeEth: string): string {
  return card(`➕ ${title('TAMBAH v4', `#${tokenId}`)}`, [
    ...hrows([
      ['Deposit', `${sizeEth} ETH`],
      ['Mode', 'single-sided (ETH saja)'],
    ]),
    '',
    note('mint posisi BARU di pool yang sama; range otomatis di sisi ETH.'),
    '',
    bold('Lanjut tambah?'),
  ]);
}

/** Alert monitor: posisi v4 (dikelola bot) masuk/keluar range. */
export function msgV4Range(tokenId: string, inRange: boolean): string {
  return inRange
    ? card(`🟢 ${title('V4 IN RANGE', `#${tokenId}`)}`, [`🟢 ${bold('kembali dalam rentang')} — fee mengalir lagi.`], nowUtc())
    : card(`🔴 ${title('V4 OUT OF RANGE', `#${tokenId}`)}`, [`🔴 ${bold('keluar rentang')} — posisi v4 di luar; pertimbangkan tutup.`], nowUtc());
}

/** Alias menu — sama dengan /start. */
export function msgHelp(dryRun: boolean): string {
  return [
    '🟢 <b>PHILIPS · LP COCKPIT</b>',
    'LP single-sided <b>WETH / USDG</b> · Uniswap v3',
    '━━━━━━━━━━━━━━━━━━━━━━',
    ...cockpitLines(dryRun),
  ].join('\n');
}

export function msgUnknown(txt: string): string {
  const shown = (txt || '').trim().slice(0, 40) || '…';
  return card(
    title('UNKNOWN'),
    [
      fieldBlock([['input', shown]]),
      '',
      note('ketik /help untuk daftar perintah'),
    ],
  );
}

export function msgStatus(opts: {
  dryRun: boolean;
  chainId: string | number | bigint;
  positions: number;
  limitLabel: string; // '∞' atau mis. '0.5 ETH'
  wallet: string;
  chains: Array<{ label: string; amount: string; symbol: string; usd: number | null }>;
  usdg?: { amount: string; usd: number }; // base USDG di chain utama — tampil bila > 0
  totalUsd: number | null; // null = harga ETH tak terbaca
  holdingsCount: number;
  refreshRel?: string; // 'baru saja' | '2 detik lalu' — kesegaran data
}): string {
  const modeTxt = opts.dryRun ? 'DRY RUN' : 'LIVE';
  const dot = opts.dryRun ? '⚪' : '🟢';
  const HR = '━━━━━━━━━━━━━━━━━━━━';
  const hr2 = '────────────────────';
  const usdCol = (u: number | null) => (u === null ? '≈ $?' : `≈ ${usdPlain(u)}`);

  // Tabel saldo = teks polos (bukan <pre>) — seragam dgn seluruh kartu; kolom
  // dirapikan dgn padding spasi (dipertahankan Telegram di mode HTML).
  const rows = opts.chains.map((c) => [c.label, `${c.amount} ${c.symbol}`, usdCol(c.usd)]);
  if (opts.usdg) rows.push(['USDG', `${opts.usdg.amount} USDG`, usdCol(opts.usdg.usd)]);
  const w1 = Math.max(...rows.map((r) => r[0].length));
  const w2 = Math.max(...rows.map((r) => r[1].length));
  const tableLines = rows.map((r) => esc(`${r[0].padEnd(w1)}   ${r[1].padEnd(w2)}   ${r[2]}`));

  const lines: string[] = [
    `${dot} <b>STATUS</b> · ${modeTxt}`,
    HR,
    `⚙️ Mode      <b>${esc(modeTxt)}</b>`,
    `🔗 Chain     <b>${esc(String(opts.chainId))}</b>`,
    `📂 Open      <b>${opts.positions}</b>`,
    `♾️ Limit     <b>${esc(opts.limitLabel)}</b>`,
    '',
    '💰 <b>SALDO</b>',
    ...tableLines,
    hr2,
    `💵 <b>Total ${usdCol(opts.totalUsd)}</b>`,
    '',
    opts.holdingsCount === 0
      ? '✅ Token nyangkut: <b>bersih</b>'
      : `⚠️ Token nyangkut: <b>${opts.holdingsCount}</b>`,
    `👛 <code>${esc(shortAddr(opts.wallet))}</code>`,
    '',
    `🕒 ${modeTxt} · ${nowUtc()}`,
  ];
  if (opts.refreshRel) lines.push(`🔄 Refresh ${esc(opts.refreshRel)}`);
  return lines.join('\n');
}

/** ETH bertanda ringkas: '+0.01820 ETH' / '-0.00284 ETH'. */
function sgEth(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(5)} ETH`;
}

/** Kartu rekap PnL seumur hidup (dari jurnal). Satu highlight (net) di luar pre. */
export function msgPnl(opts: {
  dryRun: boolean;
  known: number;
  excluded?: number;
  wins: number;
  losses: number;
  netEth: number;
  grossWin: number;
  grossLoss: number;
  best?: { symbol: string; pnlEth: number };
  worst?: { symbol: string; pnlEth: number };
}): string {
  if (opts.known === 0) {
    return card(`🧾 ${title('PnL', 'seumur hidup')}`, [note('belum ada trade tertutup.')], footerMode(opts.dryRun));
  }
  const winrate = (opts.wins / opts.known) * 100;
  const rows: Array<[string, string]> = [
    ['trade', `${opts.known} (${opts.wins}W · ${opts.losses}L)`],
    ['winrate', `${winrate.toFixed(1)}%`],
    ['menang', sgEth(opts.grossWin)],
    ['kalah', sgEth(opts.grossLoss)],
  ];
  if (opts.best) rows.push(['terbaik', `${opts.best.symbol} ${sgEth(opts.best.pnlEth)}`]);
  if (opts.worst) rows.push(['terburuk', `${opts.worst.symbol} ${sgEth(opts.worst.pnlEth)}`]);

  const body = [
    `${opts.netEth >= 0 ? '🟢' : '🔴'} net ${bold(sgEth(opts.netEth))}`,
    '',
    ...hrows(rows),
  ];
  if (opts.excluded && opts.excluded > 0) {
    body.push('', note(`${opts.excluded} trade lama tanpa data hasil diabaikan.`));
  }
  return card(`🧾 ${title('PnL', 'cashout nyata')}`, body, footerMode(opts.dryRun));
}

/** Pandangan portofolio tunggal: ekuitas total (wallet + posisi) + realized PnL. */
export function msgPortfolio(o: {
  totalUsd: number;
  walletUsd: number;
  posUsd: number;
  ethLabel: string;
  usdgLabel: string;
  openV3: number;
  openV4: number;
  realizedNetEth: number;
  realizedNetUsd: number | null;
  dryRun: boolean;
}): string {
  const body = [
    `💰 ${bold(`ekuitas ${usdPlain(o.totalUsd)}`)}`,
    '',
    ...hrows([
      ['Wallet', `${usdPlain(o.walletUsd)}  (${o.ethLabel} ETH · ${o.usdgLabel} USDG)`],
      ['Posisi LP', `${usdPlain(o.posUsd)}  (${o.openV3} v3 · ${o.openV4} v4)`],
    ]),
    '',
    section('realized · seumur hidup'),
    ...hrows([
      ['PnL', o.realizedNetUsd !== null ? `${usdSigned(o.realizedNetUsd)}  (${sgEth(o.realizedNetEth)})` : sgEth(o.realizedNetEth)],
    ]),
  ];
  return card(`📊 ${title('PORTFOLIO')}`, body, footerMode(o.dryRun));
}

/** Alert harga token anjlok ≥ambang dari harga entry (auto-monitor). */
export function msgPriceDrop(tokenId: string, symbol: string, dropPct: number, baseSymbol = 'WETH'): string {
  return card(`⚠️ ${title('ANJLOK', esc(symbol))}`, [
    `🔴 turun ${bold(pctSigned(-dropPct))} dari entry`,
    '',
    fieldBlock([
      ['token', symbol],
      ['pair', `${baseSymbol} / ${symbol}`],
      ['posisi', `#${tokenId}`],
    ]),
    quote('harga token jatuh sejak buka — cek apakah perlu /stop.'),
  ]);
}

/** Header /closeall — bingkai darurat, tetap konfirmasi per posisi (mekanisme = /stop). */
export function msgCloseAllPick(countV3: number, countV4 = 0): string {
  const total = countV3 + countV4;
  return card(`⛔ ${title('TUTUP SEMUA')}`, [
    `${bold(String(total))} posisi aktif${countV4 ? ` (${countV3} v3 · ${countV4} v4)` : ''} — tap ${bold('Tutup')} di tiap kartu.`,
    note('tiap penutupan tetap lewat konfirmasi masing-masing.'),
  ]);
}

// ─── /buy /sell token (base↔token, rute terbaik) ───────────────────────
export function msgTSwapChain(buy: boolean, dryRun: boolean): string {
  const t = buy ? '🟢 BELI TOKEN' : '🔴 JUAL TOKEN';
  return card(`🔄 ${title(t)}`, [note('pilih chain di bawah.')], footerMode(dryRun));
}
export function msgBuyAskCA(dryRun: boolean): string {
  return card(`🟢 ${title('BELI TOKEN')}`, [
    note('chain terdeteksi otomatis dari CA.'),
    `💬 Tempel ${bold('alamat kontrak (CA)')} token (0x…).`,
  ], footerMode(dryRun));
}
export function msgBuySafetyHint(sym: string): string {
  return note(`Cek detail & keamanan ${bold(sym)} di atas. Lanjut untuk pilih aset & size.`);
}
export function msgSellList(n: number): string {
  return card(`🔴 ${title('JUAL TOKEN')}`, [note(`${n} token dipegang — pilih yang mau dijual.`)]);
}
export function msgSellNoHoldings(): string {
  return card(`🔴 ${title('JUAL TOKEN')}`, [note('tak ada token dgn saldo di wallet (selain base).')]);
}
export function msgSellAmount(sym: string, balLabel: string): string {
  return card(`🔴 ${title('JUAL', sym)}`, [
    note(`saldo: ${bold(balLabel)}`),
    'Pilih porsi yang dijual (base terima dipilih otomatis, rute terbaik).',
  ]);
}
export function msgSellTypeAmount(sym: string): string {
  return card(`🔴 ${title('JUAL', sym)}`, [`💬 Ketik jumlah ${bold(sym)} untuk dijual (atau ${code('semua')}).`]);
}
export function msgTSwapBase(chainLabel: string, buy: boolean): string {
  const q = buy ? 'bayar pakai base apa?' : 'terima base apa?';
  return card(`🔄 ${title('SWAP TOKEN', chainLabel)}`, [note(q)]);
}
export function msgTSwapTokenPrompt(buy: boolean, baseSym: string): string {
  const arah = buy ? `beli token pakai ${bold(baseSym)}` : `jual token → ${bold(baseSym)}`;
  return card(`🔄 ${title('SWAP TOKEN')}`, [
    note(arah),
    `💬 Tempel ${bold('alamat kontrak token')} (0x…).`,
  ]);
}
export function msgTSwapAmountPrompt(buy: boolean, sym: string, balanceLine: string): string {
  const what = buy ? `jumlah ${bold(sym)} untuk dibelanjakan` : `jumlah ${bold(sym)} untuk dijual`;
  return card(`🔄 ${title('SWAP TOKEN')}`, [
    balanceLine,
    `💬 Ketik ${what}${buy ? '' : ` (atau ${code('semua')})`}.`,
  ]);
}
export function msgTSwapConfirm(o: {
  buy: boolean;
  chainLabel: string;
  tokenSym: string;
  amountInLabel: string;
  estOutLabel: string;
  route: string;
  dryRun: boolean;
}): string {
  const body = [
    `🟢 ≈ dapat ${bold(o.estOutLabel)}`,
    '',
    ...hrows([
      [o.buy ? 'Beli' : 'Jual', `${o.tokenSym} @ ${o.chainLabel}`],
      ['Bayar', o.amountInLabel],
      ['Rute terbaik', o.route],
      ['Toleransi harga', 'maks 5% (naik 15% bila gagal)'],
    ]),
    '',
    note('estimasi; jumlah pasti dilindungi quoter saat eksekusi.'),
  ];
  return card(`🔄 ${title('KONFIRMASI SWAP', o.tokenSym)}`, body, footerMode(o.dryRun));
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
    return card(`⚪ ${title('SWAP (DRY)', o.tokenSym)}`, [
      note('mode DRY RUN — tidak dieksekusi.'),
      '',
      ...hrows([['Bayar', o.amountInLabel], ['≈ dapat', o.outLabel]]),
    ], footerMode(o.dryRun));
  }
  return card(`✅ ${title('SWAP SELESAI', o.tokenSym)}`, [
    `🟢 +${o.outLabel}`,
    '',
    ...hrows([
      ['Bayar', o.amountInLabel],
      ['Diterima', o.outLabel],
      ['Rute', o.route ?? '—'],
    ]),
  ], footerMode(o.dryRun));
}

// ─── /fund — bridge cross-chain ke USDT @Stable via Relay ──────────────
export function msgFundNoStable(): string {
  return card(`🌉 ${title('FUND STABLE')}`, [
    note('StableChain belum aktif — set RPC_URL_STABLE di .env & restart dulu.'),
  ]);
}

export function msgFundStart(): string {
  return card(`🌉 ${title('BRIDGE', 'Robinhood ⇄ Stable')}`, [
    'Pindah dana lintas-chain via Relay.',
    '',
    note('pilih arah:'),
  ]);
}

export function msgFundAssetPick(dir: 'topup' | 'withdraw'): string {
  return dir === 'topup'
    ? card(`🌉 ${title('ISI STABLE', 'Robinhood → USDT')}`, [note('pilih sumber dana di Robinhood:')])
    : card(`🌉 ${title('TARIK DARI STABLE', 'USDT → Robinhood')}`, [note('pilih aset tujuan di Robinhood:')]);
}

export function msgFundAmountPrompt(symbol: string, balanceLabel: string): string {
  return card(`🌉 ${title('BRIDGE', symbol)}`, [
    balanceLabel,
    `💬 Ketik jumlah ${bold(symbol)} yang mau di-bridge (contoh: ${code(symbol === 'ETH' ? '0.02' : '10')})`,
  ]);
}

export function msgFundConfirm(q: {
  provider: 'relay' | 'lifi';
  inLabel: string;
  outLabel: string;
  inUsd: string | null;
  outUsd: string | null;
  feeUsd: string | null;
  impactPct: string | null;
  etaSec: number | null;
}, dryRun: boolean): string {
  const eta =
    q.etaSec == null ? '—' : q.etaSec < 60 ? `~${Math.max(1, Math.round(q.etaSec))} detik` : `~${Math.round(q.etaSec / 60)} menit`;
  // Estimasi PnL transfer = nilai diterima − nilai dikirim (rugi ke biaya+impact).
  const net = q.inUsd != null && q.outUsd != null ? Number(q.outUsd) - Number(q.inUsd) : null;
  const netLabel = net != null ? `${usdSigned(net)}${q.inUsd && Number(q.inUsd) > 0 ? ` (${pctSigned((net / Number(q.inUsd)) * 100)})` : ''}` : '—';
  const body = [
    `🟢 ≈ terima ${bold(q.outLabel)}${q.outUsd ? ` (${'$' + q.outUsd})` : ''}`,
    '',
    ...hrows([
      ['Kirim', q.inLabel],
      ['≈ Terima', q.outLabel],
      ['Biaya', q.feeUsd ? `$${q.feeUsd}` : '—'],
      ['Impact', q.impactPct ? `${q.impactPct}%` : '—'],
      ['Est. PnL', netLabel],
      ['Estimasi', eta],
    ]),
    '',
    note(`via ${q.provider === 'lifi' ? 'LiFi' : 'Relay'} · dana tiba di wallet yang sama di chain tujuan.`),
  ];
  return card(`🌉 ${title('KONFIRMASI BRIDGE')}`, body, footerMode(dryRun));
}

export function msgFundDone(txHashes: string[], outLabel: string, dryRun: boolean): string {
  if (dryRun) {
    return card(`⚪ ${title('BRIDGE (DRY)')}`, [note('mode DRY RUN — tidak dieksekusi.'), '', hrow('≈ terima', outLabel)]);
  }
  return card(`✅ ${title('BRIDGE TERKIRIM')}`, [
    `🟢 ≈ ${bold(outLabel)} sedang menuju chain tujuan`,
    '',
    hrow('Tx', String(txHashes.length)),
    '',
    note('cek /status beberapa detik lagi — saldo di chain tujuan akan muncul.'),
  ], footerMode(dryRun));
}

/** Prompt saat tombol menu "Tambah LP" ditekan (butuh argumen CA). */
export function msgAddPrompt(): string {
  return card(`➕ ${title('TAMBAH LP')}`, [
    `Tempel alamat token: ${code('/add <CA>')}`,
    note('contoh: /add 0xabc…'),
  ]);
}

export function msgError(where: string, err: string): string {
  return card(
    `❌ ${title('ERROR', where)}`,
    [pre(err.slice(0, 400)), '', note('coba ulangi — bila berulang, cek log service.')],
    nowUtc(),
  );
}

export function msgInfo(titleText: string, lines: string[]): string {
  return card(title(titleText), lines.map((l) => esc(l)));
}

export function msgProgress(text: string): string {
  return italic(`… ${text}`);
}

export function msgCancelled(): string {
  return card(title('CANCELLED'), [note('aksi dibatalkan.')]);
}

export function msgChainPick(): string {
  return card(
    title('CHAIN'),
    [note('token ditemukan di beberapa chain — pilih di bawah.')],
  );
}

export function msgChainChosen(label: string): string {
  return card(
    title('CHAIN'),
    [fieldBlock([['selected', label]])],
  );
}

export function msgSizeList(assetLabel: string, unit: string, sizes: number[]): string {
  const list = sizes.length ? sizes.map((s) => (unit === 'ETH' ? `${s} ETH` : `$${s}`)).join(' · ') : '—';
  return card(title('PRESET', assetLabel), [
    kv('sekarang', bold(list)),
    '',
    note('tombol cepat di langkah nominal /add & /buy.'),
    fieldBlock([
      ['ganti ETH', '/size 0.01 0.05 0.1'],
      ['ganti $', '/size $ 10 50 100'],
    ]),
  ]);
}

export function msgPositionCard(opts: {
  tokenId: string;
  symbol: string;
  fee: number;
  invest: string;
  pnlText: string;
  range: string;
  inRange: boolean;
  age: string;
  dryRun: boolean;
  chain?: string;
  baseSymbol?: string; // WETH (default, posisi lama) | USDG
}): string {
  const base = opts.baseSymbol ?? 'WETH';
  const statusEmoji = opts.inRange ? '🟢' : '🔴';
  const statusLine = opts.inRange
    ? `${statusEmoji} ${bold('IN RANGE')} — fee mengalir`
    : `${statusEmoji} ${bold('OUT OF RANGE')}`;
  const body = [
    code(`${base} / ${opts.symbol} · ${feeLabel(opts.fee)}`),
    ...(opts.chain ? [code(opts.chain)] : []),
    '',
    ...hrows([
      ['Invest', `${opts.invest} ${base}`],
      ['Range', opts.range],
      ['Umur', opts.age],
    ]),
    '',
    bold(`PnL  ${opts.pnlText}`),
    statusLine,
  ];
  return card(
    `${statusEmoji} ${title('POSITION', `#${opts.tokenId}`)}`,
    body,
    footerMode(opts.dryRun),
  );
}

export function msgPositionGone(tokenId: string, symbol: string, baseSymbol = 'WETH'): string {
  return card(
    `✅ ${title('CLOSED', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      note('sudah tertutup on-chain — dibersihkan dari daftar aktif.'),
    ],
    nowUtc(),
  );
}

export function msgPositionReadFail(tokenId: string, err: string): string {
  return card(
    title('READ FAIL', `#${tokenId}`),
    [esc(err)],
    nowUtc(),
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
  const body = [
    code(`${base} / ${opts.symbol} · ${feeLabel(opts.fee)}`),
    ...(opts.chain ? [code(opts.chain)] : []),
    '',
    ...hrows([
      ['Assets', opts.composition],
      ['Value', opts.value],
      ['Fees', opts.fees],
    ]),
    '',
    `${e} ${bold(opts.inRange ? 'IN RANGE' : 'OUT OF RANGE')}`,
  ];
  return card(`${e} ${title('DETAIL', `#${opts.tokenId}`)}`, body, nowUtc());
}

export function msgPositionsHeader(activeCount: number): string {
  return card(
    title('POSITIONS'),
    [fieldBlock([['active', String(activeCount)]])],
  );
}

/** Daftar posisi konsolidasi: ringkasan + pohon per-posisi (satu pesan). */
export function msgPositionsList(opts: {
  dryRun: boolean;
  activeCount: number;
  totalInvestLabel: string;
  totalPnlUsd: number | null;
  outOfRange: number;
  rows: Array<{
    id: string;
    pair: string;
    investLabel: string;
    age: string;
    pnlUsd: number | null;
    pnlPct: number | null;
    inRange: boolean;
  }>;
}): string {
  const dot = opts.dryRun ? '⚪' : '🟢';
  const HR = '━━━━━━━━━━━━━━━━━━━━━━';
  const dollar = (n: number) => `$${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
  const lines: string[] = [
    `${dot} <b>POSITIONS</b> · Active ${opts.activeCount}`,
    HR,
    `💵 Total Invest   ${esc(opts.totalInvestLabel)}`,
    `📊 Total PnL     <b>${opts.totalPnlUsd === null ? '—' : dollar(opts.totalPnlUsd)}</b>`,
    `🔴 Out of Range   ${opts.outOfRange} dari ${opts.activeCount}`,
    '',
  ];
  const last = opts.rows.length - 1;
  opts.rows.forEach((r, i) => {
    const prefix = i === 0 ? '┌' : i === last ? '└' : '├';
    const status = r.inRange ? '🟢 In Range' : '🔴 Out';
    lines.push(`${prefix} <b>#${esc(r.id)}</b>  ${esc(r.pair)}`);
    lines.push(`│ ${esc(r.investLabel)} · ${esc(r.age)}`);
    if (r.pnlUsd === null || r.pnlPct === null) {
      lines.push(`│ PnL <b>—</b>  ${status}`);
    } else {
      lines.push(`│ PnL <b>${dollar(r.pnlUsd)}</b> (${fmtPct(r.pnlPct)})  ${status}`);
    }
    if (i < last) lines.push('│');
  });
  return lines.join('\n');
}

export function msgNoPositions(): string {
  return card(
    title('POSITIONS'),
    [
      note('belum ada posisi LP tercatat.'),
      '',
      note('buka dengan'),
      code('/add <CA>'),
    ],
  );
}

/** Riwayat trade — hybrid, max 10 entry, multi-baris per trade. */
export function msgJournal(
  items: Array<{
    tokenId: string;
    symbol: string;
    pnlPct: number;
    pnlEth: number;
    reason: 'cashed' | 'gone' | 'burned';
    ca?: string;
    chain?: string;
    closedAt?: number;
  }>,
): string {
  if (items.length === 0) {
    return card(title('JOURNAL'), [note('belum ada trade tertutup.')]);
  }

  const shown = items.slice(0, 10);
  const body: string[] = [];
  for (const r of shown) {
    if (body.length) body.push('');
    body.push(`${bold(`#${r.tokenId}`)}  ${esc(r.symbol)}`);
    if (r.reason === 'cashed') {
      const eth = (r.pnlEth >= 0 ? '+' : '') + r.pnlEth.toFixed(5);
      body.push(`${code(eth + ' ETH')}  ·  ${code(pctSigned(r.pnlPct))}`);
    } else if (r.reason === 'gone') {
      body.push(note('NFT hilang on-chain'));
    } else {
      body.push(note(r.reason));
    }
    const meta: string[] = [];
    if (r.chain) meta.push(r.chain);
    if (r.ca) meta.push(shortAddr(r.ca));
    if (r.closedAt) meta.push(fmtAge(Date.now() - r.closedAt) + ' ago');
    if (meta.length) body.push(italic(meta.join(' · ')));
  }
  if (items.length > 10) {
    body.push('', note(`+${items.length - 10} trade lain di jurnal.`));
  }

  return card(
    `🧾 ${title('JOURNAL', `${items.length} trade`)}`,
    body,
    nowUtc(),
  );
}

// ─── wizard steps ──────────────────────────────────────────────────

export function msgPoolStep(): string {
  return card(
    title('ADD LP', '1/4'),
    [
      section('pilih pool'),
      note('v3 & v4 dari Uniswap · pair · fee · TVL — terdalam di atas'),
    ],
  );
}

export function msgRangeStep(fee: number): string {
  return card(
    title('ADD LP', '2/4'),
    [
      fieldBlock([['pool', `${feeLabel(fee)} ✓`]]),
      '',
      section('lebar rentang'),
      note('seberapa jauh harga turun sampai ETH penuh jadi token'),
    ],
  );
}

export function msgAmountStep(symbol: string, maxLabel: string): string {
  return card(
    title('ADD LP', '3/4'),
    [
      section(`nominal ${symbol}`),
      fieldBlock([['maks', maxLabel]]),
    ],
  );
}

export function msgAmountCustom(symbol: string, maxLabel: string, example: string): string {
  return card(
    title('ADD LP', 'nominal'),
    [
      note(`ketik jumlah ${symbol} (maks ${maxLabel})`),
      `contoh · ${code(example)}`,
    ],
  );
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
  dryRun: boolean;
}): string {
  const body: string[] = [];
  if (opts.screenDanger) {
    body.push(
      quoteHtml(`${bold('SCREEN · BAHAYA')} — token berisiko. Lanjut hanya jika yakin.`),
      '',
    );
  } else if (opts.screenFailed) {
    body.push(
      quoteHtml(`${bold('SCREEN · GAGAL')} — token TIDAK terverifikasi keamanannya. Lanjut dgn risiko sendiri.`),
      '',
    );
  }
  body.push(
    ...hrows([
      ['Pair', `${opts.baseSymbol} / ${opts.symbol} · ${feeLabel(opts.fee)}`],
      ['Deposit', `${opts.depositAmount} ${opts.baseSymbol}${opts.depositUsd != null ? ` ≈ $${opts.depositUsd.toFixed(2)}` : ''}`],
      ['Range', `${fmtPct(opts.pctHigh)} → ${fmtPct(opts.pctLow)}`],
      ['Price', `1 ${opts.symbol} = ${opts.currentPrice} ${opts.baseSymbol}`],
    ]),
    '',
    section('biaya'),
    ...hrows([
      ['Gas', `~${opts.gasEth} ETH`],
      ['Perlu', opts.needLabel],
      ['Saldo', opts.balanceLabel],
    ]),
  );
  if (opts.costFailed) {
    body.push('', `🟡 ${bold('saldo belum terverifikasi')} — RPC biaya gagal. Cek /status dulu.`);
  } else if (opts.shortLabel) {
    body.push(
      '',
      quoteHtml(`🔴 ${bold('KURANG')} ${esc(opts.shortLabel)} — top up dulu.`),
    );
  } else {
    body.push('', `🟢 ${bold('saldo cukup')} — siap eksekusi`);
  }
  body.push('', note('est. PnL = fee terkumpul − impermanent loss; dipantau live di /positions.'));
  if (opts.dryRun) {
    body.push('', note('⚪ simulasi — tidak mengirim tx on-chain'));
  } else {
    body.push('', note('konfirmasi = kirim tx + monitor aktif'));
  }
  return card(title('PREVIEW', '4/4'), body, footerMode(opts.dryRun));
}

/** Preview buka posisi v4 single-sided ETH (validasi via dry-run staticCall). */
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
  const body: string[] = [];
  if (opts.screenDanger) {
    body.push(quoteHtml(`${bold('SCREEN · BAHAYA')} — token berisiko. Lanjut hanya jika yakin.`), '');
  } else if (opts.screenFailed) {
    body.push(quoteHtml(`${bold('SCREEN · GAGAL')} — token TIDAK terverifikasi. Lanjut dgn risiko sendiri.`), '');
  }
  body.push(
    ...hrows([
      ['Pair', `${opts.symbol} / ${opts.baseSymbol} · ${feeLabel(opts.fee)}`],
      ['Protokol', `Uniswap v4 · TVL ${usdCompact(opts.tvlUsd)}`],
      ['Deposit', `${opts.depositAmount} ${opts.baseSymbol}${opts.depositUsd != null ? ` ≈ $${opts.depositUsd.toFixed(2)}` : ''}`],
      ['Range', `${fmtPct(opts.rangePctHigh)} → ${fmtPct(opts.rangePctLow)}`],
    ]),
    '',
    note('single-sided ETH — LP ditaruh di sisi ETH; fee mengalir saat harga bergerak masuk rentang.'),
  );
  body.push('', note('est. PnL = fee terkumpul − impermanent loss; dipantau live di /positions.'));
  if (opts.dryRun) {
    body.push('', note('⚪ simulasi — tidak mengirim tx on-chain'));
  } else {
    body.push('', `🟢 ${bold('tersimulasi OK')} — siap eksekusi`, note('konfirmasi = kirim tx + monitor aktif'));
  }
  return card(title('PREVIEW v4', '4/4'), body, footerMode(opts.dryRun));
}

/** Pool v4 dipilih tapi base-nya bukan ETH-native (belum didukung utk buka). */
export function msgV4BaseUnsupported(): string {
  return card(`ℹ️ ${title('POOL v4 WETH-BUNGKUS')}`, [
    note('pool v4 ini pakai WETH terbungkus (bukan ETH-native) — belum didukung.'),
    note('pilih pool base ETH-native / USDG (v4) atau pool v3 dari daftar.'),
  ]);
}

export function msgAddlpUsage(): string {
  return card(
    title('USAGE'),
    [
      code('/add <CA>'),
      '',
      note('contoh (EVM address 0x…)'),
      code('/add 0x020bfc65…1018b4'),
    ],
  );
}

export function msgInvalidAddress(): string {
  return card(
    title('INVALID'),
    [
      note('alamat token tidak valid.'),
      note('pakai contract address EVM (0x…), bukan mint Solana.'),
    ],
  );
}

export function msgNoPools(): string {
  return card(
    `⚪ ${title('NO POOLS')}`,
    [note('tidak ada pool WETH/USDG berlikuiditas untuk token ini.')],
  );
}

export function msgScreeningFailed(): string {
  return card(
    title('SCREENING'),
    [note('gagal menjangkau sumber data — lanjut tanpa screening.')],
  );
}

export function msgDryRunAddDone(): string {
  return card(
    title('DRY RUN DONE'),
    [
      note('tidak ada transaksi dikirim.'),
      note('Set DRY_RUN=false di .env untuk eksekusi nyata.'),
    ],
  );
}

export function msgOpeningLp(): string {
  return msgProgress('membuka LP…');
}

export function msgLpOpened(tokenId: string, notes: string[]): string {
  const body = [
    fieldBlock([['position', `#${tokenId}`]]),
    '',
    `🟢 ${bold('monitor aktif')} — notifikasi in/out range otomatis`,
  ];
  if (notes.length) {
    body.push('', section('notes'));
    for (const n of notes) body.push(`  ${esc(n)}`);
  }
  return card(`✅ ${title('OPENED', `#${tokenId}`)}`, body, nowUtc());
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
    quoteHtml(`⚠️ Menutup = remove + swap semua ke ${esc(opts.baseSymbol)}. Tak bisa dibatalkan.`),
  ];
  return card(title('CLOSE', `#${opts.tokenId}`), body, nowUtc());
}

export function msgStopPick(): string {
  return card(
    title('STOP LP'),
    [note('pilih posisi — tap Tutup pada kartu.'), note('posisi v4 ditutup dari /positions atau /closeall.')],
  );
}

export function msgNoActiveToStop(): string {
  return card(
    title('STOP LP'),
    [note('tidak ada posisi aktif.')],
  );
}

export function msgDryRunClose(tokenId: string): string {
  return card(
    title('DRY RUN'),
    [note(`posisi #${tokenId} tidak ditutup (simulasi).`)],
  );
}

export function msgClosing(baseSymbol = 'ETH'): string {
  return msgProgress(`menutup posisi & cash-out ke ${baseSymbol}…`);
}

export function msgAlreadyClosed(tokenId: string): string {
  return card(
    title('ALREADY CLOSED', `#${tokenId}`),
    [note('ditandai STOPPED & dibersihkan.')],
    nowUtc(),
  );
}

export function msgCashOut(opts: {
  tokenId: string;
  notes: string[];
  ethOut: string;
  txHashes: string[];
}): string {
  const rows: Array<[string, string]> = [['position', `#${opts.tokenId}`]];
  for (let i = 0; i < opts.txHashes.length; i++) {
    rows.push([i === 0 ? 'tx' : '', shortAddr(opts.txHashes[i])]);
  }
  const body: string[] = [
    fieldBlock(rows.filter(([l, v]) => l || v)),
    '',
    `💰 ${bold(`diterima  ${opts.ethOut}`)}`,
  ];
  if (opts.notes.length) {
    body.push('', section('notes'));
    for (const n of opts.notes) body.push(`  ${esc(n)}`);
  }
  return card(`✅ ${title('CASHED OUT', `#${opts.tokenId}`)}`, body, nowUtc());
}

// ─── monitor ───────────────────────────────────────────────────────

export function msgRangeEnter(tokenId: string, symbol: string, baseSymbol = 'WETH'): string {
  return card(
    `🟢 ${title('IN RANGE', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      `🟢 ${bold('fee mulai mengalir')} — ${esc(baseSymbol)} konversi ke ${esc(symbol)}.`,
    ],
    nowUtc(),
  );
}

export function msgRangeExit(
  tokenId: string,
  symbol: string,
  side: 'above' | 'below',
  baseSymbol = 'WETH',
): string {
  if (side === 'above') {
    return card(
      `🟢 ${title('OUT ↑', `#${tokenId}`)}`,
      [
        fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
        `🟢 ${bold('AMAN')} — harga naik keluar rentang; posisi kembali 100% ${esc(baseSymbol)} + fee.`,
      ],
      nowUtc(),
    );
  }
  return card(
    `🔴 ${title('OUT ↓', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      `🔴 ${bold('RISIKO')} — ${esc(baseSymbol)} sudah 100% jadi ${esc(symbol)}.`,
      note(`pulih hanya bila harga naik lagi. Pertimbangkan /stop.`),
    ],
    nowUtc(),
  );
}

export function msgCrash(kind: string, err: string): string {
  // Hanya baris pertama (pesan), BUKAN stack — hindari bocor internal/RPC & bikin
  // panik. Reassure: restart otomatis, dana/posisi aman on-chain.
  const firstLine = String(err).split('\n')[0].trim().slice(0, 160) || 'error tak dikenal';
  return card(
    `⚠️ ${title('GANGGUAN SEBENTAR')}`,
    [
      `😵 error tak terduga (${bold(kind)}).`,
      '',
      note(`teknis: ${firstLine}`),
      note('bot restart otomatis — dana & posisi aman on-chain.'),
    ],
    nowUtc(),
  );
}

export function msgInvalidAmount(): string {
  return card(title('INVALID'), [note('masukkan angka ETH valid, mis. 0.02')]);
}

/** Sesi wizard/swap kedaluwarsa (ditinggalkan terlalu lama). */
export function msgSessionExpired(): string {
  return card(`⌛ ${title('SESI HABIS')}`, [note('sesi lama ditutup — mulai lagi dari menu bila mau lanjut.')]);
}

export function msgOverLimit(maxLabel: string): string {
  return card(title('LIMIT'), [note(`melebihi batas ${maxLabel}.`)]);
}
