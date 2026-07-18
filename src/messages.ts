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

export function msgStart(dryRun: boolean): string {
  const body = [
    'Single-sided ETH LP di Uniswap v3',
    'Robinhood Chain — full via Telegram.',
    '',
    fieldBlock([
      ['mode', `${modeMark(dryRun)} ${modeLabel(dryRun)}`],
    ]),
    '',
    section('commands'),
    `${code('/status')} · wallet & saldo`,
    `${code('/positions')} · LP aktif`,
    `${code('/history')} · jurnal trade`,
    `${code('/add <CA>')} · buka LP`,
    `${code('/stop')} · tutup & cash-out`,
    `${code('/setsize')} · preset nominal`,
    `${code('/help')} · menu ini`,
    '',
    note('/add & /stop memakai dana on-chain di wallet bot.'),
  ];
  return card(title('PHILIPS', 'LP bot'), body);
}

/** Alias menu — sama dengan /start. */
export function msgHelp(dryRun: boolean): string {
  return msgStart(dryRun);
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
  gasEth: string;
  positions: number;
  maxEthLabel: string;
  wallet: string;
  holdings?: Array<{ symbol: string; amount: string; usd: number | null }>;
}): string {
  const limit =
    opts.maxEthLabel === 'tanpa batas' ? '∞' : opts.maxEthLabel;

  const head: Array<[string, string]> = [
    ['mode', `${modeMark(opts.dryRun)} ${modeLabel(opts.dryRun)}`],
    ['chain', String(opts.chainId)],
    ['open', String(opts.positions)],
    ['limit', limit],
  ];

  const body: string[] = [
    fieldBlock(head),
    '',
    section('saldo'),
    fieldBlock(balanceFields(opts.gasEth)),
  ];

  const h = opts.holdings ?? [];
  body.push('', section('token hold'));
  if (h.length === 0) {
    body.push(note('tak ada token nyangkut'));
  } else {
    const holdRows: Array<[string, string]> = [];
    let total = 0;
    let hasUsd = false;
    for (const t of h) {
      if (t.usd !== null) {
        total += t.usd;
        hasUsd = true;
        holdRows.push([t.symbol, `${usdPlain(t.usd)}  (${t.amount})`]);
      } else {
        holdRows.push([t.symbol, t.amount]);
      }
    }
    if (hasUsd) holdRows.push(['total', usdPlain(total)]);
    body.push(fieldBlock(holdRows));
  }

  body.push(
    '',
    section('wallet'),
    fieldBlock([['addr', shortAddr(opts.wallet)]]),
  );

  return card(title('STATUS'), body, footerMode(opts.dryRun));
}

export function msgDenied(): string {
  return card(title('DENIED'), [note('kamu tidak berhak memakai bot ini.')]);
}

export function msgError(where: string, err: string): string {
  return card(
    title('ERROR', where),
    [pre(err.slice(0, 900))],
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

export function msgSetSize(): string {
  return card(
    title('PRESET', 'nominal /add'),
    [
      note('tombol cepat di langkah nominal wizard.'),
      '',
      '✏️ ubah · 🗑 hapus · ➕ tambah',
    ],
  );
}

export function msgSetSizePrompt(kind: 'edit' | 'add'): string {
  return card(
    title('PRESET', kind === 'add' ? 'tambah' : 'ubah'),
    [
      note(
        kind === 'add'
          ? 'ketik nominal ETH untuk preset baru'
          : 'ketik nominal ETH baru untuk preset ini',
      ),
      '',
      fieldBlock([['contoh', '0.05']]),
    ],
  );
}

// ─── position cards ────────────────────────────────────────────────

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
}): string {
  const rows: Array<[string, string]> = [
    ['pair', `WETH / ${opts.symbol} · ${feeLabel(opts.fee)}`],
  ];
  if (opts.chain) rows.push(['chain', opts.chain]);
  rows.push(
    ['invest', `${opts.invest} WETH`],
    ['pnl', opts.pnlText],
    ['range', opts.range],
    ['status', opts.inRange ? 'IN RANGE' : 'OUT OF RANGE'],
    ['age', opts.age],
  );
  return card(
    title('POSITION', `#${opts.tokenId}`),
    [fieldBlock(rows)],
    footerMode(opts.dryRun),
  );
}

export function msgPositionGone(tokenId: string, symbol: string): string {
  return card(
    title('CLOSED', `#${tokenId}`),
    [
      fieldBlock([['pair', `WETH / ${symbol}`]]),
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
}): string {
  const rows: Array<[string, string]> = [
    ['pair', `WETH / ${opts.symbol} · ${feeLabel(opts.fee)}`],
  ];
  if (opts.chain) rows.push(['chain', opts.chain]);
  rows.push(
    ['assets', opts.composition],
    ['value', opts.value],
    ['fees', opts.fees],
    ['status', opts.inRange ? 'IN RANGE' : 'OUT OF RANGE'],
  );
  return card(title('DETAIL', `#${opts.tokenId}`), [fieldBlock(rows)], nowUtc());
}

export function msgPositionsHeader(activeCount: number): string {
  return card(
    title('POSITIONS'),
    [fieldBlock([['active', String(activeCount)]])],
  );
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

/** Riwayat trade — 2 baris per entry (hasil + meta). */
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

  const rows: Array<[string, string]> = items.map((r) => {
    const id = `#${r.tokenId}`;
    const head =
      r.reason === 'cashed'
        ? `${r.symbol}  ${pctSigned(r.pnlPct)}  ${(r.pnlEth >= 0 ? '+' : '') + r.pnlEth.toFixed(5)}`
        : `${r.symbol}  ${r.reason.toUpperCase()}`;
    const meta: string[] = [];
    if (r.chain) meta.push(r.chain);
    if (r.ca) meta.push(shortAddr(r.ca));
    if (r.closedAt) meta.push(fmtAge(Date.now() - r.closedAt) + ' ago');
    const tail = meta.length ? `  ·  ${meta.join(' · ')}` : '';
    return [id, head + tail];
  });

  return card(
    title('JOURNAL', `${items.length} trade`),
    [fieldBlock(rows, 8)],
    nowUtc(),
  );
}

// ─── wizard steps ──────────────────────────────────────────────────

export function msgPoolStep(): string {
  return card(
    title('ADD LP', '1/4'),
    [
      section('pilih pool'),
      note('angka = likuiditas WETH — makin besar makin baik'),
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

export function msgAmountStep(maxLabel: string): string {
  return card(
    title('ADD LP', '3/4'),
    [
      section('nominal ETH'),
      fieldBlock([['maks', maxLabel]]),
    ],
  );
}

export function msgAmountCustom(maxLabel: string): string {
  return card(
    title('ADD LP', 'nominal'),
    [
      note(`ketik jumlah ETH (maks ${maxLabel})`),
      `contoh · ${code('0.02')}`,
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
  pctHigh: number;
  pctLow: number;
  currentPrice: string;
  gasEth: string;
  needLabel: string;
  balanceLabel: string;
  shortLabel: string | null;
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
    fieldBlock([
      ['pair', `${opts.baseSymbol} / ${opts.symbol} · ${feeLabel(opts.fee)}`],
      ['deposit', `${opts.depositAmount} ${opts.baseSymbol}`],
      ['range', `${fmtPct(opts.pctHigh)} → ${fmtPct(opts.pctLow)}`],
      ['price', `1 ${opts.symbol} = ${opts.currentPrice} ${opts.baseSymbol}`],
    ]),
    '',
    section('biaya'),
    fieldBlock([
      ['gas', `~${opts.gasEth} ETH`],
      ['perlu', opts.needLabel],
      ['saldo', opts.balanceLabel],
    ]),
  );
  if (opts.shortLabel) {
    body.push(
      '',
      quoteHtml(`${bold('KURANG')} ${esc(opts.shortLabel)} — top up dulu.`),
    );
  } else {
    body.push('', note('saldo cukup'));
  }
  body.push(
    '',
    fieldBlock([['mode', modeLabel(opts.dryRun)]]),
  );
  if (opts.dryRun) {
    body.push(note('simulasi — tidak mengirim tx on-chain'));
  } else {
    body.push(note('live — konfirmasi mengirim tx + aktifkan monitor'));
  }
  return card(title('PREVIEW', '4/4'), body, footerMode(opts.dryRun));
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
    title('NO POOLS'),
    [note('tidak ada pool WETH berlikuiditas untuk token ini.')],
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
    fieldBlock([
      ['position', `#${tokenId}`],
      ['monitor', 'ON'],
    ]),
  ];
  if (notes.length) {
    body.push('', section('notes'));
    for (const n of notes) body.push(`  ${esc(n)}`);
  }
  return card(title('OPENED', `#${tokenId}`), body, nowUtc());
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
    fieldBlock([
      ['pair', `${opts.baseSymbol} / ${opts.symbol} · ${feeLabel(opts.fee)}`],
      ['age', opts.age],
      ['pnl', opts.pnlText],
      ['fees', opts.feeText],
      ['out', `${opts.baseAmt} ${opts.baseSymbol} + ${opts.otherAmt} ${opts.symbol}`],
    ]),
    '',
    note('likuiditas dikembalikan ke wallet.'),
  ];
  return card(title('CLOSE', `#${opts.tokenId}`), body, nowUtc());
}

export function msgStopPick(): string {
  return card(
    title('STOP LP'),
    [note('pilih posisi — tap Tutup pada kartu.')],
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

export function msgClosing(): string {
  return msgProgress('menutup posisi & cash-out ke ETH…');
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
  const rows: Array<[string, string]> = [
    ['position', `#${opts.tokenId}`],
    ['received', opts.ethOut],
  ];
  for (let i = 0; i < opts.txHashes.length; i++) {
    rows.push([i === 0 ? 'tx' : '', shortAddr(opts.txHashes[i])]);
  }
  const body: string[] = [fieldBlock(rows.filter(([l, v]) => l || v))];
  if (opts.notes.length) {
    body.push('', section('notes'));
    for (const n of opts.notes) body.push(`  ${esc(n)}`);
  }
  return card(title('CASHED OUT', `#${opts.tokenId}`), body, nowUtc());
}

// ─── monitor ───────────────────────────────────────────────────────

export function msgRangeEnter(tokenId: string, symbol: string): string {
  return card(
    title('IN RANGE', `#${tokenId}`),
    [
      fieldBlock([['pair', `WETH / ${symbol}`]]),
      note(`ETH mulai konversi ke ${symbol} & panen fee.`),
    ],
    nowUtc(),
  );
}

export function msgRangeExit(tokenId: string, symbol: string, side: 'above' | 'below'): string {
  if (side === 'above') {
    return card(
      title('OUT ↑', `#${tokenId}`),
      [
        fieldBlock([
          ['pair', `WETH / ${symbol}`],
          ['status', 'SAFE'],
        ]),
        note('harga naik keluar rentang — posisi kembali 100% ETH + fee.'),
      ],
      nowUtc(),
    );
  }
  return card(
    title('OUT ↓', `#${tokenId}`),
    [
      fieldBlock([
        ['pair', `WETH / ${symbol}`],
        ['status', 'RISK'],
      ]),
      note(`harga jatuh menembus rentang — ETH sudah 100% jadi ${symbol}.`),
      note('pulih hanya jika harga naik lagi. Pertimbangkan /stop.'),
    ],
    nowUtc(),
  );
}

export function msgCrash(kind: string, err: string): string {
  return card(
    title('CRASH'),
    [
      fieldBlock([['kind', kind]]),
      '',
      pre(err.slice(0, 300)),
      '',
      note('restart otomatis…'),
    ],
    nowUtc(),
  );
}

export function msgInvalidAmount(): string {
  return card(title('INVALID'), [note('masukkan angka ETH valid, mis. 0.02')]);
}

export function msgOverLimit(maxLabel: string): string {
  return card(title('LIMIT'), [note(`melebihi batas ${maxLabel}.`)]);
}
