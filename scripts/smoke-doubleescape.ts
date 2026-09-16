/**
 * One runnable check against DOUBLE escaping.
 *
 * bold(), italic() and code() escape their own argument. Wrapping the argument in
 * esc() as well turns a token called "AT&T" into the literal text "AT&amp;T" on the
 * card -- not a crash, so nothing catches it except the reader.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bold, italic, code, esc } from '../src/messages.js';

// 1. The helpers still escape, which is what makes the esc() call redundant.
assert.equal(bold('AT&T'), '<b>AT&amp;T</b>', 'bold no longer escapes: every call site now needs esc()');
assert.equal(italic('a<b'), '<i>a&lt;b</i>');
assert.equal(code('a&b'), '<code>a&amp;b</code>');
// And escaping still happens exactly once.
assert.ok(!bold('AT&T').includes('&amp;amp;'), 'bold double-escapes');
assert.equal(esc('AT&T'), 'AT&amp;T');

// 2. No call site re-escapes -- neither bold(esc(x)) nor bold(`..${esc(x)}..`).
const src = readFileSync('src/messages.ts', 'utf8');
const direct = [...src.matchAll(/\b(bold|italic|code)\(esc\(/g)].map((m) => m[0]);
assert.deepEqual(direct, [], `${direct.length} call site(s) still wrap esc() in a helper that already escapes`);

const nested: string[] = [];
for (const [i, line] of src.split('\n').entries()) {
  for (const m of line.matchAll(/\b(bold|italic|code)\(`/g)) {
    // Walk to the backtick that closes this argument, stepping over ${...}.
    const start = m.index! + m[0].length - 1;
    let j = start + 1, depth = 0;
    while (j < line.length) {
      if (line[j] === '\\') { j += 2; continue; }
      if (line[j] === '`' && depth === 0) break;
      if (line.slice(j, j + 2) === '${') { depth++; j += 2; continue; }
      if (line[j] === '}' && depth) depth--;
      j++;
    }
    const seg = line.slice(start, j + 1);
    if (seg.includes('esc(')) nested.push(`line ${i + 1}: ${seg}`);
  }
}
assert.deepEqual(nested, [], `esc() inside a helper template double-escapes:\n${nested.join('\n')}`);

console.log('ok: every value is escaped exactly once');
