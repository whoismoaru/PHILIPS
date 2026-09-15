import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Refresh on the pool card re-reads POOLS. Nothing else.
 *
 * It used to call continueAddlp with no screening verdict, so the audit ran again and a
 * fresh screening card landed on top of the list at every tap (15 Sep 2026). A token's
 * contract cannot change between two taps a minute apart; only its TVL, volume and APR
 * can, and those are the whole reason the button exists.
 */
const src = readFileSync('src/index.ts', 'utf8');
const handler = src.slice(src.indexOf("bot.action('pool:refresh'"), src.indexOf("bot.action('pool:refresh'") + 900);

assert.match(handler, /flow\.screenBahaya/, 'refresh no longer carries the screening verdict, so it will re-audit');
assert.match(handler, /bahaya: flow\.screenBahaya, failed: flow\.screenFailed/, 'the verdict must be passed as `pre`');

// The DANGER verdict must still travel: a token judged dangerous has to stay blocked after
// a refresh, never be quietly cleared by passing `false`.
assert.ok(!/bahaya: false/.test(handler), 'refresh hardcodes the verdict as safe');

// And the screening itself must stay gated on `pre` being absent -- that is what makes
// carrying it forward skip the work.
const fn = src.slice(src.indexOf('async function continueAddlp'), src.indexOf('async function continueAddlp') + 1600);
assert.match(fn, /if \(!pre\) \{/, 'continueAddlp no longer skips the audit when a verdict is supplied');
assert.match(fn, /pre \? 'finding pools…' :/, 'the progress line must say which work is actually running');

console.log('ok: refresh re-reads pools and reuses the verdict it already has');
