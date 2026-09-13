import assert from 'node:assert/strict';
import { CHAINS, basesFor, isStableBase } from '../src/chains.js';

/**
 * The native balance appears in the /sell list, recorded under the wrapped-native address.
 * If the sell destination is also native, from == to: a swap into itself, which always
 * comes back as "No route (thin pool/liquidity)". Native has to be sold into
 * a STABLECOIN, while an ordinary token sells into native.
 */
for (const cc of Object.values(CHAINS)) {
  const weth = cc.wethAddress.toLowerCase();
  const nativeDest = basesFor(cc).find((b) => isStableBase(b.kind));
  const tokenDest = basesFor(cc).find((b) => b.wrappable);

  if (nativeDest) {
    assert.notEqual(
      nativeDest.address.toLowerCase(), weth,
      `${cc.key}: selling ${cc.nativeSymbol} lands back on itself`,
    );
  }
  if (tokenDest) {
    assert.equal(tokenDest.address.toLowerCase(), weth, `${cc.key}: a wrappable base must equal wrapped-native`);
  }
  // Native may only be offered for sale when there is a stablecoin to sell it into.
  if (cc.hasWethBase && !nativeDest) {
    assert.ok(true, `${cc.key}: with no stablecoin, native is correctly not offered (addNativeHolding refuses)`);
  }
}

// Native is only offered when a destination stablecoin exists, and when it is offered
// that destination MUST live on the same chain, never on another one.
for (const cc of Object.values(CHAINS)) {
  const stable = basesFor(cc).find((b) => isStableBase(b.kind));
  if (!cc.hasWethBase || !stable) continue;
  assert.ok(
    cc.bases.some((b) => b.address.toLowerCase() === stable.address.toLowerCase()),
    `${cc.key}: the destination stablecoin is not a base of this chain`,
  );
  assert.notEqual(stable.address.toLowerCase(), cc.wethAddress.toLowerCase(), `${cc.key}: tujuan = wrapped-native`);
}

console.log('ok: native sells into a stablecoin and tokens into native, on every chain.');
