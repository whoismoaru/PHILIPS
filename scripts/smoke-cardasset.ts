/**
 * One runnable check that the card's DESIGN ships with the code.
 *
 * The backdrop used to live in data/, which .gitignore excludes. On the machine it was
 * built on everything looked right; on a fresh clone the file was simply absent, the
 * renderer fell back to its gradient, and every PnL card came out plain. The fallback is
 * deliberate -- a close must never fail over decoration -- which is exactly why nothing
 * ever reported an error.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const src = readFileSync('src/card.ts', 'utf8');
const m = src.match(/const BG_FILE = join\(process\.cwd\(\), '([^']+)', '([^']+)'\)/);
assert.ok(m, 'BG_FILE is no longer a join() of a directory and a file');
const [, dir, file] = m!;
assert.notEqual(dir, 'data', 'the shipped backdrop is back in data/, which git does not track');
assert.ok(existsSync(`${dir}/${file}`), `the backdrop ${dir}/${file} is missing from the working tree`);

// Tracked by git is the actual requirement: present locally proves nothing.
const tracked = execFileSync('git', ['ls-files', `${dir}/${file}`], { encoding: 'utf8' }).trim();
assert.equal(tracked, `${dir}/${file}`, `${dir}/${file} is not tracked by git, so a fresh clone renders a bare gradient`);

// The owner's own upload still wins, and still lives in data/ where it is private.
assert.ok(/BG_CUSTOM = join\(process\.cwd\(\), 'data', 'pnl-bg\.jpg'\)/.test(src), "the owner's backdrop override moved or vanished");
assert.ok(
  src.indexOf('customBackground() ? BG_CUSTOM : BG_FILE') > 0,
  'the custom backdrop must still take precedence over the shipped one',
);

console.log(`ok: ${dir}/${file} ships with the repo and the owner's own upload still wins`);
