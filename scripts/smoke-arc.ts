import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';

/**
 * Arc (chain 5042) is SCAFFOLDED, not switched on: every address is in place and
 * verified, and only the RPC is missing. Two things have to stay true while it waits.
 *
 * 1. It must stay OUT of the registry until someone supplies ARC_RPC_URL. A chain that
 *    quietly joins with an empty RPC fails every read at once, and on the money paths
 *    that looks like a dead chain rather than a missing setting.
 * 2. The addresses must not rot. They were read off @uniswap/sdk-core and checked on
 *    chain; this pins them so a careless edit is caught here instead of by a transaction.
 */
assert.ok(!CHAINS.arc, 'Arc is in the registry: it must stay out until ARC_RPC_URL is set');

const chains = readFileSync('src/chains.ts', 'utf8');
const arc = chains.slice(chains.indexOf('        arc: {'), chains.indexOf('  ...(config.ink.enabled'));
assert.ok(arc.length > 200, 'the Arc definition has gone missing');

const addr = (label: string) => {
  const m = arc.match(new RegExp(`${label}: '(0x[0-9a-fA-F]{40})'`));
  assert.ok(m, `Arc lost its ${label}`);
  return m![1].toLowerCase();
};
// Verified on Arc on 15 Sep 2026: each carries bytecode, NPM.factory() returns the
// factory, and v4PM.poolManager() returns the pool manager.
assert.equal(addr('factory'), '0xf0db7b58379503491d857db50ac9ece64c653918');
assert.equal(addr('pm'), '0x39654a85a4c05127f5fd6ed22caec077a0fb1377');
assert.equal(addr('router'), '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77');
assert.equal(addr('quoter'), '0x7dfd4f31be6814d2906bde155c3e1b146eac1468');
assert.equal(addr('usdc'), '0x3600000000000000000000000000000000000000');
assert.match(arc, /chainId: 5042/, 'the Arc chain id is wrong');
// Gas on Arc IS USDC. A wrapped native here would be a token that does not exist: the
// position manager's WETH9() points at a stub that reverts when called.
assert.match(arc, /weth: ethers\.ZeroAddress/, 'Arc must carry no wrapped native');
assert.match(arc, /hasWethBase: false/, 'Arc must not offer an ETH base');
assert.match(arc, /usdcDecimals: 6/, "Arc's USDC is the 6-decimal ERC-20 interface, not the 18-decimal native one");

const v4 = readFileSync('src/uniswapV4.ts', 'utf8');
assert.ok(v4.includes("arc: '0x8366a39cc670b4001a1121b8f6a443a643e40951'"), 'the Arc v4 PoolManager is missing');
assert.ok(v4.includes("arc: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b'"), 'the Arc v4 PositionManager is missing');

// Turning it on with no RPC must still leave it out -- config.arc.enabled requires both.
const cfg = readFileSync('src/config.ts', 'utf8');
assert.match(cfg, /ARC_ENABLED[\s\S]{0,80}&& !!process\.env\.ARC_RPC_URL/, 'ARC_ENABLED alone can now enable the chain');

void ethers;
console.log('ok: Arc is scaffolded, its addresses are pinned, and it stays out of the registry until an RPC is given');
