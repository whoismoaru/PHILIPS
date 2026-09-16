/**
 * One runnable check that the card's TEXT can be drawn.
 *
 * The card names its own font families (PhSans/PhSansB/PhMono) and registers them from
 * system font files. A server with no fonts installed -- a minimal Ubuntu image, which is
 * what a fresh VPS is -- registered none of them and rendered cards with the artwork and
 * NO TEXT, silently: the failure was caught and dropped so a close never fails over
 * decoration. The installer now installs the fonts, and a failed registration is logged.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const card = readFileSync('src/card.ts', 'utf8');

// Every font the card asks for must be named somewhere the installer also installs.
const paths = [...card.matchAll(/reg\(\s*[`']([^`']+)[`']/g)].map((m) => m[1].replace('${DEJAVU}', '/usr/share/fonts/truetype/dejavu'));
assert.ok(paths.length >= 3, `only ${paths.length} font registrations found; the card needs sans, bold and mono`);

const sh = readFileSync('philips.sh', 'utf8');
assert.ok(/FONT_PKGS=\(/.test(sh), 'the installer no longer installs the card fonts');
for (const pkg of ['fonts-liberation', 'fonts-dejavu'])
  assert.ok(sh.includes(pkg), `${pkg} is not installed by the installer, so cards render without text`);
assert.ok(/FONT_PROBE/.test(sh) && /\[ -f "\$FONT_PROBE" \]/.test(sh), 'the installer must check whether the fonts are actually there');

// A registration that fails must SAY so; silence is what hid this for good.
assert.ok(
  /font not registered/.test(card),
  'a failed font registration is silent again: a server with no fonts will draw blank cards and log nothing',
);

// On this machine they must genuinely resolve, or the cards built here are already bare.
for (const p of paths) assert.ok(existsSync(p), `font file missing: ${p}`);

console.log(`ok: ${paths.length} card fonts resolve, the installer installs them, and a failure is logged`);
