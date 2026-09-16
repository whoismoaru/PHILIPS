import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';
import { gasBuffer } from '../src/uniswap.js';

/**
 * On a chain whose GAS TOKEN is the stablecoin, the deposit asset and the fee asset are the
 * same thing.
 *
 * Arc pays gas in USDC, and USDC is also its only LP base. The amount step reserved gas only
 * for a WRAPPABLE native, so depositing the whole balance left nothing to pay the mint with
 * and the ladder reverted with STF (16 Sep 2026). The same day, a 0.05 USDC ceiling -- sized
 * when Arc's base fee was a flat 20 gwei -- refused a three-leg ladder at 0.69 USDC.
 */
const src = readFileSync('src/index.ts', 'utf8');
assert.match(src, /const paysOwnGas = wizardBase\(flow\)\.wrappable \|\| !cc\.hasWethBase;/,
  'the amount step no longer reserves gas on a stablecoin-gas chain');

const arc = CHAINS['arc'];
if (arc) {
  // The buffer must be real money on this chain, not the 0.0005 floor meant for ETH.
  const buf = await gasBuffer(arc);
  assert.ok(buf > 0n, 'no gas buffer at all on Arc');
  const bal = await arc.provider.getBalance(arc.wallet.address).catch(() => 0n);
  if (bal > 0n) assert.ok(bal > buf, 'the buffer exceeds the balance — the step would offer nothing');

  // The ceiling has to clear an ordinary multi-leg mint at the fee the chain is CHARGING,
  // not the one it launched with.
  const chains = readFileSync('src/chains.ts', 'utf8');
  const cap = chains.match(/maxTxFeeNative: '([\d.]+)'/)?.[1];
  assert.ok(cap, 'the Arc gas ceiling is gone');
  const fee = await arc.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const eightLegs = price * 4_000_000n;
  assert.ok(
    ethers.parseEther(cap!) >= eightLegs / 2n,
    `ceiling ${cap} USDC is under half an eight-leg ladder (${ethers.formatUnits(eightLegs, 18)}): routine work would be refused`,
  );
}
console.log('ok: on a stablecoin-gas chain the deposit reserves its own fee, and the ceiling clears ordinary work');
