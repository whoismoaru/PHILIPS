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

export function section(name: string): string {
  return bold(name);
}

export function note(text: string): string {
  return italic(text);
}

export function quoteHtml(innerHtml: string): string {
  return `<blockquote>${innerHtml}</blockquote>`;
}

/** Blok 'label · value' (teks biasa). */
export function sheet(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) => `${k} · ${v}`).join('\n');
}

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

// Badan cockpit bersama /start & /help: VIEW/EXECUTION/EMERGENCY dalam pohon.
function cockpitLines(dryRun: boolean): string[] {
  const grp = (rows: Array<[string, string]>) =>
    rows.map(([c, d]) => `• ${bold(c)} — ${esc(d)}`);
  return [
    ...grp([
      ['/status', 'Saldo, ekuitas & rincian dompet'],
      ['/positions', 'Pemantauan LP aktif real-time'],
      ['/history', 'Jurnal transaksi tertutup'],
      ['/pnl', 'Rekapitulasi PnL seumur hidup'],
      ['/pools', 'Pool APR tertinggi saat ini'],
    ]).map((l, i) => (i === 0 ? `📊 <b>VIEW &amp; ANALYTICS</b>\n${l}` : l)),
    '',
    ...grp([
      ['/add_lp', 'Buka posisi LP baru'],
      ['/claim_fees', 'Panen fee tanpa menutup posisi'],
      ['/remove_lp', 'Tarik likuiditas 25/50/75/100%'],
      ['/stop', 'Tutup posisi LP spesifik'],
      ['/buy', 'Beli token (Best Route)'],
      ['/sell', 'Jual token di dompet'],
    ]).map((l, i) => (i === 0 ? `⚙️ <b>EXECUTION &amp; TRADE</b>\n${l}` : l)),
    '',
    '⛔ <b>EMERGENCY</b>',
    `• ${bold('/closeall')} — ${esc('Tutup SELURUH posisi sekaligus')}`,
    '',
    note('Tip: tempel CA token langsung di chat untuk membuka Token Hub.'),
    '',
    `⚠️ <i>${esc('/add_lp /remove_lp /stop /buy /sell /closeall menggerakkan dana on-chain')}</i>`,
  ];
}

/** Kartu daftar perintah (/help). */
export function msgHelp(dryRun: boolean): string {
  return [
    hdr(`${dryRun ? '⚪' : '🟢'} PHILIPS · LP COCKPIT`),
    '',
    `⚡ ${bold('Single-Sided LP WETH / USDG')} — Uniswap v3 &amp; v4`,
    note(`mode: ${dryRun ? 'DRY RUN (simulasi)' : 'LIVE (kirim tx)'}`),
    '',
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
  walletShort?: string | null;
}): string {
  const sync =
    o.imported || o.gone
      ? [o.imported ? `+${o.imported} posisi diimpor` : '', o.gone ? `${o.gone} selesai di luar bot` : '']
          .filter(Boolean)
          .join(' · ')
      : '';
  return [
    `🤖 ${bold('Selamat datang di PHILIPS Bot!')} 🚀`,
    '',
    `Saya PHILIPS, asisten pribadimu untuk mengelola ${bold('Single-Side Liquidity Pool')} di ${bold('Uniswap V3')} lewat dompet ${bold('Robinhood Web3')}.`,
    '',
    'Tujuan saya sederhana: bikin DeFi gampang, aman, dan efisien — mau beli saat turun, ambil untung saat naik, atau sekadar memantau fee yang terkumpul.',
    '',
    `🛠️ ${bold('Fitur Inti')}`,
    '🔗 Hubungkan dompet Robinhood (impor manual)',
    '💧 Single-Side LP — setor cukup satu token',
    '🛡️ Audit keamanan token & cek rug pull otomatis',
    '📊 Pantau posisi LP aktif, APR, dan fee terkumpul',
    '',
    `⚠️ ${bold('Catatan Keamanan')}`,
    `PHILIPS ${bold('tidak akan pernah')} meminta seed phrase di luar alur resmi /connect. DeFi berisiko, termasuk Impermanent Loss (IL). Selalu DYOR.`,
    '',
    `📟 ${bold('Status')}`,
    `• Mode · ${bold(o.dryRun ? '⚪ DRY RUN (simulasi)' : '🟢 LIVE')}`,
    `• Chain · ${esc(o.chainLabel)} (ID ${esc(String(o.chainId))})`,
    `• Dompet · ${o.walletShort ? code(o.walletShort) : italic('belum terhubung')}`,
    `• Posisi LP · ${bold(`${o.positions} aktif`)}`,
    ...(sync ? [`• Sinkron · ${esc(sync)}`] : []),
    '',
    '👉 Tekan tombol di bawah untuk mulai.',
    note(nowWib()),
  ].join('\n');
}

/** Cara memulai LP — dipakai tombol "Buka LP" di /start (belum ada wizard tanpa CA). */
export function msgAddHowTo(): string {
  return [
    `💧 ${bold('Buka Single-Side LP')}`,
    '',
    'Dua cara memulai:',
    `• Tempel ${bold('alamat kontrak (CA)')} token langsung di chat — PHILIPS mengaudit lalu menawarkan LP.`,
    `• Ketik ${code('/add_lp <CA>')} untuk langsung masuk wizard.`,
    '',
    `Belum punya kandidat? Buka ${code('/pools')} untuk melihat pool ber-APR tertinggi.`,
  ].join('\n');
}

/** Kartu "How it Works" — penjelasan statis, dipanggil dari tombol di /start. */
export function msgHighRiskBlocked(reasons: string[]): string {
  const out = [
    `🚫 ${bold('Transaksi Diblokir: Token Berisiko Tinggi')}`,
    '',
    'PHILIPS menemukan masalah keamanan serius pada token ini:',
  ];
  for (const r of reasons.slice(0, 5)) out.push(`• ${esc(r)}`);
  if (!reasons.length) out.push('• vonis audit: BAHAYA');
  out.push(
    '',
    'Demi melindungi danamu, Single-Side LP dimatikan untuk kontrak ini. Pilih token lain.',
    '',
    note('audit lengkapnya ada di kartu di atas.'),
  );
  return out.join('\n');
}

export function msgSecretLeakWarning(): string {
  return [
    `🚨 ${bold('PERINGATAN KEAMANAN')} 🚨`,
    '',
    'Sepertinya kamu mengirim data sensitif (private key / seed phrase) di luar alur koneksi resmi.',
    '',
    `❌ ${bold('Pesanmu diabaikan dan sudah dihapus.')}`,
    '',
    `Kalau memang mau menghubungkan dompet, ketik ${code('/connect')} dan ikuti langkahnya. Jangan pernah menempel kunci sembarangan di chat.`,
    '',
    note('kunci yang sudah pernah terkirim ke chat sebaiknya dianggap bocor — pindahkan dananya.'),
    note('kalau tadi itu cuma tx hash (0x + 64 karakter), abaikan pesan ini — bot tak memakai tx hash sebagai masukan.'),
  ].join('\n');
}

export function msgTokenInfoUsage(): string {
  return [
    `🔍 ${bold('Audit Keamanan Token')}`,
    '',
    `Kirim alamat kontraknya: ${code('/token_info 0x…')}`,
    '',
    note('atau tempel CA-nya langsung di chat — hasilnya sama.'),
  ].join('\n');
}

export function msgHowItWorks(): string {
  return [
    `📖 ${bold('Cara Kerja PHILIPS')}`,
    '',
    `1️⃣ ${bold('Hubungkan dompet')} — impor lewat /connect. Kunci disimpan terenkripsi di server bot ini supaya PHILIPS bisa menandatangani transaksi untukmu.`,
    '',
    `2️⃣ ${bold('Pilih token')} — /pools untuk pool ber-APR tertinggi, atau tempel alamat kontrak (CA) langsung di chat. Setiap token diaudit dulu: honeypot, pajak beli/jual, LP terkunci, sebaran holder.`,
    '',
    `3️⃣ ${bold('Buka LP satu sisi')} — /add_lp. Kamu setor satu token saja; posisimu bekerja seperti limit order pasif yang tetap memanen fee sambil menunggu harga.`,
    '',
    `4️⃣ ${bold('Pantau & panen')} — /positions untuk melihat status in/out of range, /claim_fees untuk memanen, /remove_lp untuk menarik.`,
    '',
    `⚠️ ${bold('Risiko')}: harga bisa bergerak melewati rentangmu (impermanent loss), dan token baru bisa rug. PHILIPS memblokir token yang jelas berbahaya, tapi keputusan akhir tetap milikmu.`,
  ].join('\n');
}

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
  return [
    hdr('🔴 KONFIRMASI TUTUP v4'),
    '',
    `Posisi: ${bold(`#${esc(tokenId)}`)} (Uniswap v4)`,
    '',
    '⚠️ Posisi di-burn; SELURUH likuiditas + fee (kedua token) kembali ke dompet — tanpa auto-swap.',
    '',
    bold('Yakin ingin menutup posisi ini?'),
  ].join('\n');
}

/** Alert monitor: posisi v4 (dikelola bot) masuk/keluar range. */
export function msgV4Range(tokenId: string, inRange: boolean): string {
  return inRange
    ? [
        hdr('🟢 LP KEMBALI IN RANGE'),
        '',
        `🟢 Posisi ${bold(`#${esc(tokenId)}`)} (Uniswap v4) kembali dalam rentang harga — fee mengalir lagi.`,
        note(nowWib()),
      ].join('\n')
    : [
        hdr('⚠️ ALERT: LP OUT OF RANGE!'),
        '',
        `🔴 Posisi ${bold(`#${esc(tokenId)}`)} (Uniswap v4) keluar dari rentang harga efektif.`,
        'Fee likuiditas terhenti. Pertimbangkan menutup atau memindahkan posisi.',
        note(nowWib()),
      ].join('\n');
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
  const scan =
    o.verdict === 'BAHAYA'
      ? `⚠️ ${bold('BAHAYA')}`
      : o.verdict === 'HATI-HATI'
        ? `🟡 ${bold('HATI-HATI')}`
        : o.verdict === 'AMAN'
          ? `🟢 ${bold('AMAN')}`
          : `🟡 ${bold('GAGAL')} — token tak terverifikasi`;
  const body: string[] = [
    hdr('🛡️ TOKEN HUB'),
    '',
    `📌 Token · ${bold(esc(o.symbol))} (${esc(o.chainLabel)})`,
    `📄 CA · ${code(shortAddr(o.ca))}`,
    `🛡️ Scan · ${scan}${o.verdict && o.verdictNote ? ` (${esc(o.verdictNote)})` : ''}`,
  ];
  const rows: Array<[string, string]> = [];
  if (o.priceUsd) rows.push(['Harga token', `$${esc(o.priceUsd)}`]);
  if (o.balanceLabel) {
    rows.push(['Saldo anda', `${bold(esc(o.balanceLabel))}${o.balanceUsd ? ` (${usdPlain(o.balanceUsd)})` : ''}`]);
  }
  if (o.lpCount) rows.push(['LP aktif', `${o.lpCount} posisi${o.lpIds?.length ? ` (#${esc(o.lpIds.join(' #'))})` : ''}`]);
  if (rows.length) body.push('', `📊 ${bold('METRICS AKTIF')}:`, ...tree(rows, 12));
  if (!o.balanceLabel && !o.lpCount) body.push('', note('belum dipegang & belum ber-LP — bisa mulai dari Buka LP / Beli Token'));
  body.push(note(`${o.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
  return body.join('\n');
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
  explorerUrl?: string | null; // base URL explorer → alamat jadi tautan (null = teks biasa)
}): string {
  // USD tak terbaca → '—' (netral), JANGAN '$0.00' yang terbaca sebagai fakta.
  const usdCol = (u: number | null | undefined) => (u === null || u === undefined ? '—' : usdPlain(u));
  const equity = opts.totalUsd === null ? '—' : usdPlain(opts.totalUsd + (opts.lpUsd ?? 0));

  const parts: string[] = [
    hdr('📊 STATUS & EKUITAS'),
    '',
    `💵 ${bold('Total Ekuitas')} : ${bold(equity)}`,
    '',
    `💰 ${bold('SALDO UNSTAKED')}: ${bold(usdCol(opts.totalUsd))}`,
  ];

  // Chain bersaldo 0 disembunyikan: baris '0.0000' tak membawa keputusan apa pun.
  const assets: Array<[string, string]> = opts.chains
    .filter((c) => Number(c.amount) > 0)
    .map((c) => [c.label, `${bold(`${esc(c.amount)} ${esc(c.symbol)}`)}${c.usd === null ? '' : ` (${usdPlain(c.usd)})`}`]);
  if (opts.usdg) assets.push(['USDG', `${bold(`${esc(opts.usdg.amount)} USDG`)} (${usdPlain(opts.usdg.usd)})`]);
  if (assets.length) parts.push(...tree(assets, 11));

  parts.push('');
  if (opts.lpUsd !== undefined) {
    parts.push(`🌊 ${bold('LIKUIDITAS AKTIF')}: ${bold(usdCol(opts.lpUsd))} (${opts.positions} posisi)`);
  }
  if (opts.realizedEth !== undefined) {
    parts.push(
      `📈 ${bold('REALIZED PnL')}   : ${dot(opts.realizedEth)} ${bold(`${opts.realizedEth >= 0 ? '+' : ''}${opts.realizedEth.toFixed(5)} ETH`)}`,
    );
  }
  parts.push('');

  if (opts.lpFailed) parts.push(`⚠️ ${note(`${opts.lpFailed} posisi gagal dibaca — total belum lengkap`)}`);
  if (opts.holdingsCount === null) parts.push(`⚠️ ${note('baca token gagal — coba Refresh')}`);
  else if (opts.holdingsCount > 0) parts.push(`⚠️ ${opts.holdingsCount} token belum terjual di wallet — gunakan /sell`);

  const short = esc(shortAddr(opts.wallet));
  const link = opts.explorerUrl
    ? `<a href="${esc(opts.explorerUrl)}/address/${esc(opts.wallet)}">${short}</a>`
    : `<code>${short}</code>`;
  parts.push(
    `👛 ${link} | ${opts.dryRun ? '⚪ DRY RUN' : '🟢 LIVE'} (chain ${esc(String(opts.chainId))})`,
    note(`limit ${opts.limitLabel} · ${nowWib()}`),
  );

  return parts.join('\n');
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
    return [hdr('📈 TOTAL LIFETIME PnL'), '', note('belum ada trade tertutup.')].join('\n');
  }
  const winrate = (opts.wins / opts.known) * 100;
  const untracked = opts.count ? opts.count - opts.known - (opts.excluded ?? 0) : 0;
  const rows: Array<[string, string]> = [
    ['Total Trade', `${opts.known} (${opts.wins} Win / ${opts.losses} Loss)`],
    ['Winrate', `🎯 ${bold(`${winrate.toFixed(1)}%`)}`],
    ['Total Profit', `🟢 ${bold(sgEth(opts.grossWin))}`],
    ['Total Loss', `🔴 ${bold(sgEth(opts.grossLoss))}`],
    ...(untracked > 0 ? ([['Untracked', `${untracked} trade (burned/luar bot)`]] as Array<[string, string]>) : []),
  ];
  const out = [
    hdr('📈 TOTAL LIFETIME PnL'),
    '',
    `${dot(opts.netEth)} ${bold('NET CASHOUT')}: ${bold(sgEth(opts.netEth))}`,
    '',
    `📊 ${bold('STATISTIK PERDAGANGAN')}:`,
    ...tree(rows, 12),
  ];
  if (opts.best) out.push('', `🏆 ${bold('Best Trade')}  : ${esc(opts.best.symbol)} (${dot(opts.best.pnlEth)} ${bold(sgEth(opts.best.pnlEth))})`);
  if (opts.worst) out.push(`⚠️ ${bold('Worst Trade')} : ${esc(opts.worst.symbol)} (${dot(opts.worst.pnlEth)} ${bold(sgEth(opts.worst.pnlEth))})`);
  if (opts.excluded && opts.excluded > 0) out.push('', note(`${opts.excluded} trade lama tanpa data hasil diabaikan.`));
  out.push('', note(`${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
  return out.join('\n');
}

/** Alert harga token anjlok ≥ambang dari harga entry (auto-monitor). */
export function msgPriceDrop(tokenId: string, symbol: string, dropPct: number, baseSymbol = 'WETH'): string {
  return [
    hdr('⚠️ ALERT: HARGA ANJLOK'),
    '',
    `Pair · ${bold(`${esc(baseSymbol)} / ${esc(symbol)}`)}`,
    `Posisi · #${esc(tokenId)}`,
    '',
    `🔴 ${bold(`Harga turun ${fmtPct(-dropPct)} dari harga entry.`)}`,
    '',
    // Tombol '⛔ Tutup Sekarang' menyertai pesan ini (monitor.ts) — microcopy harus
    // menunjuk ke tombol itu, bukan menyuruh mengetik command saat harga jatuh.
    note('tutup sekarang lewat tombol di bawah, atau biarkan bila masih yakin.'),
  ].join('\n');
}

export function msgCloseAllPick(countV3: number, countV4 = 0): string {
  const total = countV3 + countV4;
  return [
    hdr('⛔ TUTUP POSISI LP'),
    '',
    `Ditemukan ${bold(`${total} posisi LP aktif`)}${countV4 ? ` (${countV3} v3 · ${countV4} v4)` : ''}.`,
    'Pilih posisi yang ingin ditutup — tap ⛔ Tutup di kartunya.',
    '',
    note('tiap penutupan tetap lewat konfirmasi masing-masing.'),
  ].join('\n');
}

// ─── /buy /sell token (base↔token, rute terbaik) ───────────────────────
export function msgBuyAskCA(dryRun: boolean): string {
  return [
    hdr('📈 BELI TOKEN (SWAP)'),
    '',
    `💬 Tempel ${bold('alamat kontrak (CA)')} token (0x…).`,
    '',
    note('chain terdeteksi otomatis dari CA.'),
    note(`${dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`),
  ].join('\n');
}
export function msgBuySafetyHint(sym: string): string {
  // note() → italic() → esc(): apa pun HTML di dalamnya ikut ter-escape (user melihat
  // '<b>PONS</b>' mentah). Rakit di sini, jangan bikin primitif baru.
  return `${italic('Cek detail & keamanan ')}${bold(sym)}${italic(' di atas. Lanjut untuk pilih aset & size.')}`;
}
export function msgSellList(n: number): string {
  return [hdr('📉 JUAL TOKEN'), '', `${bold(String(n))} token dipegang — pilih yang mau dijual:`].join('\n');
}
export function msgSellNoHoldings(): string {
  return [hdr('📉 JUAL TOKEN'), '', note('tak ada token dgn saldo di wallet (selain base).')].join('\n');
}
export function msgSellAmount(sym: string, balLabel: string): string {
  return [
    hdr('📉 JUAL TOKEN'),
    '',
    `Token: ${bold(esc(sym))} | Saldo: ${bold(esc(balLabel))}`,
    '',
    'Pilih porsi penjualan:',
    note('base penerima dipilih otomatis — nilai terbaik antar rute.'),
  ].join('\n');
}
export function msgSellTypeAmount(sym: string): string {
  return [hdr('📉 JUAL TOKEN'), '', `💬 Ketik jumlah ${bold(esc(sym))} untuk dijual (atau ${code('semua')}).`].join('\n');
}
export function msgTSwapBase(chainLabel: string, buy: boolean): string {
  return [
    hdr(buy ? '📈 BELI TOKEN (SWAP)' : '📉 JUAL TOKEN (SWAP)'),
    '',
    `Chain: ${bold(esc(chainLabel))}`,
    '',
    bold(buy ? 'Pilih token pembayaran:' : 'Pilih token penerima:'),
  ].join('\n');
}
export function msgTSwapAmountPrompt(buy: boolean, sym: string, balanceLine: string): string {
  const what = buy ? `jumlah ${bold(esc(sym))} untuk dibelanjakan` : `jumlah ${bold(esc(sym))} untuk dijual`;
  return [
    hdr(buy ? '📈 NOMINAL BELI' : '📉 NOMINAL JUAL'),
    '',
    balanceLine,
    '',
    `💬 Ketik ${what}${buy ? '' : ` (atau ${code('semua')})`}.`,
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
  danger?: boolean; // verdikt screening BAHAYA (ikut sampai kartu pengirim tx)
  screenFailed?: boolean;
  balanceLabel?: string;
  shortLabel?: string | null; // kurang berapa (bila kurang → tombol Konfirmasi tak dirender)
}): string {
  // Header meng-encode arah (kamus: 🔄 = refresh, jangan dipakai untuk beli/jual).
  const body: string[] = [
    hdr(o.buy ? '📈 PREVIEW SWAP BELI' : '📉 PREVIEW SWAP JUAL'),
    '',
    `${esc('Token')}   : ${bold(esc(o.tokenSym))} (${esc(o.chainLabel)})`,
    '',
    `📤 Bayar · ${bold(esc(o.amountInLabel))}`,
    `📥 Terima ≈ · ${bold(esc(o.estOutLabel))}`,
    `🛣️ Rute · ${esc(o.route)}`,
    // 5%→15% hanya berlaku untuk rute Uniswap; rute relay dilindungi quoter penyedia.
    `🛡️ Slippage · ${o.route.startsWith('uniswap') ? 'auto 5% → 15%' : `${esc(o.route)} (auto)`}`,
  ];
  if (o.balanceLabel) body.push(`💰 Saldo · ${esc(o.balanceLabel)}`);
  if (o.shortLabel) {
    body.push('', `🔴 ${bold(`KURANG ${esc(o.shortLabel)}`)} — isi dulu wallet-nya, lalu ulangi.`);
  }
  if (o.danger) {
    body.push('', `⚠️ ${bold('SCREEN: BAHAYA')} — token ini bisa tak bisa dijual lagi. Batal kalau ragu.`);
  } else if (o.screenFailed) {
    body.push('', `🟡 ${bold('SCREEN: GAGAL')} — token tak terverifikasi.`);
  } else {
    body.push('', note('estimasi; jumlah pasti dilindungi quoter on-chain saat eksekusi.'));
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
      hdr('⚪ SWAP (DRY RUN)'),
      '',
      note('mode DRY RUN — tidak dieksekusi.'),
      '',
      ...tree([['Bayar', bold(esc(o.amountInLabel))], ['≈ dapat', bold(esc(o.outLabel))]], 8),
    ].join('\n');
  }
  return [
    hdr(o.buy ? '✅ SWAP BELI BERHASIL' : '✅ SWAP JUAL BERHASIL'),
    '',
    `🟢 ${bold('DITERIMA')}: ${bold(`+${esc(o.outLabel)}`)}`,
    '',
    ...tree(
      [
        ['Dibayar', esc(o.amountInLabel)],
        ['Token', esc(o.tokenSym)],
        ['Rute', esc(o.route ?? '—')],
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
  const first = String(err).split('\n')[0].trim().slice(0, 200) || 'error tak dikenal';
  return [
    hdr('❌ ERROR TRANSAKSI'),
    '',
    `${esc('Tahap')}  : ${bold(esc(where))}`,
    `${esc('Reason')} : ${code(first)}`,
    '',
    note('coba ulangi — detail lengkap ada di log service.'),
    note(nowWib()),
  ].join('\n');
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
  const pair = `${base} / ${esc(opts.symbol)}`;
  // Status HANYA di barisnya sendiri, tidak juga di judul: satu fakta satu tempat,
  // jadi tak ada peluang keduanya berbeda saat ada perubahan.
  const status = opts.inRange ? `🟢 ${bold('IN RANGE')}` : `🔴 ${bold('OUT OF RANGE')}`;

  return [
    `${bold('POSITION')} | #${esc(opts.tokenId)} · ${base}/${esc(opts.symbol)}`,
    '',
    `${pair} · ${feeLabel(opts.fee)}${opts.chain ? ` · ${esc(opts.chain)}` : ''}`,
    '',
    `Invest ${esc(opts.invest)} ${base} · Range ${esc(opts.range)}`,
    '',
    `Umur ${esc(opts.age)} · PnL ${esc(opts.pnlText)}`,
    '',
    status,
    '',
    footerMode(opts.dryRun),
  ].join('\n');
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
        ['Fees', `🟢 ${bold(esc(opts.fees))} (belum diklaim)`],
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
  totalInvestLabel: string;
  totalPnlUsd: number | null;
  outOfRange: number;
  totalFeesLabel?: string | null;
  rows: Array<{
    id: string;
    pair: string;
    investLabel: string;
    age: string;
    pnlUsd: number | null;
    pnlPct: number | null;
    inRange: boolean;
    rangeLabel?: string | null;
    feesLabel?: string | null;
    strategy?: string | null;
  }>;
}): string {
  const MAX_ROWS = 12;
  const shown = opts.rows.slice(0, MAX_ROWS);
  const blocks = shown.map((r) => {
    const pnl =
      r.pnlUsd === null
        ? '—'
        : `${dot(r.pnlUsd)} ${bold(usdSigned(r.pnlUsd))}${r.pnlPct === null ? '' : ` (${fmtPct(r.pnlPct)})`}`;
    const lines = [
      `${r.inRange ? '🟢' : '🔴'} ${bold(esc(r.pair))} · ${italic(`#${esc(r.id)}`)}`,
      `🎯 Strategi: ${bold(esc(r.strategy ?? 'Sisi Base (beli saat turun)'))}`,
      `💰 Setoran: ${esc(r.investLabel)}`,
    ];
    if (r.rangeLabel) lines.push(`📉 Rentang: ${esc(r.rangeLabel)}`);
    lines.push(
      `⏳ Status: ${r.inRange ? `${bold('Aktif')} (in range, sedang memanen fee)` : `${bold('Menunggu')} (out of range)`} · ${esc(r.age)}`,
      `📈 Fee belum diklaim: ${esc(r.feesLabel ?? '—')}`,
      `💵 PnL: ${pnl}`,
    );
    return lines.join('\n');
  });

  const out = [
    `📊 ${bold('Posisi LP Aktif')}`,
    '',
    blocks.join('\n\n'),
    '',
    `💼 ${bold('Total setoran')}: ${esc(opts.totalInvestLabel)}`,
    `💵 ${bold('Net PnL')}: ${opts.totalPnlUsd === null ? '—' : `${dot(opts.totalPnlUsd)} ${bold(usdSigned(opts.totalPnlUsd))}`}`,
  ];
  if (opts.totalFeesLabel) out.push(`📈 ${bold('Fee belum diklaim')}: ${esc(opts.totalFeesLabel)}`);
  if (opts.rows.length > MAX_ROWS) out.push(note(`+${opts.rows.length - MAX_ROWS} posisi lain — tutup dulu untuk melihatnya`));
  out.push('', note(`${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`));
  return out.join('\n');
}

export function msgNoPositions(): string {
  return card(
    title('POSITIONS'),
    [
      note('belum ada posisi LP tercatat.'),
      '',
      note('buka dengan'),
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
    reason: 'cashed' | 'gone' | 'burned';
    ca?: string;
    chain?: string;
    closedAt?: number;
  }>,
  totalInJournal?: number,
): string {
  if (items.length === 0) {
    return [hdr('🧾 RIWAYAT TRADE'), '', note('belum ada trade tertutup.')].join('\n');
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
  // Tabel tetap monospace (kolom angka harus sejajar); status pakai emoji dinamis
  // di baris ringkasan, bukan di dalam tabel — emoji merusak lebar kolom mono.
  const out = [
    hdr('🧾 RIWAYAT TRADE'),
    '',
    pre(alignTable(header, rows, [false, false, true, true, true])),
    '',
    `💰 ${bold('Net')} ${items.length} trade tampil : ${dot(net)} ${bold(`${net >= 0 ? '+' : ''}${net.toFixed(5)} ETH`)}`,
  ];
  if (totalInJournal && totalInJournal > items.length) {
    out.push(`📜 ${bold('Total jurnal')}          : ${totalInJournal} trade tersimpan — rekap penuh di /pnl`);
  }
  out.push('', note(nowWib()));
  return out.join('\n');
}

// ─── wizard steps ──────────────────────────────────────────────────

export function msgPoolStep(tokenLabel?: string): string {
  return [
    hdr('💧 BUKA LP · LANGKAH [1/5] — PILIH POOL'),
    '',
    ...(tokenLabel ? [`Token target: ${bold(esc(tokenLabel))}`, ''] : []),
    bold('Pilih pool terdalam (v3 & v4):'),
    note('pair · protokol · fee · TVL · isi≤ — TVL terbesar di atas'),
  ].join('\n');
}

/** Langkah 2/5 — pilih sisi setoran. */
export function msgStrategyStep(pair: string, baseSym: string, tokenSym: string, price: string | null): string {
  return [
    hdr(`⚙️ PILIH STRATEGI · ${esc(pair)}`),
    '',
    ...(price ? [`Harga pasar: 1 ${esc(tokenSym)} = ${bold(esc(price))} ${esc(baseSym)}`, ''] : []),
    `Setoran satu sisi berarti kamu hanya menaruh ${bold(esc(baseSym))}. Posisimu bekerja seperti limit order pasif: memanen fee sambil menunggu harga ${esc(tokenSym)} turun ke rentangmu, lalu perlahan berubah jadi ${esc(tokenSym)}.`,
    '',
    note('sisi token (jual saat harga naik) menyusul — belum aktif'),
  ].join('\n');
}

export function msgRangeStep(fee: number, poolLabel?: string): string {
  return [
    hdr('📉 BUKA LP · LANGKAH [4/5] — RENTANG'),
    '',
    `Pool: ${bold(poolLabel ? esc(poolLabel) : feeLabel(fee))} ✓`,
    '',
    bold('Seberapa jauh di bawah harga sekarang batas belimu?'),
    note('makin lebar rentang, makin lambat berubah jadi token tapi makin lama memanen fee'),
  ].join('\n');
}

export function msgAmountStep(symbol: string, maxLabel: string, balanceLabel?: string): string {
  return [
    hdr('💵 BUKA LP · LANGKAH [3/5] — NOMINAL'),
    '',
    // Saldo ikut ditampilkan: dulu user memilih buta lalu baru ditolak "KURANG"
    // di kartu 4/4 (satu langkah + satu round-trip terbuang).
    `💰 Saldo dompet · ${bold(esc(balanceLabel ?? '?'))}`,
    `⚠️ Batas maks/tx · ${bold(esc(maxLabel))}`,
    '',
    `💬 Ketik jumlah ${bold(esc(symbol))} langsung di chat:`,
  ].join('\n');
}

export function msgAmountCustom(symbol: string, maxLabel: string, example: string): string {
  return [
    hdr('💵 BUKA LP · NOMINAL'),
    '',
    `💬 Ketik jumlah ${bold(esc(symbol))} (maks ${bold(esc(maxLabel))}).`,
    `contoh · ${code(example)}`,
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
  dryRun: boolean;
}): string {
  const body: string[] = [hdr('📝 TINJAU POSISI LP · LANGKAH [5/5]'), ''];
  if (opts.screenDanger) body.push(`⚠️ ${bold('SCREEN: BAHAYA')} — pertimbangkan batal.`, '');
  else if (opts.screenFailed) body.push(`🟡 ${bold('SCREEN: GAGAL')} — token tak terverifikasi.`, '');
  body.push(
    `🎯 Strategi · ${bold(`Single-Side ${esc(opts.baseSymbol)} (beli saat turun)`)}`,
    `📌 Pair · ${bold(`${esc(opts.baseSymbol)} / ${esc(opts.symbol)}`)} (${feeLabel(opts.fee)})`,
    `🏛️ Protokol · Uniswap v3`,
    `💵 Deposit · ${bold(`${esc(opts.depositAmount)} ${esc(opts.baseSymbol)}`)}${opts.depositUsd ? ` (≈ ${usdPlain(opts.depositUsd)})` : ''}`,
    `🎯 Range · ${bold(`${fmtPct(opts.pctHigh)} → ${fmtPct(opts.pctLow)}`)}${opts.priceLower && opts.priceUpper ? ` (${esc(opts.priceLower)} — ${esc(opts.priceUpper)})` : ''}`,
    `📊 Rate · 1 ${esc(opts.symbol)} = ${esc(opts.currentPrice)} ${esc(opts.baseSymbol)}`,
    `⏳ Status awal · ${italic(`out of range — aktif saat harga ${esc(opts.symbol)} turun ke rentang`)}`,
    '',
    `⚓ Estimasi gas · ~${esc(opts.gasEth)} ETH`,
    `💰 Total perlu · ${bold(esc(String(opts.needLabel)))} (saldo: ${esc(String(opts.balanceLabel))})`,
    '',
  );
  if (opts.costFailed) {
    body.push(`🟡 ${bold('Status')}: saldo belum terverifikasi — RPC biaya gagal. Cek /status dulu.`);
  } else if (opts.shortLabel) {
    body.push(`🔴 ${bold('Status')}: KURANG ${bold(esc(opts.shortLabel))} — top up dulu, lalu ulangi /add.`);
  } else {
    body.push(`🟢 ${bold('Status')}: saldo cukup. Klik konfirmasi untuk kirim transaksi.`);
  }
  body.push(
    '',
    note('PnL LP = fee − impermanent loss. Tak ada SL/TP otomatis — proteksi manual lewat /positions.'),
    note(`${opts.dryRun ? 'DRY RUN — tidak kirim tx' : 'LIVE · konfirmasi = kirim tx'} · ${nowWib()}`),
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
  const body: string[] = [hdr('📝 TINJAU POSISI LP · LANGKAH [5/5]'), ''];
  if (opts.screenDanger) {
    body.push(`⚠️ ${bold('SCREEN: BAHAYA')} — token berisiko. Lanjut hanya jika yakin.`, '');
  } else if (opts.screenFailed) {
    body.push(`🟡 ${bold('SCREEN: GAGAL')} — token TIDAK terverifikasi. Lanjut dgn risiko sendiri.`, '');
  }
  body.push(
    `📌 Pair · ${bold(`${esc(opts.symbol)} / ${esc(opts.baseSymbol)}`)} (${feeLabel(opts.fee)})`,
    `🏛️ Protokol · Uniswap v4 · TVL ${usdCompact(opts.tvlUsd)}`,
    `💵 Deposit · ${bold(`${esc(opts.depositAmount)} ${esc(opts.baseSymbol)}`)}${opts.depositUsd != null ? ` (≈ $${opts.depositUsd.toFixed(2)})` : ''}`,
    `🎯 Range · ${bold(`${fmtPct(opts.rangePctHigh)} → ${fmtPct(opts.rangePctLow)}`)}`,
    '',
    note('single-sided ETH — LP ditaruh di sisi ETH; fee mengalir saat harga bergerak masuk rentang.'),
    note('est. PnL = fee terkumpul − impermanent loss; dipantau live di /positions.'),
    '',
    opts.dryRun
      ? `⚪ ${bold('Status')}: simulasi — tidak mengirim tx on-chain`
      : `🟢 ${bold('Status')}: tersimulasi OK. Klik konfirmasi untuk kirim transaksi.`,
    note(`${opts.dryRun ? 'DRY RUN' : 'LIVE'} · ${nowWib()}`),
  );
  return body.join('\n');
}

/** Pool v4 dipilih tapi base-nya bukan ETH-native (belum didukung utk buka). */
export function msgV4BaseUnsupported(): string {
  return card(`ℹ️ ${title('POOL v4 WETH-BUNGKUS')}`, [
    note('pool v4 ini pakai WETH terbungkus (bukan ETH-native) — belum didukung.'),
    note('pilih pool base ETH-native / USDG (v4) atau pool v3 dari daftar.'),
  ]);
}

export function msgPairPicker(n: number): string {
  return [
    `💧 ${bold('Buka Single-Side Liquidity')}`,
    '',
    'PHILIPS memungkinkanmu menyediakan likuiditas hanya dengan satu token. Posisinya bekerja seperti limit order pasif: kamu memanen fee sambil menunggu harga sampai ke targetmu.',
    '',
    n ? bold('Pilih pasangan yang mau kamu tuju:') : italic('Pool teratas gagal dimuat — pakai "Cari Pair Sendiri".'),
  ].join('\n');
}

export function msgPairCustom(): string {
  return [
    `🔍 ${bold('Cari Pair Sendiri')}`,
    '',
    'Tempel alamat kontrak (CA) token yang kamu incar di chat ini.',
    '',
    note('PHILIPS akan mengauditnya dulu sebelum menawarkan LP.'),
  ].join('\n');
}

export function msgAddlpUsage(): string {
  return card(
    title('USAGE'),
    [
      code('/add_lp <CA>'),
      '',
      note('contoh (EVM address 0x…)'),
      code('/add_lp 0x020bfc65…1018b4'),
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
    `✅ ${bold('Single-Side LP Berhasil Dibuat!')}`,
    '',
    `Posisi ${bold(`#${esc(tokenId)}`)}${pair ? ` · ${bold(esc(pair))}` : ''} sudah aktif.`,
    ...(rangeLabel ? [`Fee mulai terkumpul saat harga masuk rentang ${bold(esc(rangeLabel))}.`] : []),
    '',
    '🔗 Langkah transaksi:',
  ];

  // Daftar langkah RAPAT: tanpa baris kosong antar langkah maupun antara langkah
  // dan hash-nya. Baris kosong hanya memisahkan judul dan footer.
  for (const n of notes) {
    const m = n.match(/^(.*?)\s*\(tx (0x[0-9a-fA-F]+)\)$/);
    out.push(`- ${esc(m ? m[1] : n)}`);
    if (m) out.push(code(m[2]));
  }

  out.push(
    '',
    `💡 ${bold('Tip')}: PHILIPS memantau posisi ini dan mengabari saat masuk/keluar rentang. Pantau kapan saja lewat /positions.`,
    nowWib(),
  );
  return out.join('\n');
}

// ─── /claim_fees & /remove_lp ──────────────────────────────────────

export function msgNoFees(): string {
  return [
    `💵 ${bold('Panen Fee')}`,
    '',
    note('belum ada fee yang bisa dipanen dari posisi aktifmu.'),
  ].join('\n');
}

export function msgClaimPick(rows: Array<{ symbol: string; id: string; label: string }>): string {
  const out = [`💵 ${bold('Panen Fee Belum Diklaim')}`, '', 'Fee dari posisi aktifmu:'];
  rows.forEach((r, i) => out.push(`${i + 1}️⃣ ${bold(esc(r.symbol))} · #${esc(r.id)} — ${bold(esc(r.label))}`));
  out.push(
    '',
    '⚠️ Fee dikirim langsung ke dompetmu. Posisi LP tetap terbuka; hanya butuh sedikit gas.',
  );
  return out.join('\n');
}

export function msgClaimDone(id: string, label: string, txHash: string | null): string {
  return [
    `✅ ${bold('Fee Berhasil Dipanen!')}`,
    '',
    `Posisi ${bold(`#${esc(id)}`)} → ${bold(esc(label))} masuk ke dompetmu.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN — tidak ada transaksi dikirim.')]),
    '',
    note(nowWib()),
  ].join('\n');
}

export function msgRemovePick(rows: Array<{ symbol: string; id: string }>): string {
  const out = [`🗑️ ${bold('Tarik Likuiditas')}`, '', 'Pilih posisi yang mau ditarik:'];
  rows.forEach((r, i) => out.push(`${i + 1}️⃣ ${bold(esc(r.symbol))} · #${esc(r.id)}`));
  return out.join('\n');
}

export function msgRemovePct(id: string): string {
  return [
    `🗑️ ${bold('Tarik Likuiditas')} · #${esc(id)}`,
    '',
    'Berapa banyak yang mau ditarik?',
    '',
    note('25/50/75% menarik sebagian — posisi tetap hidup dan tetap memanen fee.'),
    note('100% menutup posisi sepenuhnya (burn NFT + tukar hasilnya ke ETH).'),
  ].join('\n');
}

export function msgRemoveConfirm(id: string, symbol: string, pct: number, est: string, dryRun: boolean): string {
  return [
    `📝 ${bold('Konfirmasi Penarikan')}`,
    '',
    `Menarik ${bold(`${pct}%`)} dari posisi ${bold(esc(symbol))} · #${esc(id)}.`,
    `Perkiraan keluar: ${bold(esc(est))} + fee yang belum diklaim.`,
    '',
    `Posisi ${bold('tetap terbuka')} dengan sisa ${100 - pct}% likuiditas.`,
    '',
    note(dryRun ? 'DRY RUN — tidak kirim tx' : 'LIVE · konfirmasi = kirim tx, butuh gas'),
  ].join('\n');
}

export function msgRemoveDone(id: string, pct: number, txHash: string | null): string {
  return [
    `✅ ${bold('Penarikan Berhasil')}`,
    '',
    `${bold(`${pct}%`)} likuiditas posisi ${bold(`#${esc(id)}`)} sudah ditarik ke dompetmu, berikut fee yang belum diklaim.`,
    `Sisa ${100 - pct}% masih bekerja di pool.`,
    ...(txHash ? ['', '🔗 Tx:', code(txHash)] : ['', note('DRY RUN — tidak ada transaksi dikirim.')]),
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
