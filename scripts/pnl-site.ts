/**
 * Situs PnL lintas-chain — SATU berkas HTML mandiri.
 *
 * Sengaja BUKAN server: datanya riwayat trade pribadi, dan membuka port di VPS
 * berarti menaruhnya di internet tanpa autentikasi. Berkas statis bisa dibuka
 * di HP lewat Telegram, disimpan, atau dikirim ke diri sendiri — tanpa satu pun
 * dari itu meninggalkan mesin ini kecuali kau yang mengirimnya.
 *
 * Nilai USD memakai kurs SAAT CLOSE bila entri sudah tercap (`usdRate`); entri
 * lama dinilai kurs sekarang dan dihitung terpisah, supaya tak tertukar dengan
 * angka yang sudah terkunci.
 *
 *   npx tsx scripts/pnl-site.ts [keluaran.html]
 */
import { writeFileSync } from 'node:fs';
import * as journal from '../src/journal.js';
import { CHAINS } from '../src/chains.js';
import { getEthUsd } from '../src/screening.js';

const OUT = process.argv[2] ?? 'data/pnl.html';

// ── kurs sekarang (cadangan untuk entri tanpa cap) ──────────────────────────
const rates = new Map<string, number | null>();
for (const cc of Object.values(CHAINS))
  for (const b of cc.bases) {
    const unit = journal.unitOf(cc.key, b.kind);
    if (rates.has(unit)) continue;
    rates.set(unit, b.kind === 'weth' ? await getEthUsd(cc.wethAddress, cc).catch(() => null) : 1);
  }

type Row = { t: number; usd: number; chain: string; symbol: string; unit: string; capped: boolean };

const me = journal.currentWallet();
const rows: Row[] = [];
let untracked = 0;
let noRate = 0;
for (const e of journal.readMine(Number.MAX_SAFE_INTEGER)) {
  if (e.resultEthWei === undefined || BigInt(e.resultEthWei) === 0n) {
    untracked++;
    continue;
  }
  const unit = journal.unitOf(e.chain, e.baseKind);
  const rate = e.usdRate ?? rates.get(unit) ?? null;
  if (rate === null) {
    noRate++;
    continue;
  }
  rows.push({
    t: e.closedAt,
    usd: e.pnlEth * rate,
    chain: e.chain ?? 'robinhood',
    symbol: e.symbol,
    unit,
    capped: e.usdRate !== undefined,
  });
}
rows.sort((a, b) => a.t - b.t);

// ── agregat ────────────────────────────────────────────────────────────────
const EPS = 0.1; // di bawah ini bukan menang & bukan kalah — cuma debu (lihat FLAT_EPS)
const wins = rows.filter((r) => r.usd > EPS);
const losses = rows.filter((r) => r.usd < -EPS);
const flats = rows.length - wins.length - losses.length;
const net = rows.reduce((a, r) => a + r.usd, 0);
const grossWin = wins.reduce((a, r) => a + r.usd, 0);
const grossLoss = losses.reduce((a, r) => a + r.usd, 0);
const wr = wins.length + losses.length > 0 ? (wins.length / (wins.length + losses.length)) * 100 : 0;
const pf = grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null;
const estimated = rows.filter((r) => !r.capped).length;

const by = <K extends string>(key: (r: Row) => K) => {
  const m = new Map<K, { net: number; n: number; w: number; l: number }>();
  for (const r of rows) {
    const k = key(r);
    const v = m.get(k) ?? { net: 0, n: 0, w: 0, l: 0 };
    v.net += r.usd;
    v.n++;
    if (r.usd > EPS) v.w++;
    else if (r.usd < -EPS) v.l++;
    m.set(k, v);
  }
  return [...m.entries()].sort((a, b) => b[1].net - a[1].net);
};

const WIB = 7 * 3_600_000;
const DAY = 86_400_000;
const dayKey = (ms: number) => Math.floor((ms + WIB) / DAY);
const perDay = by((r) => String(dayKey(r.t)) as string);
const daily = perDay
  .map(([k, v]) => ({ d: Number(k), net: v.net, n: v.n }))
  .sort((a, b) => a.d - b.d);

// kurva kumulatif harian, hari kosong tetap punya titiknya
const kurva: Array<{ d: number; cum: number }> = [];
if (daily.length) {
  let cum = 0;
  const m = new Map(daily.map((x) => [x.d, x.net]));
  for (let d = daily[0].d; d <= daily[daily.length - 1].d; d++) {
    cum += m.get(d) ?? 0;
    kurva.push({ d, cum });
  }
}

// ── render ─────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;
const plain = (n: number) => `$${n.toFixed(2)}`;
const tgl = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const chainLabel = (k: string) => CHAINS[k]?.label ?? k;

const sparkline = (): string => {
  if (kurva.length < 2) return '<p class="muted">Belum cukup data untuk kurva.</p>';
  const W = 900;
  const H = 220;
  const lo = Math.min(0, ...kurva.map((p) => p.cum));
  const hi = Math.max(0, ...kurva.map((p) => p.cum));
  const span = hi - lo || 1;
  const x = (i: number) => (i / (kurva.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const pts = kurva.map((p, i) => `${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(' ');
  const zero = y(0).toFixed(1);
  const naik = kurva[kurva.length - 1].cum >= 0;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Kurva PnL kumulatif">
      <polyline points="0,${zero} ${W},${zero}" class="zero"/>
      <polygon points="0,${zero} ${pts} ${W},${zero}" class="${naik ? 'fill-up' : 'fill-dn'}"/>
      <polyline points="${pts}" class="${naik ? 'line-up' : 'line-dn'}"/>
    </svg>
    <div class="axis"><span>${tgl(kurva[0].d)}</span><span>${tgl(kurva[kurva.length - 1].d)}</span></div>`;
};

const bars = (): string => {
  if (!daily.length) return '';
  const max = Math.max(...daily.map((x) => Math.abs(x.net))) || 1;
  return daily
    .map(
      (x) =>
        `<div class="bar" title="${tgl(x.d)} · ${money(x.net)} · ${x.n} trade"><i class="${x.net >= 0 ? 'up' : 'dn'}" style="height:${Math.max(2, (Math.abs(x.net) / max) * 100)}%"></i></div>`,
    )
    .join('');
};

const tabel = (judul: string, data: Array<[string, { net: number; n: number; w: number; l: number }]>, label: (k: string) => string, limit = 100) =>
  `<h2>${judul}</h2>
   <table><thead><tr><th>Nama</th><th class="r">PnL</th><th class="r">Trade</th><th class="r">W/L</th><th class="r">Winrate</th></tr></thead><tbody>
   ${data
     .slice(0, limit)
     .map(([k, v]) => {
       const w = v.w + v.l > 0 ? ((v.w / (v.w + v.l)) * 100).toFixed(0) + '%' : '—';
       return `<tr><td>${esc(label(k))}</td><td class="r ${v.net >= 0 ? 'up' : 'dn'}">${money(v.net)}</td><td class="r">${v.n}</td><td class="r">${v.w}/${v.l}</td><td class="r">${w}</td></tr>`;
     })
     .join('')}
   </tbody></table>`;

const perChain = by((r) => r.chain);
const perToken = by((r) => r.symbol);
const terbaru = [...rows].reverse().slice(0, 50);

const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PHILIPS · PnL</title>
<style>
:root{--bg:#0b0f14;--card:#121821;--line:#1e2733;--text:#e6edf3;--muted:#8b98a5;--up:#3fb950;--dn:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px 16px 64px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:14px;letter-spacing:.18em;color:var(--muted);font-weight:600;margin:0 0 24px}
h2{font-size:13px;letter-spacing:.14em;color:var(--muted);font-weight:600;margin:40px 0 12px;text-transform:uppercase}
.big{font-size:clamp(38px,9vw,64px);font-weight:700;letter-spacing:-.02em;line-height:1.05;margin:0}
.sub{color:var(--muted);margin:6px 0 0}
.up{color:var(--up)}.dn{color:var(--dn)}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card b{display:block;font-size:11px;letter-spacing:.12em;color:var(--muted);font-weight:600;margin-bottom:6px}
.card span{font-size:20px;font-weight:600}
svg{width:100%;height:220px;display:block;background:var(--card);border:1px solid var(--line);border-radius:12px}
.zero{stroke:var(--line);stroke-width:1;fill:none}
.line-up{stroke:var(--up);stroke-width:2;fill:none}.line-dn{stroke:var(--dn);stroke-width:2;fill:none}
.fill-up{fill:rgba(63,185,80,.12);stroke:none}.fill-dn{fill:rgba(248,81,73,.12);stroke:none}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}
.bars{display:flex;align-items:flex-end;gap:3px;height:110px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}
.bar{flex:1;height:100%;display:flex;align-items:flex-end;min-width:2px}
.bar i{display:block;width:100%;border-radius:2px}
.bar i.up{background:var(--up)}.bar i.dn{background:var(--dn)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line);font-size:14px}
th{font-size:11px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;font-weight:600}
tbody tr:last-child td{border-bottom:0}
.r{text-align:right;font-variant-numeric:tabular-nums}
footer{color:var(--muted);font-size:12px;margin-top:40px;border-top:1px solid var(--line);padding-top:16px}
@media(max-width:560px){td,th{padding:8px 10px;font-size:13px}}
</style></head><body><div class="wrap">
<h1>PHILIPS · PnL</h1>
<p class="big ${net >= 0 ? 'up' : 'dn'}">${money(net)}</p>
<p class="sub">${rows.length} trade tertutup · ${Object.keys(CHAINS).length} chain · semua nilai USD</p>

<div class="grid">
  <div class="card"><b>Winrate</b><span>${wr.toFixed(1)}%</span></div>
  <div class="card"><b>Menang / Kalah</b><span>${wins.length} / ${losses.length}</span></div>
  <div class="card"><b>Profit factor</b><span>${pf === null ? '—' : pf.toFixed(2)}</span></div>
  <div class="card"><b>Profit kotor</b><span class="up">${plain(grossWin)}</span></div>
  <div class="card"><b>Rugi kotor</b><span class="dn">${plain(Math.abs(grossLoss))}</span></div>
  <div class="card"><b>Impas</b><span>${flats}</span></div>
</div>

<h2>Kurva kumulatif</h2>
${sparkline()}

<h2>PnL harian</h2>
<div class="bars">${bars()}</div>

${tabel('Per chain', perChain, chainLabel)}
${tabel('Per token', perToken, (k) => k, 40)}

<h2>50 trade terakhir</h2>
<table><thead><tr><th>Waktu (WIB)</th><th>Token</th><th>Chain</th><th class="r">PnL</th></tr></thead><tbody>
${terbaru
  .map(
    (r) =>
      `<tr><td>${new Date(r.t + WIB).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${esc(r.symbol)}</td><td>${esc(chainLabel(r.chain))}</td><td class="r ${r.usd >= 0 ? 'up' : 'dn'}">${money(r.usd)}</td></tr>`,
  )
  .join('')}
</tbody></table>

<footer>
Dompet ${esc(me ?? '—')}<br>
Nilai USD dikunci pada kurs saat trade ditutup${estimated ? `; ${estimated} entri lama dinilai dengan kurs hari ini` : ''}.<br>
Tak dihitung: ${untracked} hasil tak terukur${noRate ? ` · ${noRate} tanpa kurs USD` : ''}. Impas = di bawah ±$${EPS.toFixed(2)}, tak masuk winrate.<br>
Dibuat ${new Date(Date.now() + WIB).toISOString().slice(0, 16).replace('T', ' ')} WIB · data lokal, tidak dikirim ke mana pun.
</footer>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`${OUT} — ${rows.length} trade · net ${money(net)} · ${(html.length / 1024).toFixed(0)} KB`);
