import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A swap now executes the moment the amount is set -- no Confirm button.
 *
 * That removes the human check, so the machine checks it replaced must all still be in
 * the path: one execution function (not a copy), a quoted floor, the per-tx limit, and a
 * shortfall that still stops before anything is sent.
 */
const src = readFileSync('src/index.ts', 'utf8');

// One implementation. A second copy of the money path is how the auto and confirmed
// routes start behaving differently.
assert.equal((src.match(/async function execTSwap\(/g) ?? []).length, 1, 'execTSwap harus tunggal');
assert.ok(/bot\.action\('tswapok', execTSwap\)/.test(src), 'tombol Confirm harus memanggil fungsi yang sama');

const auto = src.slice(src.indexOf('if (!tflow.buy && !shortLabel'), src.indexOf('const kb = shortLabel'));
assert.ok(/return execTSwap\(auto\)/.test(auto), 'jalur otomatis harus lewat execTSwap');
assert.ok(/!shortLabel/.test(auto), 'saldo kurang harus tetap berhenti sebelum kirim');
assert.ok(/!config\.safety\.dryRun/.test(auto), 'dry run tak boleh ikut mengirim');
assert.ok(/!tflow\.buy/.test(auto), 'hanya swap yang otomatis — beli tetap minta konfirmasi');

// The floor the fill is held to is set BEFORE the auto branch runs; without it the
// execution has no number to refuse a bad fill against.
assert.ok(
  src.indexOf('tflow.quotedOutWei = q.out;') < src.indexOf('if (!tflow.buy && !shortLabel'),
  'quotedOutWei harus sudah terisi sebelum eksekusi otomatis',
);
assert.ok(/quotedOutWei/.test(src.slice(src.indexOf('async function execTSwap('))), 'eksekusi harus memakai lantai quote');

// --- the same rule for /bridge, which is the harder case: it cannot be undone ---
const br = readFileSync('src/commands/bridge.ts', 'utf8');
assert.equal((br.match(/async function execBridge\(/g) ?? []).length, 1, 'execBridge harus tunggal');
assert.ok(/bot\.action\('br:go'/.test(br), 'tombol Confirm bridge harus tetap terdaftar');
const brAuto = br.slice(br.indexOf('if (!config.safety.dryRun) {'), br.indexOf('await editProgress(\n      ctx,\n      prog,\n      msg.msgBridgeConfirm'));
assert.ok(/return execBridge\(auto\)/.test(brAuto), 'bridge otomatis harus lewat execBridge');
// minOutWei is the floor the fill is held to; it must be set before the auto branch.
assert.ok(
  br.indexOf('flow.minOutWei = (q.outWei * 99n) / 100n;') < br.indexOf('if (!config.safety.dryRun) {'),
  'minOutWei harus terisi sebelum eksekusi otomatis',
);
assert.ok(/minOutWei/.test(br.slice(br.indexOf('async function execBridge('))), 'eksekusi bridge harus memakai lantai itu');

console.log('ok: swap & bridge otomatis lewat satu jalur eksekusi, dengan lantai quote & guard saldo');
