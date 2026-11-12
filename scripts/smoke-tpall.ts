/**
 * A market-cap take profit closes every open position of its token in the wallet.
 *
 * It used to be bound to one position id. HUNG, 12 Nov 2026: the TP was set on 51KVKo, that
 * position was closed outside the bot and 6EH5 opened in its place 18s later, and when mcap hit
 * $842K the TP fired at the dead id, failed with "no longer open" and left 6EH5 running. 6EH5
 * also had no store entry (backfill missed it), so its own Take Profit button answered "Expired".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { msgLimitSaved } from '../src/messages.js';

const src = readFileSync('src/index.ts', 'utf8');
const fire = src.slice(src.indexOf('async function fireLimit'), src.indexOf('const lastLine'));

// Market cap: every position of the token. PnL: its own position, whose cost basis it reads.
assert.match(fire, /const refs = l\.metric \? \[l\.posRef\] : await tokenPosRefs\(l\)/, 'a market-cap TP is bound to one position again');
assert.match(fire, /for \(const ref of refs\)/, 'the TP no longer walks every position');
// A leg its ladder already closed is skipped, not reported as a failure.
assert.match(fire, /if \(!v4store\.getV4\(id\)\) continue;/);
assert.match(fire, /if \(store\.get\(id\)\?\.status !== 'ACTIVE'\) continue;/);
assert.match(fire, /\.some\(\(r\) => r\.id === row\)\) continue;/);

// tokenPosRefs covers Solana rows by mint and both EVM stores by token address.
const refs = src.slice(src.indexOf('async function tokenPosRefs'), src.indexOf('async function fireLimit'));
for (const needle of ["r?.mint === l.ca", 'store.active()', 'v4store.allV4()']) assert.ok(refs.includes(needle), `tokenPosRefs lost ${needle}`);

// The Solana TP button works from the row alone; no store entry is required.
const btn = src.slice(src.indexOf("bot.action(/^tp:(v3|v4|sol)"), src.indexOf('limitDrafts.set(ctx.from.id, { type: \'tp\''));
assert.ok(!/if \(ref && e\)/.test(btn), 'the Solana TP button needs a store entry again');
assert.match(btn, /if \(ref\) \[chain, ca, symbol, posRef\] = \['solana', ref\.mint/);

// The card says what will be closed.
const mcap = msgLimitSaved({ kind: 'tp', symbol: 'HUNG', chain: 'solana', posRef: 'sol:51KVKo2oMU1Dq', targetMcap: 650_000 }, 600_000);
assert.match(mcap, /all positions/);
assert.match(mcap, /close every \$HUNG position when mcap ≥/);
const pnl = msgLimitSaved({ kind: 'tp', symbol: 'HUNG', chain: 'solana', posRef: 'sol:51KVKo2oMU1Dq', targetMcap: 0, metric: 'pct', target: 20 }, 5);
assert.match(pnl, /#51KVKo2o/);
assert.ok(!/all positions/.test(pnl), 'a PnL TP claims to close every position');

console.log('smoke-tpall OK');
