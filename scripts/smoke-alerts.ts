import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/monitor.ts', import.meta.url), 'utf8').split('\n');

const directSends = src
  .map((l, i) => [i + 1, l.trim()] as const)
  .filter(([, l]) => l.includes('bot.telegram.sendMessage'));
assert.equal(directSends.length, 1,
  'the monitor must hold EXACTLY ONE bot.telegram.sendMessage, inside notify(); ' +
  'everything else has to go through notify(bot, flag, ...):\n' + directSends.map(([n, l]) => `line ${n}: ${l}`).join('\n'));

const isiNotify = src.join('\n').match(/async function notify\([\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(/alerts\.get\(\)\[flag\]/.test(isiNotify) && /return;/.test(isiNotify),
  'notify() no longer checks /alerts, so the fence leaks');

const validFlag = /await notify\(bot, (null|'rangeNotify'|'dropPct'|'ilPct')/;
const calls = src.map((l, i) => [i + 1, l.trim()] as const).filter(([, l]) => l.startsWith('await notify('));
const badFlags = calls.filter(([, l]) => !validFlag.test(l)).map(([n, l]) => `line ${n}: ${l}`);
assert.deepEqual(badFlags, [], 'notify calls with an unknown flag:\n' + badFlags.join('\n'));
assert.ok(calls.length >= 9, `only ${calls.length} notify calls: has one gone missing?`);

const text = src.join('\n');
for (const [name, pattern] of [
  ['v3 lastInRange is updated unconditionally',
   /store\.update\(rec\.tokenId, \{ lastInRange: d\.inRange \}\);\n\s*\} catch/],
  ['v3 dropTier resets when dropPct is switched off',
   /\} else if \(rec\.dropTier \|\| rec\.dropAlerted\) \{/],
  ['v3 ilAlerted resets when ilPct is switched off',
   /\} else if \(rec\.ilAlerted\) \{/],
  ['v4 setV4InRange is called before the fence',
   /const changed = [^\n]*setV4InRange/],
] as const) {
  assert.ok(pattern.test(text), `the alert state can freeze: ${name}`);
}

const { dropPctFromTick } = await import('../src/monitor.js');
const dekat = (a: number, b: number, tol = 0.05) =>
  assert.ok(Math.abs(a - b) < tol, `${a.toFixed(4)} != ${b.toFixed(4)}`);

dekat(dropPctFromTick(331168, 331168, true), 0);            
dekat(dropPctFromTick(331168 + 1054, 331168, true), 10.0);  
dekat(dropPctFromTick(331168 - 383, 331168, true), -3.90);  

dekat(dropPctFromTick(331168 - 1054, 331168, false), 10.0);
dekat(dropPctFromTick(331168 + 1054, 331168, false), -11.11);

assert.ok(dropPctFromTick(1000, 0, true) > 0, 'a dip must read positive');
assert.ok(dropPctFromTick(-1000, 0, true) < 0, 'a price rise must not trigger a drop alert');

console.log('smoke-alerts: LULUS');
