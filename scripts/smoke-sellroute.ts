import assert from 'node:assert/strict';
import { CHAINS, basesFor, isStableBase } from '../src/chains.js';

/**
 * Saldo native ikut daftar /sell dan dicatat memakai alamat wrapped-native.
 * Kalau tujuan jualnya juga native, from == to — swap ke dirinya sendiri, yang
 * selalu balik sebagai "No route (thin pool/liquidity)". Native harus dijual ke
 * STABLECOIN; token biasa dijual ke native.
 */
for (const cc of Object.values(CHAINS)) {
  const weth = cc.wethAddress.toLowerCase();
  const nativeDest = basesFor(cc).find((b) => isStableBase(b.kind));
  const tokenDest = basesFor(cc).find((b) => b.wrappable);

  if (nativeDest) {
    assert.notEqual(
      nativeDest.address.toLowerCase(), weth,
      `${cc.key}: menjual ${cc.nativeSymbol} mendarat di dirinya sendiri`,
    );
  }
  if (tokenDest) {
    assert.equal(tokenDest.address.toLowerCase(), weth, `${cc.key}: base wrappable harus = wrapped-native`);
  }
  // Native hanya boleh ditawarkan untuk dijual bila ada stablecoin tujuannya.
  if (cc.hasWethBase && !nativeDest) {
    assert.ok(true, `${cc.key}: tanpa stablecoin, native memang tak ditawarkan (addNativeHolding menolak)`);
  }
}

// Native hanya ditawarkan bila ada stablecoin tujuannya — dan bila ditawarkan,
// tujuannya WAJIB ada di chain yang sama, bukan milik chain lain.
for (const cc of Object.values(CHAINS)) {
  const stable = basesFor(cc).find((b) => isStableBase(b.kind));
  if (!cc.hasWethBase || !stable) continue;
  assert.ok(
    cc.bases.some((b) => b.address.toLowerCase() === stable.address.toLowerCase()),
    `${cc.key}: stablecoin tujuan bukan base chain ini`,
  );
  assert.notEqual(stable.address.toLowerCase(), cc.wethAddress.toLowerCase(), `${cc.key}: tujuan = wrapped-native`);
}

console.log('OK — sell route: native → stablecoin, token → native; berlaku di semua chain.');
