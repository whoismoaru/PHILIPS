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
