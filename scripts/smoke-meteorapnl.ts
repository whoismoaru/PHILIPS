import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickPnl } from '../src/solana/meteora.js';

/**
 * A PnL take profit on a DLMM position fires on the number Meteora's own app shows (USD). The
 * bot's SOL-based figure said +5.91% for Mandy 6LTBaj (19 Nov 2026) where Meteora showed
 * +5.58%: deposits $124.82, withdrawals $122.23, fees $9.55, pnlUsd $6.96.
 */
const POS = '6LTBaj8UcPpFd8t5i7bgRsJUmfVX4WbFu6gxgJjxh1Li';
const body = {
  totalCount: 2,
  positions: [
    { positionAddress: '655pSFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', pnlUsd: '0.70', pnlPctChange: '18.9' },
    { positionAddress: POS, pnlUsd: '6.961', pnlPctChange: '5.58', pnlSol: 0.0904, pnlSolPctChange: 5.41 },
  ],
};
// The USD pair, not the SOL one, and picked by position address.
assert.deepEqual(pickPnl(body, POS), { pct: 5.58, usd: 6.961 });
// Not listed, an empty or broken body, or a blank figure: no number at all, never a 0.
assert.equal(pickPnl(body, 'nope'), null);
assert.equal(pickPnl({}, POS), null);
assert.equal(pickPnl(null, POS), null);
assert.equal(pickPnl({ positions: [{ positionAddress: POS, pnlUsd: '', pnlPctChange: '' }] }, POS), null);
assert.equal(pickPnl({ positions: [{ positionAddress: POS, pnlUsd: '1', pnlPctChange: 'abc' }] }, POS), null);
// Numbers as numbers are fine too, a loss included.
assert.deepEqual(pickPnl({ positions: [{ positionAddress: POS, pnlUsd: -3.5, pnlPctChange: -2.1 }] }, POS), { pct: -2.1, usd: -3.5 });

// --- wiring: a Solana position's PnL asks Meteora first, and falls back to dollars ---
const idx = readFileSync('src/index.ts', 'utf8');
const fn = idx.slice(idx.indexOf('async function posPnl'), idx.indexOf('async function limitNow'));
const sol = fn.slice(fn.indexOf("k === 'sol'"));
assert.ok(sol.indexOf('meteoraPnl(') >= 0 && sol.indexOf('meteoraPnl(') < sol.indexOf('solanaRows()'), 'Meteora must be asked before the own reading');
assert.ok(/entryUsd/.test(sol), 'the fallback must count the deposit at the SOL price it went in at');

console.log('ok: a DLMM PnL take profit reads Meteora\'s own USD figure, and falls back to dollars');
