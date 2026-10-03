/**
 * Price chart for an open position: GeckoTerminal candles, drawn to a PNG.
 *
 * Charts the TOKEN, not the position's own pool: GeckoTerminal is asked for the token's
 * deepest pool and its candles priced in USD. One path for v3, v4 and any chain the
 * index covers, with no pool address to store. Free, no key; gecko.get carries the
 * 429 bench, so a rate-limited tap answers "try again" instead of hammering.
 */
import { createCanvas } from '@napi-rs/canvas';
import { get } from './gecko.js';
import { ensureFonts } from './card.js';

export const TIMEFRAMES = { '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1] } as const;
export type Tf = keyof typeof TIMEFRAMES;
const NET: Record<string, string> = { robinhood: 'robinhood', bsc: 'bsc', base: 'base', hyperevm: 'hyperevm', arc: 'arc', ink: 'ink', solana: 'solana' };

const C = { canvas: '#0B0E14', surface: '#111725', grid: '#1B2333', ink: '#E6EDF3', muted: '#8B949E', profit: '#3FB950', loss: '#F85149' };

type Candle = [t: number, o: number, h: number, l: number, c: number, v: number];

export type ChartData = { candles: Candle[]; poolName: string };

/** null = no index for this chain, no pool, or GeckoTerminal is down/benched. */
export async function fetchCandles(chain: string, token: string, tf: Tf): Promise<ChartData | null> {
  const net = NET[chain];
  if (!net) return null;
  const pools = await get(`/networks/${net}/tokens/${token}/pools?page=1`);
  const top = (pools?.data ?? []).sort((a: any, b: any) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0))[0];
  if (!top) return null;
  const pool = String(top.attributes?.address ?? top.id.split('_').pop());
  const [unit, agg] = TIMEFRAMES[tf];
  const r = await get(`/networks/${net}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=96&currency=usd&token=${token}`);
  const list: Candle[] = (r?.data?.attributes?.ohlcv_list ?? []).map((x: number[]) => x.map(Number)).reverse();
  return list.length >= 2 ? { candles: list, poolName: String(top.attributes?.name ?? '') } : null;
}

const fmtPrice = (p: number): string => (p >= 1 ? p.toFixed(p >= 1000 ? 0 : 2) : p.toPrecision(4));

/** The LP range as % from the current price (the card's own figures): upper and lower edge. */
export type RangePct = { hi: number; lo: number };

export function renderChart(d: ChartData, title: string, tf: Tf, range?: RangePct): Buffer {
  ensureFonts();
  const W = 1200, H = 630, padL = 30, padR = 130, padT = 90, padB = 50;
  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = C.canvas;
  g.fillRect(0, 0, W, H);

  const cs = d.candles;
  const last = cs[cs.length - 1][4];
  let hi = Math.max(...cs.map((c) => c[2]));
  let lo = Math.min(...cs.map((c) => c[3]));
  // Range edges join the scale only when near the candles: a -90% edge would flatten
  // every candle into a line. A far edge is pinned to the frame with its label instead.
  const edges = range ? [last * (1 + range.hi / 100), last * (1 + range.lo / 100)] : [];
  const reach = (hi - lo || last) * 1.5;
  for (const e of edges) if (e <= hi + reach && e >= lo - reach) { hi = Math.max(hi, e); lo = Math.min(lo, e); }
  const span = hi - lo || hi || 1;
  const y = (p: number) => padT + ((hi - p) / span) * (H - padT - padB);
  const step = (W - padL - padR) / cs.length;

  g.font = '20px PhMono';
  g.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const p = hi - (span * i) / 4;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(padL, y(p));
    g.lineTo(W - padR, y(p));
    g.stroke();
    g.fillStyle = C.muted;
    g.fillText(`$${fmtPrice(p)}`, W - padR + 10, y(p) + 7);
  }

  cs.forEach(([, o, h, l, c], i) => {
    const x = padL + i * step + step / 2;
    g.strokeStyle = g.fillStyle = c >= o ? C.profit : C.loss;
    g.beginPath();
    g.moveTo(x, y(h));
    g.lineTo(x, y(l));
    g.stroke();
    g.fillRect(x - step * 0.35, Math.min(y(o), y(c)), step * 0.7, Math.max(1, Math.abs(y(o) - y(c))));
  });

  if (range) {
    const yy = edges.map((e) => Math.min(H - padB, Math.max(padT, y(e))));
    g.fillStyle = 'rgba(63,185,80,0.07)';
    g.fillRect(padL, yy[0], W - padL - padR, yy[1] - yy[0]);
    g.font = '18px PhSansB';
    g.textAlign = 'left';
    [range.hi, range.lo].forEach((pct, i) => {
      const pinned = yy[i] !== y(edges[i]);
      g.strokeStyle = g.fillStyle = C.ink;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(padL, yy[i]);
      g.lineTo(W - padR, yy[i]);
      g.stroke();
      g.lineWidth = 1;
      const tag = `${i ? 'LOW' : 'HIGH'} $${fmtPrice(edges[i])} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)${pinned ? (i ? ' ↓' : ' ↑') : ''}`;
      g.fillText(tag, padL + 8, yy[i] + (i ? -8 : 22));
    });
  }

  const first = cs[0][1];
  const chg = ((last - first) / first) * 100;
  const tone = chg >= 0 ? C.profit : C.loss;
  g.setLineDash([6, 6]);
  g.strokeStyle = tone;
  g.beginPath();
  g.moveTo(padL, y(last));
  g.lineTo(W - padR, y(last));
  g.stroke();
  g.setLineDash([]);

  g.fillStyle = C.ink;
  g.font = '34px PhSansB';
  g.fillText(title, padL, 50);
  g.font = '22px PhSans';
  g.fillStyle = C.muted;
  g.fillText(`${d.poolName} · ${tf}`, padL, 78);
  g.textAlign = 'right';
  g.font = '34px PhSansB';
  g.fillStyle = tone;
  g.fillText(`$${fmtPrice(last)}  ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`, W - 30, 50);
  g.font = '18px PhMono';
  g.fillStyle = C.muted;
  g.fillText('GeckoTerminal', W - 30, H - 16);
  return cv.toBuffer('image/png');
}
