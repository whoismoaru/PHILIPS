import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';
import { v4Supported, v4BaseSymbol, v4BaseDecimals } from '../src/uniswapV4.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * v4 di lebih dari satu chain. Dua hal yang dulu dipatok dan pecah begitu BSC
 * dinyalakan: base stablecoin ('USDG' harfiah) dan desimalnya (6). Di BSC
 * base-nya USDT dengan 18 desimal.
 */
for (const cc of Object.values(CHAINS)) {
  if (!v4Supported(cc)) continue;
  const stable = cc.bases.find((b) => b.kind !== 'weth');
  assert.ok(stable, `${cc.key}: v4 aktif tapi chain ini tak punya base stablecoin`);
  assert.equal(v4BaseSymbol(cc, 'USDG'), stable!.symbol, `${cc.key}: simbol base v4 salah`);
  assert.equal(v4BaseDecimals(cc, 'USDG'), stable!.decimals, `${cc.key}: desimal base v4 salah`);
  assert.equal(v4BaseSymbol(cc, 'ETH'), cc.nativeSymbol, `${cc.key}: simbol native salah`);
  assert.equal(v4BaseDecimals(cc, 'ETH'), 18);
}

/**
 * Checksum alamat v4 WAJIB benar. Pembacaan pool dibungkus catch(() => 0n), jadi
 * alamat salah tidak melempar error — ia menyamar sebagai "pool tanpa likuiditas"
 * dan membuang SETIAP pool di chain itu tanpa suara. Terjadi 28 Agu 2026.
 */
const src = readFileSync(join(process.cwd(), 'src', 'uniswapV4.ts'), 'utf8');
const addrs = [...src.matchAll(/^\s{2}(\w+): '(0x[0-9a-fA-F]{40})',$/gm)].map((m) => m[2]);
assert.ok(addrs.length >= 3, `hanya ${addrs.length} alamat terbaca — pola tabel berubah?`);
for (const a of addrs) {
  assert.equal(a, ethers.getAddress(a.toLowerCase()), `checksum salah: ${a}`);
}

console.log(`OK — v4 chains: ${addrs.length} alamat ber-checksum benar, base per chain cocok.`);
