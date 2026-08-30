/**
 * Penjaga logika alur output (audit 30 Agu 2026):
 *  1. tiap tombol punya handler — tombol mati = tap yang tak mengerjakan apa pun;
 *  2. tiap handler tombol menjawab callback — kalau tidak, spinner Telegram menggantung;
 *  3. tiap state "menunggu ketikan" ikut resetFlows — prompt yatim menelan ketikan
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

// 1) tombol yatim
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
assert.ok(emitted.size > 20, 'pemindai tombol tak menemukan apa-apa — polanya berubah');
const yatim = [...emitted].filter((e) => !handlers.some((h) => h(e))).sort();
assert.deepEqual(yatim, [], `tombol tanpa handler (tap tak berbuat apa-apa):\n  ${yatim.join('\n  ')}`);

// 2) handler yang tak menjawab callback
const bisu: string[] = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/bot\.action\(/.test(l)) return;
    let end = i + 1;
    while (end < lines.length && !/^\}\);/.test(lines[end])) end++;
    const body = lines.slice(i, end).join('\n');
    if (!/answerCbQuery|editMessageText|deleteMessage/.test(body)) bisu.push(`${f}:${i + 1}`);
  });
}
assert.deepEqual(bisu, [], `handler tombol tanpa jawaban (spinner menggantung):\n  ${bisu.join('\n  ')}`);

// 3) state penunggu ketikan wajib ikut dibersihkan resetFlows
const reset = src.match(/registerFlowReset\(\([^)]*\)\s*=>\s*\{[\s\S]*?\n\}\)|registerFlowReset\([^\n]*\)/g)?.join('\n') ?? '';
for (const state of ['flows.delete', 'tswapFlows.delete', 'hubs.delete', 'awaitingSecret.delete', 'clearEdit'])
  assert.ok(reset.includes(state), `state "${state}" tak ikut resetFlows — prompt yatim menelan ketikan`);

// Prompt connect yang ditinggalkan tak boleh menelan ketikan yang jelas BUKAN kunci.
assert.match(
  src,
  /if \(awaitingSecret\.has\(ctx\.from\.id\)\) \{\s*if \(looksLikeSecret\(raw\)\)/,
  'cabang awaitingSecret harus disaring looksLikeSecret dulu',
);

console.log('smoke-flowlogic OK');
