import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as pct from '../src/pctPresets.js';

/**
 * A settings prompt must survive a RESTART.
 *
 * "Edit Add LP %" asks for numbers and remembers what they are for. That memory used to be
 * in-process only, so a restart while the owner was typing left the reply to fall through
 * to the UNKNOWN handler -- twice, with no hint of why (16 Sep 2026). Deploys happen while
 * people are mid-sentence; losing their input to one is not acceptable.
 */
const UID = 999_000_111;
pct.clearEdit(UID);
pct.askEdit(UID, 'add');
assert.equal(pct.pendingEdit(UID), 'add', 'the prompt was not recorded at all');

const FILE = 'data/pctpending.json';
assert.ok(existsSync(FILE), 'the prompt is not written to disk, so a restart still loses it');
const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Array<[number, { flow: string; at: number }]>;
const row = saved.find(([u]) => u === UID);
assert.ok(row, 'this prompt is missing from the file');
assert.equal(row![1].flow, 'add', 'the file records the wrong flow');
// The timestamp travels with it: an old prompt must still expire rather than come back to
// life days later and swallow an unrelated message.
assert.ok(Date.now() - row![1].at < 5_000, 'the prompt carries no usable timestamp');

pct.clearEdit(UID);
assert.equal(pct.pendingEdit(UID), undefined, 'clearing left the prompt behind');
const after = JSON.parse(readFileSync(FILE, 'utf8')) as Array<[number, unknown]>;
assert.ok(!after.some(([u]) => u === UID), 'a cleared prompt is still on disk');

if (!after.length) rmSync(FILE, { force: true });
console.log('ok: a settings prompt survives a restart and still expires on time');
