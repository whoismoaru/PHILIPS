import assert from 'node:assert/strict';
import * as journal from '../src/journal.js';

const s = journal.statsFor();
console.log('lifetime:', {
  count: s.count,
  known: s.known,
  untracked: s.untracked,
  excluded: s.excluded,
  recovered: s.recovered,
  books: s.books.map((b) => `${b.unit} ${b.net.toFixed(6)} (${b.wins}W/${b.losses}L)`),
});

assert.equal(s.known + s.excluded <= s.count, true, 'known+excluded tak boleh melebihi total entri');

assert.equal(
  s.books.reduce((t, b) => t + b.known, 0),
  s.known,
  'jumlah known tiap buku harus sama dengan known total',
);
for (const b of s.books) {
  assert.equal(b.wins + b.losses, b.known, `${b.unit}: wins+losses harus sama dengan known`);
  assert.equal(Number.isFinite(b.net), true, `${b.unit}: net harus angka`);
  assert.equal(b.grossLoss <= 0, true, `${b.unit}: grossLoss harus <= 0`);
}

for (const e of journal.read(50)) {
  if (e.resultEthWei === undefined || (e.baseKind ?? 'weth') !== 'weth') continue;
  assert.equal(Math.abs(e.pnlEth) < 1000, true, `pnlEth di luar nalar: ${e.tokenId} ${e.pnlEth}`);
}

const seen = new Map<string, string[]>();
for (const e of journal.read(Number.MAX_SAFE_INTEGER)) {
  if (e.reason === 'recovery') continue;
  seen.set(e.tokenId, [...(seen.get(e.tokenId) ?? []), e.reason]);
}
const dupes = [...seen].filter(([, rs]) => rs.length > 1);
assert.equal(dupes.length, 0, `entri jurnal ganda: ${JSON.stringify(dupes)}`);

console.log('OK — akuntansi jurnal waras');
