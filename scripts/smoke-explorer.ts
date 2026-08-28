import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLORER_HEADERS } from '../src/chain.js';

/**
 * Blockscout Robinhood MENOLAK permintaan tanpa User-Agent dengan 403.
 *
 * Selama ini itu terbaca sebagai "indexer bermasalah" dan /positions memasang
 * peringatan daftar tak lengkap — padahal indexer-nya sehat, permintaannya yang
 * ditolak. Terbukti 29 Agu 2026: URL sama, satu header ditambah, 403 → 200.
 */
assert.ok(EXPLORER_HEADERS['user-agent'], 'header explorer tanpa User-Agent');
assert.ok(/Mozilla/.test(EXPLORER_HEADERS['user-agent']), 'User-Agent tak dikenali sebagai browser');

// Setiap pemanggil explorer WAJIB memakai header itu — satu yang lupa cukup untuk
// mengembalikan 403 di jalur tersebut saja, dan itu paling sulit dilacak.
for (const [file, needle] of [
  ['src/uniswapV4.ts', 'headers: EXPLORER_HEADERS'],
  ['src/index.ts', 'headers: EXPLORER_HEADERS'],
  ['src/screening.ts', 'headers: EXPLORER_HEADERS'],
] as const) {
  const s = readFileSync(join(process.cwd(), file), 'utf8');
  assert.ok(s.includes(needle), `${file} memanggil explorer tanpa header`);
}

console.log('OK — explorer: semua pemanggil mengirim User-Agent, 403 tak terulang.');
