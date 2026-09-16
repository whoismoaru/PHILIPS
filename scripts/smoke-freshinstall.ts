/**
 * One runnable check for the FIRST boot on a clean machine.
 *
 * `data/` is gitignored, so a fresh clone does not have it. Anything that writes
 * there with a raw writeFileSync throws ENOENT (alerts did, so the first /settings
 * toggle failed) or swallows the error in a catch and silently persists nothing
 * (pctPresets did, so a settings prompt never survived a restart on a new install).
 * Every writer must go through writeJson, which creates the directory.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const f of ['src/alerts.ts', 'src/pctPresets.ts', 'src/v4store.ts', 'src/monitor.ts']) {
  const s = readFileSync(f, 'utf8');
  const raw = [...s.matchAll(/writeFileSync\(([^,)]+)/g)].map((m) => m[1].trim());
  const intoData = raw.filter((a) => /FILE|PENDING|SHAPE|join\(/i.test(a));
  assert.deepEqual(
    intoData,
    [],
    `${f} writes ${intoData.join(', ')} with a raw writeFileSync: on a fresh install data/ does not exist yet. Use writeJson.`,
  );
}

// The helper every one of them depends on must still be the thing that creates it.
const store = readFileSync('src/store.ts', 'utf8');
const wj = store.slice(store.indexOf('export function writeJson'));
assert.ok(/mkdirSync\(/.test(wj.slice(0, 400)), 'writeJson no longer creates data/, so a fresh install breaks again');

console.log('ok: every data/ writer creates the directory it writes into');
