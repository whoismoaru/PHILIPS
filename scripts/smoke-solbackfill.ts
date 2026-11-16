/**
 * Every close through PHILIPS gets a PnL card, including positions it did not open.
 *
 * HUNG 6EH5 (12 Nov 2026) was opened on Meteora with 159,100 HUNG and no SOL. Backfill counted
 * only base arriving in the pool, found 0, and stored no entry; PHILIPS then closed it with no
 * PnL card and nothing in /pnl. The deposit is now read from DLMM's AddLiquidity event, both
 * amounts plus the active bin, and the close backfills an entry before it runs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBase58, toBeArray, encodeBase58 as ethersEncode } from 'ethers';
import { addLiquidityEvents } from '../src/solana/backfill.js';

const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const POS = '6EH5UZwnTr2BtMpkJALMh7MvA56XiAVuCckqtdTTiGZX';
const key = (s: string) => Buffer.from(toBeArray(decodeBase58(s), 32));
const event = (pos: string, x: bigint, y: bigint, active: number) => {
  const d = Buffer.alloc(132);
  Buffer.from('e445a52e51cb9a1d1f5e7d5ae3343dba', 'hex').copy(d, 0);
  key(pos).copy(d, 80);
  d.writeBigUInt64LE(x, 112);
  d.writeBigUInt64LE(y, 120);
  d.writeInt32LE(active, 128);
  return ethersEncode(d).replace(/^0x/, '');
};
const tx = (data: string, programId = DLMM) => ({ meta: { innerInstructions: [{ index: 3, instructions: [{ programId, data }] }] } });

// The real 6EH5 open: 159,100.160881 HUNG (X), 0 SOL (Y), active bin -274.
assert.deepEqual(addLiquidityEvents(tx(event(POS, 159100160881n, 0n, -274)), POS), [[159100160881n, 0n, -274]]);
// Another position's event, another program, or another event kind is ignored.
assert.deepEqual(addLiquidityEvents(tx(event('51KVKo2oMU1DqxUbgNhjrrcrCV1Ve4hh6B3kdxK3mHm2', 1n, 1n, 0)), POS), []);
assert.deepEqual(addLiquidityEvents(tx(event(POS, 1n, 1n, 0), '11111111111111111111111111111111'), POS), []);
assert.deepEqual(addLiquidityEvents(tx(event(POS, 1n, 1n, 0).slice(0, 20)), POS), []);
// Meteora's site opens with RebalanceLiquidity: the real HOGE 4cmC4 Rebalancing event (16 Nov 2026),
// 47,882.680909 HOGE (X) added, 0 SOL, active bin -658.
const rebal =
  'e445a52e51cb9a1d006d75b33d5bc7c84dfd047758b52563d2d561cb60f60854db5c1957083951e4144669ed9370d8d235bc5b0a61fffc2cdb261010a1539752abfda1fdc21ae0d02ebeae044cbd691954b12eaa0362a96e31084b699a2aabff9ba23dc0bd39fd72d8b8b6c8a9aef1b16efdffff00000000000000004dba07260b00000000000000000000000000000000000000000000000000000000000000000000006efdffffb3fdffff6efdffffc4fdffff00000000000000000000000000000000';
const rebalTx = tx(ethersEncode(Buffer.from(rebal, 'hex')).replace(/^0x/, ''));
assert.deepEqual(addLiquidityEvents(rebalTx, '4cmC4MfSK335S9JYAbsZngi3CyyzuS4bX9gHJyN6wVWx'), [[47882680909n, 0n, -658]]);
assert.deepEqual(addLiquidityEvents(rebalTx, POS), [], 'a Rebalancing event of another position');
// Valued at that bin (binStep 200: 1.02^-274 SOL-lamports per HUNG raw unit): ~0.70 SOL.
const sol = (159100160881 * Math.pow(1.02, -274)) / 1e9;
assert.ok(sol > 0.69 && sol < 0.71, `6EH5's deposit priced at ${sol} SOL`);

const src = readFileSync('src/index.ts', 'utf8');
// The close recovers a missing entry BEFORE it runs, so the card and the journal have one.
const run = src.slice(src.indexOf('async function solCloseRun'), src.indexOf('const legs = leg0?.groupId'));
assert.match(run, /if \(!leg0\) \{[\s\S]*backfillSol\(p/, 'a Solana close no longer backfills a missing entry');
// An EVM position with an unknown deposit says so instead of drawing a fake +100% card.
const at = src.indexOf('async function sendProfitCard');
const card = src.slice(at, at + 700);
assert.match(card, /BigInt\(rec\.initialWethWei \|\| '0'\) === 0n/);

console.log('smoke-solbackfill OK');
