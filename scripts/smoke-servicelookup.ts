/**
 * One runnable check on how the installer finds its own service.
 *
 * It used to read /etc/systemd/system/<name>.service by hand with `grep -oP`. That
 * answered "does not exist" for three different situations -- a unit living somewhere
 * else (/lib, /usr/lib, a drop-in), a grep built without PCRE, and a genuinely missing
 * file -- so a running install was told to reinstall itself, and Follow-the-log,
 * Restart and Stop all refused to work. systemd is the authority on its own units.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sh = readFileSync('philips.sh', 'utf8');

assert.ok(!/grep -oP/.test(sh), 'grep -oP is back: it needs PCRE, which a minimal image may not have');
assert.ok(
  !/\/etc\/systemd\/system\/\$\{?1\}?\.service/.test(sh),
  'the unit path is being built by hand again; a unit outside /etc/systemd/system then reads as missing',
);

const dir = sh.slice(sh.indexOf('function service_dir'), sh.indexOf('function assert_ours'));
assert.ok(/systemctl show -p WorkingDirectory --value/.test(dir), 'service_dir must ask systemd where the unit runs');
assert.ok(/systemctl show -p FragmentPath --value/.test(dir), 'service_exists must ask systemd whether the unit is there');

// Existence and location are separate questions: a unit with no WorkingDirectory still
// exists, and must not be reported as missing.
const ours = sh.slice(sh.indexOf('function assert_ours'), sh.indexOf('# assert_ours guards'));
assert.ok(
  ours.indexOf('service_exists') < ours.indexOf('service_dir'),
  'assert_ours must test existence BEFORE reading the directory, or the two failures merge again',
);
assert.ok(/continuing anyway/.test(ours), 'a unit with no WorkingDirectory must not be refused as missing');

console.log('ok: the installer asks systemd about its own service');
