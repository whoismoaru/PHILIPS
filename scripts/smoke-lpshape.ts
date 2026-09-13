import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The SPOT / BID-ASK choice moved from the wizard into /settings.
 *
 * Two things must hold for that to be safe: the wizard reads the stored default instead
 * of asking, and only the BASE side can ladder — the token side has always been a single
 * spot position, and laddering it would open legs the wallet cannot fund.
 */
const idx = readFileSync('src/index.ts', 'utf8');
const wal = readFileSync('src/commands/wallet.ts', 'utf8');
const pct = readFileSync('src/pctPresets.ts', 'utf8');

assert.ok(!/renderShapeStep/.test(idx), 'langkah pilih bentuk harus sudah dicabut dari wizard');
assert.ok(/pctPresets\.shape\(\) === 'bidask'/.test(idx), 'wizard harus membaca setelan bentuk');
assert.ok(/flow\.strategy === 'base' && pctPresets\.shape\(\)/.test(idx),
  'ladder hanya untuk sisi base — sisi token wajib tetap spot');

assert.ok(/bot\.action\('lpshape'/.test(wal), 'tombol pengubah bentuk hilang dari /settings');
assert.ok(/LP shape: \$\{sh === 'bidask'/.test(wal), 'tombol harus menyebut nilai yang sedang aktif');

// A missing or corrupt file must read as SPOT, never crash a deposit mid-flow.
assert.ok(/return 'spot'; \/\/ one position/.test(pct), 'bacaan gagal harus jatuh ke spot');
assert.ok(/v === 'bidask' \? 'bidask' : 'spot'/.test(pct), 'nilai asing harus dianggap spot');

console.log('ok: bentuk LP jadi setelan, wizard memakainya, sisi token tetap spot');

// --- the deposit amount is the LAST step, and it opens the position ---
// Reordered so the money question is the final one: range and legs are decided first,
// then the amount fires the deposit. What the Confirm button used to guard still runs,
// because the direct path calls the SAME execAdd.
assert.equal((idx.match(/async function execAdd\(/g) ?? []).length, 1, 'execAdd harus tunggal');
assert.ok(/bot\.action\('addok'/.test(idx), 'tombol Confirm lama harus tetap terdaftar');
assert.ok(/await planThenOpen\(ctx, flow\)/.test(idx), 'jumlah deposit harus memicu pembukaan posisi');
assert.equal((idx.match(/await planThenOpen\(ctx, flow\)/g) ?? []).length, 2,
  'kedua jalur nominal (tombol persen & ketik manual) harus memicu hal yang sama');
const plan = idx.slice(idx.indexOf('async function planThenOpen'), idx.indexOf('async function planThenOpen') + 1800);
// No confirmation card between the amount and the deposit: the plan is computed silently
// so execAdd still has the range, the legs and the v4 leg list to work from.
assert.ok(/renderPlanStep\(point, flow, false, true\)/.test(plan), 'rencana harus dihitung diam-diam, bukan ditampilkan');
assert.ok(/msgProgress/.test(plan), 'harus ada satu gelembung progres sebagai sasaran edit');
assert.ok(/config\.safety\.dryRun/.test(plan), 'dry run tak boleh ikut membuka posisi');
assert.ok(/return execAdd\(point\)/.test(plan), 'pembukaan harus lewat execAdd, bukan salinannya');
// execAdd edits the card it was tapped on. A typed amount has no such card, so the plan
// card's id must be captured and every edit pointed at it -- otherwise the deposit runs
// but its progress and result are never shown.
assert.ok(/point\.editMessageText/.test(plan), 'edit harus diarahkan ke gelembung progres');

// Order: strategy -> range -> (legs) -> amount. Stepping back to the amount must not
// wipe the range, which is now chosen before it.
assert.ok(/Range first, amount last/.test(idx), 'urutan langkah harus terdokumentasi di kodenya');
const backAmt = idx.slice(idx.indexOf("bot.action('back:amount'"), idx.indexOf("bot.action('back:amount'") + 500);
assert.ok(!/flow\.rangePct = undefined/.test(backAmt), 'kembali ke nominal tak boleh menghapus range');

console.log('ok: nominal jadi langkah terakhir dan langsung membuka posisi lewat execAdd');
