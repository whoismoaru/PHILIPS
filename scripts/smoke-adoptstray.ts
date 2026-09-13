import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A ladder open that fails AFTER the transaction lands must still adopt its positions.
 *
 * 29 Aug 2026: the RPC answered 503 right at open. Reading the starting id failed, and
 * because adoption depended on that id, it gave up without trying: eight positions were
 * born on chain with no record and stayed missing from /positions until adopted by hand.
 */
const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
const fn = src.slice(src.indexOf('async function adoptStrayV4'), src.indexOf('/** The detail card for one v4 position'));

// The id read is retried rather than attempted once and abandoned.
assert.ok(/for \(let i = 0; i < 3 && to === null; i\+\+\)/.test(fn), 'the nextTokenId read is never retried');
// With no starting id, step back one window rather than come home empty-handed.
assert.ok(/const start = from \?\? \(to > window \? to - window : 0n\)/.test(fn), 'there is no path for a missing starting id');
// Anything already recorded is not stray: adopting it again drags in another group's positions.
assert.ok(/ids\.filter\(\(id\) => !v4store\.getV4\(id\)\)/.test(fn), 'an already-recorded position can be adopted twice');
// The caller may no longer skip adoption just because the starting id failed to read.
assert.ok(!/idBefore !== null \? await adoptStrayV4/.test(src), 'adoption still depends on the starting id');

console.log('ok: adoption still runs even when the id read fails.');
