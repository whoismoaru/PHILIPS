import 'dotenv/config';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { getChain } from '../src/chains.js';
import { listPositionsV4 } from '../src/uniswapV4.js';
import { allV4 } from '../src/v4store.js';

const PM: Record<string, string> = { robinhood: '0x58daec3116aae6D93017bAAea7749052E8a04fA7' };

for (const chainKey of Object.keys(PM)) {
  const cc = getChain(chainKey as any);
  const live = (await listPositionsV4(cc, { onlyLive: true }))
    .filter((p) => p.valueBaseWei !== null && p.base);
  if (!live.length) { console.log(`${chainKey}: tak ada posisi v4 hidup — lewati`); continue; }

  const pmAbi = ['function ownerOf(uint256) view returns (address)'];
  let checked = 0;
  for (const p of live.slice(0, 3)) {
    const owner = await new ethers.Contract(PM[chainKey], pmAbi, cc.provider).ownerOf(p.tokenId);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const actions = ethers.concat([Uint8Array.of(0x03), Uint8Array.of(0x11)]); // BURN, TAKE_PAIR
    const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, [
      coder.encode(['uint256', 'uint128', 'uint128', 'bytes'], [p.tokenId, 0, 0, '0x']),
      coder.encode(['address', 'address', 'address'], [p.poolKey.currency0, p.poolKey.currency1, owner]),
    ]]);
    const wIface = new ethers.Interface(['function modifyLiquidities(bytes,uint256)']);
    const erc = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
    const bal = (a: string) => ({ from: owner, to: a, data: erc.encodeFunctionData('balanceOf', [owner]) });

    let sim: any;
    try {
      sim = await (cc.provider as any).send('eth_simulateV1', [{
        blockStateCalls: [{ calls: [
          { from: owner, to: PM[chainKey], data: wIface.encodeFunctionData('modifyLiquidities', [unlockData, Math.floor(Date.now() / 1e3) + 600]) },
          bal(p.poolKey.currency0), bal(p.poolKey.currency1),
        ] }], validation: false,
      }, 'latest']);
    } catch { console.log(`  #${p.tokenId}: RPC tanpa eth_simulateV1 — lewati silang-cek`); continue; }
    if (sim[0].calls[0].status !== '0x1') { console.log(`  #${p.tokenId}: simulasi revert — lewati`); continue; }

    const before = await Promise.all([p.poolKey.currency0, p.poolKey.currency1].map((a) =>
      new ethers.Contract(a, ['function balanceOf(address) view returns (uint256)'], cc.provider).balanceOf(owner)));
    const got0 = BigInt(sim[0].calls[1].returnData) - before[0];
    const got1 = BigInt(sim[0].calls[2].returnData) - before[1];

    const mgrAddr = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
    const coder2 = ethers.AbiCoder.defaultAbiCoder();
    const poolId = ethers.keccak256(coder2.encode(['tuple(address,address,uint24,int24,address)'],
      [[p.poolKey.currency0, p.poolKey.currency1, p.poolKey.fee, p.poolKey.tickSpacing, p.poolKey.hooks]]));
    const slot = ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(6n), 32)]));
    const s0raw = BigInt(await new ethers.Contract(mgrAddr,
      ['function extsload(bytes32) view returns (bytes32)'], cc.provider).extsload(slot));
    const sqrtP = s0raw & ((1n << 160n) - 1n);
    const Q96 = 2n ** 96n;
    const p2 = sqrtP * sqrtP;
    const bIs0 = p.poolKey.currency0.toLowerCase() ===
      (p.base === 'USDG' ? cc.usdgAddress! : cc.wethAddress).toLowerCase() || p.poolKey.currency0 === ethers.ZeroAddress;
    const gotBase = bIs0 ? got0 + (p2 === 0n ? 0n : (got1 * Q96 * Q96) / p2)
                         : got1 + (got0 * p2) / (Q96 * Q96);
    const totalCard = p.valueBaseWei! + (p.feesBaseWei ?? 0n);

    assert.ok(p.feesBaseWei !== null, `#${p.tokenId}: feesBaseWei null`);
    const drift = Number(gotBase - totalCard) / Number(totalCard || 1n);
    console.log(`  #${p.tokenId}: prinsipal ${p.valueBaseWei} + fee ${p.feesBaseWei} · simulasi base ${gotBase} · drift ${(drift * 100).toFixed(2)}%`);
    assert.ok(Math.abs(drift) < 0.01, `#${p.tokenId}: selisih kartu vs simulasi ${(drift * 100).toFixed(2)}% > 5%`);
    checked++;
  }
  console.log(`${chainKey}: ${checked} posisi tersilang-cek OK`);
}
console.log('smoke-v4fees: LULUS');
