import assert from 'node:assert/strict';
import * as journal from '../src/journal.js';

/**
 * Cek akuntansi jurnal (read-only, tak menulis apa pun).
 * Gagal bila desimal per-base atau aturan pengecualian rusak lagi.
 *   npx tsx scripts/smoke-journal.ts
 */

const s = journal.lifetimeStats();
console.log('lifetime:', {
  count: s.count,
  known: s.known,
  excluded: s.excluded,
  wins: s.wins,
  losses: s.losses,
  net: s.netEth.toFixed(6),
});

assert.equal(s.known + s.excluded <= s.count, true, 'known+excluded tak boleh melebihi total entri');
assert.equal(s.wins + s.losses, s.known, 'wins+losses harus sama dengan entri terukur');
assert.equal(Number.isFinite(s.netEth), true, 'netEth harus angka');

// PnL WETH berskala ETH (bukan 1e-12 / 1e12) — regresi desimal langsung terlihat di sini.
for (const e of journal.read(50)) {
  if (e.resultEthWei === undefined || (e.baseKind ?? 'weth') !== 'weth') continue;
  assert.equal(Math.abs(e.pnlEth) < 1000, true, `pnlEth di luar nalar: ${e.tokenId} ${e.pnlEth}`);
}

// Tak boleh ada tokenId dengan dua entri 'cashed' + 'burned' berdempetan (race monitor↔close).
const seen = new Map<string, string[]>();
for (const e of journal.read(Number.MAX_SAFE_INTEGER)) {
  seen.set(e.tokenId, [...(seen.get(e.tokenId) ?? []), e.reason]);
}
const dupes = [...seen].filter(([, rs]) => rs.length > 1);
assert.equal(dupes.length, 0, `entri jurnal ganda: ${JSON.stringify(dupes)}`);

console.log('OK — akuntansi jurnal waras');
