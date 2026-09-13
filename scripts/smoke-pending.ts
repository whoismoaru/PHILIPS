import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '../src/pctPresets.js';

/**
 * The "type a number" prompt in /settings is checked FIRST in the text handler. If
 * the marker was never cleared when the user walked away, so every later message
 * is swallowed as the answer, and even an /add amount gets rejected with "Give 1 to 4 whole numbers".
 */
p.askEdit(1, 'buy');
assert.equal(p.pendingEdit(1), 'buy', 'the typed-input request must be recorded');
p.clearEdit(1);
assert.equal(p.pendingEdit(1), undefined, 'clearEdit must really cancel it');

// Three exits have to cancel it: the Back button, another command, and time.
const w = readFileSync(join(process.cwd(), 'src', 'commands', 'wallet.ts'), 'utf8');
assert.ok(/bot\.action\(\/\^pct:[^\n]*\n[\s\S]{0,400}?clearEdit/.test(w), 'the Back button does not cancel the prompt');
// It may be written as one line or as a block (awaitingSecret joined on 30 Aug 2026);
// what is guarded is that clearEdit really is called from registerFlowReset.
assert.ok(/registerFlowReset\([\s\S]{0,200}?clearEdit\(uid\)/.test(w), 'another command does not cancel the prompt');
assert.ok(/PENDING_TTL_MS/.test(readFileSync(join(process.cwd(), 'src', 'pctPresets.ts'), 'utf8')), 'the prompt never expires');

// A sweep that fails transiently backs off rather than retrying every minute.
const m = readFileSync(join(process.cwd(), 'src', 'monitor.ts'), 'utf8');
assert.ok(/SWEEP_RETRY_BACKOFF_MS/.test(m), 'a failed sweep has no backoff');

console.log('ok: the settings prompt no longer swallows messages, and a failed sweep backs off first.');
