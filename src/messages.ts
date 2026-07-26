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

export function section(name: string): string {
  return bold(name);
}

export function note(text: string): string {
  return italic(text);
}

export function quoteHtml(innerHtml: string): string {
  return `<blockquote>${innerHtml}</blockquote>`;
}

/**
 * Tabel monospace rata kolom (dipakai di dalam <pre>). right[i] = rata kanan (angka).
 * padEnd di luar <pre> TIDAK pernah sejajar: font Telegram proporsional.
 */
/** Blok 'label : value' sejajar untuk di dalam <pre>. */
export function sheet(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)} : ${v}`).join('\n');
}

export function alignTable(header: string[], rows: string[][], right: boolean[]): string {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (right[i] ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

export function pre(text: string): string {
  return `<pre>${esc(text)}</pre>`;
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
    cmd('/size', 'preset nominal (ETH & Stablecoin)'),
    '',
    '⛔ <b>EMERGENCY</b>',
    cmd('/closeall', 'tutup SEMUA posisi'),
    '',
    '⚠️ <i>/add /stop /buy /sell /bridge /closeall menggerakkan dana on-chain</i>',
  ];
}

/** Kartu daftar perintah (/help). */
export function msgHelp(dryRun: boolean): string {
  return [
    '🟢 <b>PHILIPS · LP COCKPIT</b>',
    'LP single-sided <b>WETH / USDG</b> di Uniswap v3',
    'Full control via Telegram.',
    '━━━━━━━━━━━━━━━━━━━━━━',
    ...cockpitLines(dryRun),
  ].join('\n');
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
}): string {
  const rows: Array<[string, string]> = [
    ['mode', o.dryRun ? 'DRY RUN (simulasi)' : 'LIVE (kirim tx)'],
    ['chain', `${o.chainLabel} · ${o.chainId}`],
    ['posisi', `${o.positions} aktif`],
  ];
  if (o.imported || o.gone) {
    rows.push(['sinkron', [o.imported ? `+${o.imported} diimpor` : '', o.gone ? `${o.gone} selesai di luar bot` : '']
      .filter(Boolean)
      .join(' · ')]);
  }
  return card(
    `${o.dryRun ? '⚪' : '🟢'} ${title('PHILIPS', 'siap')}`,
    [
      `🤖 ${bold(o.dryRun ? 'bot aktif — mode simulasi' : 'bot aktif — mode LIVE')}`,
      '',
      pre(sheet(rows)),
      '',
      note('/help untuk daftar perintah'),
    ],
    nowWib(),
  );
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
      note('simulasi valid — tidak mengirim tx.'),
    ]);
  }
  const body: string[] = [
    `🟢 ${bold('posisi v4 baru dibuka')} — monitor aktif`,
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
  return card(`🔴 ${title('TUTUP v4', `#${tokenId}`)}`, [
    note('posisi Uniswap v4 di-burn; SELURUH likuiditas + fee (kedua token) kembali ke wallet — tanpa auto-swap.'),
    '',
    bold('Yakin tutup posisi ini?'),
  ]);
}

/** Alert monitor: posisi v4 (dikelola bot) masuk/keluar range. */
export function msgV4Range(tokenId: string, inRange: boolean): string {
  return inRange
    ? card(`🟢 ${title('V4 IN RANGE', `#${tokenId}`)}`, [`🟢 ${bold('kembali dalam rentang')} — fee mengalir lagi.`], nowWib())
    : card(`🔴 ${title('V4 OUT OF RANGE', `#${tokenId}`)}`, [`🔴 ${bold('keluar rentang')} — posisi v4 di luar; pertimbangkan tutup.`], nowWib());
}


/**
 * Kartu HUB TOKEN — muncul saat CA ditempel telanjang (tanpa command).
 * Satu identitas + satu screening melayani empat aksi; tiap tombol masuk ke alur
 * yang sudah ada (guard & konfirmasi masing-masing tetap utuh).
 */
export function msgTokenHub(o: {
  symbol: string;
  chainLabel: string;
  ca: string;
  verdict: 'AMAN' | 'HATI-HATI' | 'BAHAYA' | null; // null = screening gagal
  verdictNote?: string;
  priceUsd?: string | null;
  balanceLabel?: string; // hanya bila wallet memegang token ini
  balanceUsd?: number | null;
  lpCount?: number; // posisi LP aktif untuk token ini
  lpIds?: string[];
  dryRun: boolean;
}): string {
  const head =
    o.verdict === 'BAHAYA' ? '⚠️' : o.verdict === 'HATI-HATI' ? '🟡' : o.verdict === 'AMAN' ? '🛡' : '🟡';
  const body: string[] = [];
  if (o.verdict === 'BAHAYA') {
    body.push(`⚠️ ${bold('SCREEN: BAHAYA')}${o.verdictNote ? ` — ${esc(o.verdictNote)}` : ''}`);
  } else if (o.verdict === 'HATI-HATI') {
    body.push(`🟡 ${bold('SCREEN: HATI-HATI')}${o.verdictNote ? ` — ${esc(o.verdictNote)}` : ''}`);
  } else if (o.verdict === 'AMAN') {
    body.push(`🟢 ${bold('SCREEN: AMAN')}${o.verdictNote ? ` — ${esc(o.verdictNote)}` : ''}`);
  } else {
    body.push(`🟡 ${bold('SCREEN: GAGAL')} — token tak terverifikasi.`);
  }
  const rows: Array<[string, string]> = [];
  if (o.priceUsd) rows.push(['harga', `$${o.priceUsd}`]);
  if (o.balanceLabel) {
    rows.push(['saldo', `${o.balanceLabel}${o.balanceUsd ? `  (${usdPlain(o.balanceUsd)})` : ''}`]);
  }
  if (o.lpCount) rows.push(['posisi', `${o.lpCount} LP aktif${o.lpIds?.length ? ` (#${o.lpIds.join(' #')})` : ''}`]);
  rows.push(['ca', shortAddr(o.ca)]);
  body.push('', pre(sheet(rows)));
  if (!o.balanceLabel && !o.lpCount) body.push('', note('belum dipegang & belum ber-LP — bisa mulai dari Buka LP / Beli'));
  return card(`${head} ${title(o.symbol, o.chainLabel)}`, body, footerMode(o.dryRun));
}

export function msgUnknown(txt: string): string {
  const shown = (txt || '').trim().slice(0, 40) || '…';
  return card(
    title('UNKNOWN'),
    [
      fieldBlock([['input', shown]]),
      '',
      note('ketik /help untuk daftar perintah · tempel CA untuk kartu token'),
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
  totalUsd: number | null; // null = harga ETH tak terbaca (JANGAN 0)
  holdingsCount: number | null; // null = pembacaan gagal (BUKAN 'bersih')
  lpUsd?: number | null; // nilai posisi LP aktif
  lpFailed?: number; // posisi yang gagal dibaca → total belum lengkap
  realizedEth?: number; // PnL cashout seumur hidup
}): string {
  const modeTxt = opts.dryRun ? 'DRY RUN' : 'LIVE';
  const dot = opts.dryRun ? '⚪' : '🟢';
  const usdCol = (u: number | null | undefined) => (u === null || u === undefined ? '$?' : usdPlain(u));

  // Ringkasan uang: wallet + LP + realized. Satu <pre> supaya kolom benar-benar sejajar.
  const sum: string[][] = [['wallet', usdCol(opts.totalUsd)]];
  if (opts.lpUsd !== undefined) sum.push(['lp aktif', `${usdCol(opts.lpUsd)}   (${opts.positions} posisi)`]);
  if (opts.realizedEth !== undefined) sum.push(['realized', `${opts.realizedEth >= 0 ? '+' : ''}${opts.realizedEth.toFixed(5)} ETH`]);

  // Chain bersaldo 0 disembunyikan: baris '$0.00' tak membawa keputusan apa pun.
  const rows = opts.chains
    .filter((c) => Number(c.amount) > 0)
    .map((c) => [c.label.toLowerCase(), `${c.amount} ${c.symbol}`, usdCol(c.usd)]);
  if (opts.usdg) rows.push(['usdg', `${opts.usdg.amount} USDG`, usdCol(opts.usdg.usd)]);

  const equity =
    opts.totalUsd === null ? '$?' : usdPlain(opts.totalUsd + (opts.lpUsd ?? 0));
  const body: string[] = [
    `💰 ${bold(`ekuitas ≈ ${equity}`)}`,
    '',
    pre(sheet(sum as Array<[string, string]>)),
  ];
  if (rows.length) body.push('', pre(alignTable(['chain', 'saldo', 'usd'], rows, [false, true, true])));
  if (opts.lpFailed) body.push('', `🟡 ${opts.lpFailed} posisi gagal dibaca — total belum lengkap`);
  if (opts.holdingsCount === null) body.push('🟡 baca token gagal — coba Refresh');
  else if (opts.holdingsCount > 0) body.push(`⚠️ ${bold(String(opts.holdingsCount))} token nyangkut — jual lewat /sell`);
  body.push(`👛 <code>${esc(shortAddr(opts.wallet))}</code>`);
  return card(
    `${dot} ${title('UANG', modeTxt)}`,
    body,
    `${modeTxt} · chain ${esc(String(opts.chainId))} · limit ${esc(opts.limitLabel)} · ${nowWib()}`,
  );
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
  count?: number; // total entri jurnal (untuk baris 'tak terukur')
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
    ...(opts.count && opts.count - opts.known - (opts.excluded ?? 0) > 0
      ? ([
          ['tak terukur', `${opts.count - opts.known - (opts.excluded ?? 0)} (posisi hilang/burned)`],
        ] as Array<[string, string]>)
      : []),
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

/** Alert harga token anjlok ≥ambang dari harga entry (auto-monitor). */
export function msgPriceDrop(tokenId: string, symbol: string, dropPct: number, baseSymbol = 'WETH'): string {
  return card(`⚠️ ${title('ANJLOK', symbol)}`, [
    pre(`pair   : ${baseSymbol} / ${symbol}\nposisi : #${tokenId}`),
    '',
    `🔴 ${bold(`turun ${fmtPct(-dropPct)} dari entry`)}`,
    '',
    // Tombol '⛔ Tutup Sekarang' menyertai pesan ini (monitor.ts) — microcopy harus
    // menunjuk ke tombol itu, bukan menyuruh mengetik command saat harga jatuh.
    quoteHtml('Tutup sekarang, atau biarkan bila kamu masih yakin.'),
  ]);
}

export function msgCloseAllPick(countV3: number, countV4 = 0): string {
  const total = countV3 + countV4;
  return card(`⛔ ${title('TUTUP SEMUA')}`, [
    `${bold(String(total))} posisi aktif${countV4 ? ` (${countV3} v3 · ${countV4} v4)` : ''} — tap ${bold('Tutup')} di tiap kartu.`,
    note('tiap penutupan tetap lewat konfirmasi masing-masing.'),
  ]);
}

// ─── /buy /sell token (base↔token, rute terbaik) ───────────────────────
export function msgBuyAskCA(dryRun: boolean): string {
  return card(`🟢 ${title('BELI TOKEN')}`, [
    note('chain terdeteksi otomatis dari CA.'),
    `💬 Tempel ${bold('alamat kontrak (CA)')} token (0x…).`,
  ], footerMode(dryRun));
}
export function msgBuySafetyHint(sym: string): string {
  // note() → italic() → esc(): apa pun HTML di dalamnya ikut ter-escape (user melihat
  // '<b>PONS</b>' mentah). Rakit di sini, jangan bikin primitif baru.
  return `${italic('Cek detail & keamanan ')}${bold(sym)}${italic(' di atas. Lanjut untuk pilih aset & size.')}`;
}
export function msgSellList(n: number): string {
  return card(`🔴 ${title('JUAL TOKEN')}`, [note(`${n} token dipegang — pilih yang mau dijual.`)]);
}
export function msgSellNoHoldings(): string {
  return card(`🔴 ${title('JUAL TOKEN')}`, [note('tak ada token dgn saldo di wallet (selain base).')]);
}
export function msgSellAmount(sym: string, balLabel: string): string {
  return card(`📉 ${title('JUAL', sym)}`, [
    `💰 saldo ${bold(balLabel)}`,
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
  danger?: boolean; // verdikt screening BAHAYA (ikut sampai kartu pengirim tx)
  screenFailed?: boolean;
  balanceLabel?: string;
  shortLabel?: string | null; // kurang berapa (bila kurang → tombol Konfirmasi tak dirender)
}): string {
  const rows: Array<[string, string]> = [
    ['terima ≈', o.estOutLabel],
    ['bayar', o.amountInLabel],
    ['rute est.', o.route],
    // 5%→15% hanya berlaku untuk rute Uniswap; rute relay dilindungi quoter penyedia.
    ['slippage', o.route.startsWith('uniswap') ? '5% → 15%' : `${o.route} (auto)`],
  ];
  if (o.balanceLabel) rows.push(['saldo', o.balanceLabel]);
  const body = [
    `💰 ${bold(o.amountInLabel)}${o.buy ? '' : ` → ${o.tokenSym}`}`,
    '',
    ...hrows(rows),
  ];
  if (o.shortLabel) {
    body.push('', `🔴 ${bold(`KURANG ${o.shortLabel}`)} — isi dulu lewat /bridge, lalu ulangi.`);
  }
  if (o.danger) {
    body.push('', `⚠️ ${bold('SCREEN: BAHAYA')}`, quoteHtml('token ini bisa tak bisa dijual lagi. Batal kalau ragu.'));
  } else if (o.screenFailed) {
    body.push('', `🟡 ${bold('SCREEN: GAGAL')} — token tak terverifikasi.`);
  } else {
    body.push('', note('estimasi; jumlah pasti dilindungi quoter saat eksekusi.'));
  }
  // Header meng-encode arah (kamus: 🔄 = refresh, jangan dipakai untuk beli/jual).
  const head = o.buy ? '📈' : '📉';
  const what = o.buy ? 'BELI' : 'JUAL';
  return card(`${head} ${title(what, `${o.tokenSym} · ${o.chainLabel}`)}`, body, footerMode(o.dryRun));
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

// ─── /bridge — cross-chain ke USDT @Stable via Relay ───────────────────
export function msgFundNoStable(): string {
  return card(`🌉 ${title('FUND STABLE')}`, [
    note('StableChain belum aktif — set RPC_URL_STABLE di .env & restart dulu.'),
  ]);
}

export function msgFundStart(): string {
  return card(`🌉 ${title('BRIDGE', 'Robinhood ⇄ Stable')}`, [
    'Pindah dana lintas-chain (Relay, fallback LiFi).',
    '',
    note('pilih arah & aset:'),
  ]);
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
  const netLabel = net != null ? `${usdSigned(net)}${q.inUsd && Number(q.inUsd) > 0 ? ` (${fmtPct((net / Number(q.inUsd)) * 100)})` : ''}` : '—';
  const body = [
    `🟢 ≈ terima ${bold(q.outLabel)}${q.outUsd ? ` (${'$' + q.outUsd})` : ''}`,
    '',
    ...hrows([
      ['Kirim', q.inLabel],
      ['≈ Terima', q.outLabel],
      ['Biaya', q.feeUsd ? `$${q.feeUsd}` : 'tak terbaca'],
      ['Impact', q.impactPct ? `${q.impactPct}%` : 'tak terbaca'],
      ['Selisih', netLabel],
      ['Tunggu', eta],
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
    hrow('Tx', txHashes.length ? shortAddr(txHashes[txHashes.length - 1]) : '—'),
    '',
    note('saldo tujuan muncul di /status setelah bridge sampai.'),
  ], footerMode(dryRun));
}

export function msgError(where: string, err: string): string {
  // Revert ethers = blok multi-baris (reason/code/transaction) yang menutupi baris
  // "lakukan ini". Ambil baris pertama saja; detail lengkap tetap ada di log service.
  const first = String(err).split('\n')[0].trim().slice(0, 200) || 'error tak dikenal';
  return card(
    `❌ ${title('ERROR', where)}`,
    [note(first), '', note('coba ulangi — detail lengkap ada di log service.')],
    nowWib(),
  );
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
  return card(`${e} ${title('DETAIL', `#${opts.tokenId}`)}`, body, nowWib());
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
  // TANPA monospace: hanya tag HTML biasa. Satu posisi = satu baris, status
  // ditulis sebagai kata (in)/(out) — bukan emoji — supaya lebarnya konsisten
  // di semua perangkat. Kolom memang tak sejajar; itu harga membuang mono.
  const MAX_ROWS = 12;
  const shown = opts.rows.slice(0, MAX_ROWS);
  const lines = shown.map(
    (r) =>
      ` #${r.id} | ${esc(r.pair)} · ${r.investLabel} · ` +
      `${r.pnlUsd === null ? '—' : usdSigned(r.pnlUsd)} · ${r.age} (${r.inRange ? 'in' : 'out'})`,
  );

  const out = [
    `<b>POSITION</b>`,
    '',
    lines.join('\n'),
    '',
    `💵 Net ${opts.totalPnlUsd === null ? '—' : usdSigned(opts.totalPnlUsd)}`,
  ];
  if (opts.rows.length > MAX_ROWS) out.push('', `+${opts.rows.length - MAX_ROWS} posisi lain — tutup dulu untuk melihatnya`);
  out.push('', `${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`);
  return out.join('\n');
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

/** Riwayat trade — satu tabel sejajar; jumlah di header = yang benar-benar tampil. */
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
  totalInJournal?: number,
): string {
  if (items.length === 0) {
    return card(`🧾 ${title('RIWAYAT')}`, [note('belum ada trade tertutup.')]);
  }
  const reasonId: Record<string, string> = {
    cashed: 'cair',
    gone: 'hilang',
    burned: 'ditutup luar',
  };
  const header = ['id', 'token', 'pnl eth', 'pnl %', 'umur'];
  const rows = items.map((r) => [
    r.tokenId,
    r.symbol.length > 10 ? r.symbol.slice(0, 9) + '…' : r.symbol,
    r.reason === 'cashed' ? (r.pnlEth >= 0 ? '+' : '') + r.pnlEth.toFixed(5) : reasonId[r.reason] ?? r.reason,
    r.reason === 'cashed' ? fmtPct(r.pnlPct) : '—',
    r.closedAt ? fmtAge(Date.now() - r.closedAt) : '—',
  ]);
  const net = items.filter((r) => r.reason === 'cashed').reduce((a, r) => a + r.pnlEth, 0);
  const body = [
    pre(alignTable(header, rows, [false, false, true, true, true])),
    '',
    `💰 ${bold(`${net >= 0 ? '+' : ''}${net.toFixed(5)} ETH`)} dari ${items.length} trade tampil`,
  ];
  if (totalInJournal && totalInJournal > items.length) {
    body.push(note(`jurnal menyimpan ${totalInJournal} trade — rekap penuh di /pnl.`));
  }
  return card(`🧾 ${title('RIWAYAT', `${items.length} terakhir`)}`, body, nowWib());
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

export function msgAmountStep(symbol: string, maxLabel: string, balanceLabel?: string): string {
  return card(
    title('ADD LP', '3/4'),
    [
      section(`nominal ${symbol}`),
      // Saldo ikut ditampilkan: dulu user memilih buta lalu baru ditolak "KURANG"
      // di kartu 4/4 (satu langkah + satu round-trip terbuang).
      fieldBlock([
        ['saldo', balanceLabel ?? '?'],
        ['maks', maxLabel],
      ]),
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
  const dot = opts.dryRun ? '⚪' : opts.shortLabel ? '🔴' : opts.costFailed ? '🟡' : '⚠️';
  const body: string[] = [];
  if (opts.screenDanger) body.push(`⚠️ ${bold('SCREEN: BAHAYA')} — pertimbangkan batal.`, '');
  else if (opts.screenFailed) body.push(`🟡 ${bold('SCREEN: GAGAL')} — token tak terverifikasi.`, '');
  body.push(
    pre(
      sheet([
        ['pair', `${opts.baseSymbol} / ${opts.symbol} · ${feeLabel(opts.fee)}`],
        ['deposit', `${opts.depositAmount} ${opts.baseSymbol}${opts.depositUsd ? ` ≈ ${usdPlain(opts.depositUsd)}` : ''}`],
        ['rentang', `${fmtPct(opts.pctHigh)} → ${fmtPct(opts.pctLow)}`],
        ['harga', `1 ${opts.symbol} = ${opts.currentPrice} ${opts.baseSymbol}`],
        ['gas est', `~${opts.gasEth} ETH`],
        ['perlu', String(opts.needLabel)],
        ['saldo', String(opts.balanceLabel)],
      ]),
    ),
  );
  if (opts.costFailed) {
    body.push('', `🟡 ${bold('saldo belum terverifikasi')} — RPC biaya gagal. Cek /status dulu.`);
  } else if (opts.shortLabel) {
    body.push('', `🔴 ${bold(`KURANG ${opts.shortLabel}`)} — top up dulu, lalu ulangi /add.`);
  } else {
    body.push('', `🟢 ${bold('saldo cukup')} — siap eksekusi`);
  }
  body.push(
    '',
    quoteHtml('PnL LP = fee − impermanent loss. Tak ada SL/TP otomatis — proteksi manual lewat /positions.'),
  );
  return card(
    `${dot} ${title('PREVIEW', `${opts.symbol} · 4/4`)}`,
    body,
    `${opts.dryRun ? 'DRY RUN — tidak kirim tx' : 'LIVE · konfirmasi = kirim tx'} · ${nowWib()}`,
  );
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
  return card(`✅ ${title('OPENED', `#${tokenId}`)}`, body, nowWib());
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
  return card(title('CLOSE', `#${opts.tokenId}`), body, nowWib());
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
    nowWib(),
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
  return card(`✅ ${title('CASHED OUT', `#${opts.tokenId}`)}`, body, nowWib());
}

// ─── monitor ───────────────────────────────────────────────────────

export function msgRangeEnter(tokenId: string, symbol: string, baseSymbol = 'WETH'): string {
  return card(
    `🟢 ${title('IN RANGE', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      `🟢 ${bold('fee mulai mengalir')} — ${esc(baseSymbol)} konversi ke ${esc(symbol)}.`,
    ],
    nowWib(),
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
      nowWib(),
    );
  }
  return card(
    `🔴 ${title('OUT ↓', `#${tokenId}`)}`,
    [
      fieldBlock([['pair', `${baseSymbol} / ${symbol}`]]),
      `🔴 ${bold('RISIKO')} — ${esc(baseSymbol)} sudah 100% jadi ${esc(symbol)}.`,
      note(`pulih hanya bila harga naik lagi. Pertimbangkan /stop.`),
    ],
    nowWib(),
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
    nowWib(),
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
