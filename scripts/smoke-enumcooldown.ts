import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A failing enumeration must not be paid for on every tap.
 *
 * Measured 15 Sep 2026: walletV4TokenIds runs two FULL-RANGE eth_getLogs against a public
 * endpoint. When that endpoint timed out or answered 429, the scan cursor never advanced,
 * so the very next /positions tap re-ran the whole scan -- 8.7 s, then 12.3 s. Every button
 * that touches v4 sat behind it.
 *
 * Two rules, and both matter: a hard timeout so no tap can wait indefinitely, and a
 * cool-down so a failure is not retried immediately.
 */
const src = readFileSync('src/uniswapV4.ts', 'utf8');

assert.match(src, /AbortSignal\.timeout\(LOGS_TIMEOUT_MS\)/, 'the log scan can once again hang without limit');
const ms = Number(src.match(/const LOGS_TIMEOUT_MS = ([\d_]+)/)![1].replace(/_/g, ''));
assert.ok(ms > 0 && ms <= 8000, `a ${ms} ms ceiling is too long for a button press`);

assert.match(src, /const ENUM_COOLDOWN_MS = ([\d_]+)/, 'the failed-scan cool-down is gone');
const cool = Number(src.match(/const ENUM_COOLDOWN_MS = ([\d_]+)/)![1].replace(/_/g, ''));
assert.ok(cool >= 30_000, `a ${cool} ms cool-down still lets nearly every tap retry the failure`);

const fn = src.slice(src.indexOf('export async function walletV4TokenIds'), src.indexOf('const signExt24'));
assert.match(fn, /if \(Date\.now\(\) < until\)/, 'the cool-down is never consulted');
// The owner is NOT left in the dark: the list still says it may be incomplete, and the
// bot's own records still answer during the cool-down.
assert.match(fn, /enumDegraded = true;[\s\S]{0,200}return \[\.\.\.ids\];/, 'a cooled-down scan must still report itself degraded');
assert.match(fn, /enumCooldown\.set\(cc\.key, Date\.now\(\) \+ ENUM_COOLDOWN_MS\)/, 'a failure no longer starts the cool-down');
assert.match(fn, /enumCooldown\.delete\(cc\.key\)/, 'a successful scan must clear the cool-down');

console.log(`ok: the v4 scan waits at most ${ms} ms and, after a failure, is not retried for ${cool / 1000}s`);
