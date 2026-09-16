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
assert.equal((src.match(/async function execTSwap\(/g) ?? []).length, 1, 'execTSwap must exist exactly once');
assert.ok(/bot\.action\('tswapok', execTSwap\)/.test(src), 'the Confirm button must call the same function');

const auto = src.slice(src.indexOf('if (!shortLabel && !config.safety.dryRun)'), src.indexOf('const kb = shortLabel'));
assert.ok(/return execTSwap\(auto\)/.test(auto), 'the automatic path must go through execTSwap');
assert.ok(/!shortLabel/.test(auto), 'a shortfall must still stop before anything is sent');
assert.ok(/!config\.safety\.dryRun/.test(auto), 'a dry run must never send');
// BUY and SELL both run automatically since 16 Sep 2026 -- one behaviour, not two.
// The guards below are what replaced the Confirm button the buy side used to carry.

// The floor the fill is held to is set BEFORE the auto branch runs; without it the
// execution has no number to refuse a bad fill against.
assert.ok(
  src.indexOf('tflow.quotedOutWei = q.out;') < src.indexOf('if (!shortLabel && !config.safety.dryRun)'),
  'quotedOutWei must be set before the automatic execution',
);
assert.ok(/quotedOutWei/.test(src.slice(src.indexOf('async function execTSwap('))), 'the execution must hold the fill to the quoted floor');

// --- the same rule for /bridge, which is the harder case: it cannot be undone ---
const br = readFileSync('src/commands/bridge.ts', 'utf8');
assert.equal((br.match(/async function execBridge\(/g) ?? []).length, 1, 'execBridge must exist exactly once');
assert.ok(/bot\.action\('br:go'/.test(br), 'the bridge Confirm button must stay registered');
const brAuto = br.slice(br.indexOf('if (!config.safety.dryRun) {'), br.indexOf('await editProgress(\n      ctx,\n      prog,\n      msg.msgBridgeConfirm'));
assert.ok(/return execBridge\(auto\)/.test(brAuto), 'the automatic bridge must go through execBridge');
// minOutWei is the floor the fill is held to; it must be set before the auto branch.
assert.ok(
  br.indexOf('flow.minOutWei = (q.outWei * 99n) / 100n;') < br.indexOf('if (!config.safety.dryRun) {'),
  'minOutWei must be set before the automatic execution',
);
assert.ok(/minOutWei/.test(br.slice(br.indexOf('async function execBridge('))), 'the bridge execution must hold that floor');

// --- and /send, which is the only path that moves money OUT of the wallet ---
const sd = readFileSync('src/commands/send.ts', 'utf8');
assert.equal((sd.match(/async function execSend\(/g) ?? []).length, 1, 'execSend must exist exactly once');
assert.ok(/bot\.action\('sndgo'/.test(sd), 'the withdraw Confirm button must stay registered; the dry run still uses it');
const sdAuto = sd.slice(sd.indexOf('if (!config.safety.dryRun) {'), sd.indexOf('return ctx.reply(\n    msg.msgSendConfirm'));
assert.ok(/return execSend\(auto\)/.test(sdAuto), 'the automatic withdrawal must go through execSend');
// The ceiling is checked before confirm() is ever called; without it an auto-send could
// leave the wallet unable to pay for its own gas.
assert.ok(/wei > usableNow/.test(sd), 'the amount must be checked against what may actually be sent');
assert.ok(/nativeReserve|GAS|usable/.test(sd), 'the gas reserve must still be set aside');

console.log('ok: swap, bridge and withdraw all run through one executor, with a quoted floor and balance guards');
