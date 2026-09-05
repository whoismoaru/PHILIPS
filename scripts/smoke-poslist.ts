/**
 * /positions & /portfolio harus melihat v4 di SEMUA chain, bukan chain default.
 *
 * Tiga posisi v4 BSC pernah tercatat rapi di v4store tapi tak pernah muncul di
 * kartu mana pun, karena kedua jalur hanya bertanya ke `getChain()` — Robinhood.
 * Cek ini membaca chain sungguhan dan menuntut tiap record v4store yang masih
 * hidup on-chain ikut terenumerasi.
 */
import assert from 'node:assert/strict';
import { CHAINS, DEFAULT_CHAIN } from '../src/chains.js';
import { listPositionsV4, v4Supported } from '../src/uniswapV4.js';
import { allV4 } from '../src/v4store.js';

const chains = Object.values(CHAINS).filter((c) => v4Supported(c));
assert.ok(chains.length > 0, 'tak ada chain v4 sama sekali');

const terlihat = new Map<string, string>(); // tokenId → chain
for (const c of chains) {
  for (const p of await listPositionsV4(c).catch(() => [])) terlihat.set(p.tokenId, c.key);
}
console.log(`chain v4: ${chains.map((c) => c.key).join(', ')} · terenumerasi: ${terlihat.size} posisi`);

// Yang penting: record di luar chain default TIDAK boleh hilang.
const luar = allV4().filter((r) => (r.chain ?? DEFAULT_CHAIN) !== DEFAULT_CHAIN);
console.log(`v4store di luar ${DEFAULT_CHAIN}: ${luar.length} record`);
for (const r of luar) {
  const dimana = terlihat.get(r.tokenId);
  assert.ok(
    dimana !== undefined,
    `posisi v4 ${r.tokenId} (${r.chain}) tak terenumerasi — daftar hanya membaca chain default lagi`,
  );
  assert.equal(dimana, r.chain, `posisi ${r.tokenId} terbaca di chain ${dimana}, seharusnya ${r.chain}`);
}

// Penjaga sumber: sekali salah satu jalur kembali memakai satu chain, tes di atas
// baru gagal kalau kebetulan ada posisi lintas-chain yang hidup. Ini gagal segera.
const src = (await import('node:fs')).readFileSync('src/index.ts', 'utf8');
for (const [nama, pola] of [
  ['/positions', /const v4 = \(\s*\n\s*await Promise\.all\(\s*\n\s*Object\.values\(CHAINS\)/],
  ['/portfolio', /const v4P = Promise\.all\(\s*\n\s*Object\.values\(CHAINS\)/],
] as const)
  assert.match(src, pola, `${nama} tak lagi menyapu semua chain v4`);

console.log('ok — v4 terbaca lintas chain di /positions & /portfolio');
