/**
 * Penjaga logika alur output (audit 30 Agu 2026):
 *  1. every button has a handler, because a dead button is a tap that does nothing;
 *  2. every button handler answers the callback, or Telegram's spinner hangs;
 *  3. every "waiting for input" state joins resetFlows, or an orphan prompt swallows what is typed
 *     berikutnya (persis bug prompt persen & prompt connect).
 */
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.ts') ? [`${d}/${e.name}`] : [],
  );
const files = walk('src');
const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');

// 1) orphan buttons
const emitted = new Set<string>();
for (const m of src.matchAll(/button\.callback\(\s*(?:`[^`]*`|'[^']*'|"[^"]*")\s*,\s*(['"`])([^'"`$]+)\1/g)) emitted.add(m[2]);
for (const m of src.matchAll(/callback_data:\s*(['"])([^'"$]+)\1/g)) emitted.add(m[2]);
const handlers: Array<(s: string) => boolean> = [];
for (const m of src.matchAll(/bot\.action\(\s*(\/(?:[^/\\]|\\.)+\/[a-z]*)/g)) {
  const body = m[1].slice(1, m[1].lastIndexOf('/'));
  const flags = m[1].slice(m[1].lastIndexOf('/') + 1);
  handlers.push((s) => new RegExp(body, flags).test(s));
}
for (const m of src.matchAll(/bot\.action\(\s*(['"])([^'"]+)\1/g)) handlers.push((s) => s === m[2]);
assert.ok(emitted.size > 20, 'the button scanner found nothing, so the pattern must have changed');
const orphans = [...emitted].filter((e) => !handlers.some((h) => h(e))).sort();
assert.deepEqual(orphans, [], `buttons with no handler, where a tap does nothing:\n  ${orphans.join('\n  ')}`);

// 2) handlers that never answer the callback
const silent: string[] = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/bot\.action\(/.test(l)) return;
    let end = i + 1;
    while (end < lines.length && !/^\}\);/.test(lines[end])) end++;
    const body = lines.slice(i, end).join('\n');
    if (!/answerCbQuery|editMessageText|deleteMessage/.test(body)) silent.push(`${f}:${i + 1}`);
  });
}
assert.deepEqual(silent, [], `button handlers that never answer, leaving the spinner to hang:\n  ${silent.join('\n  ')}`);

// 3) state penunggu ketikan wajib ikut dibersihkan resetFlows
const reset = src.match(/registerFlowReset\(\([^)]*\)\s*=>\s*\{[\s\S]*?\n\}\)|registerFlowReset\([^\n]*\)/g)?.join('\n') ?? '';
for (const state of ['flows.delete', 'tswapFlows.delete', 'hubs.delete', 'awaitingSecret.delete', 'clearEdit'])
  assert.ok(reset.includes(state), `state "${state}" is missing from resetFlows, so an orphan prompt swallows what is typed`);

// An abandoned connect prompt must not swallow input that is plainly NOT a key.
assert.match(
  src,
  /if \(awaitingSecret\.has\(ctx\.from\.id\)\) \{\s*if \(looksLikeSecret\(raw\)\)/,
  'the awaitingSecret branch must be filtered through looksLikeSecret first',
);

console.log('smoke-flowlogic OK');
