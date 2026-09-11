// One runnable check on the cross-chain funding layer: which stablecoin gets spent,
// and whether an arrival is only accepted once the balance really moved. Pure logic
// and a fake provider -- no network, no wallet.
import assert from 'node:assert';
import { pickFund, awaitArrival, type StableFund } from '../src/xchain.js';

const fund = (chainId: number, usd: number, symbol = 'USDC'): StableFund =>
  ({ ctx: { chainId, label: `chain${chainId}` }, base: { symbol, decimals: 6 }, balWei: BigInt(usd) * 1_000_000n, usd }) as any;

// --- pickFund: spending on the destination chain avoids a bridge entirely. ---
const funds = [fund(8453, 500), fund(4663, 120), fund(56, 40)];
assert.equal(pickFund(funds, 100, 4663)!.ctx.chainId, 4663, 'dana di chain tujuan harus menang walau bukan terbesar');
assert.equal(pickFund(funds, 100, 999)!.ctx.chainId, 8453, 'tanpa dana lokal, ambil yang terkaya & cukup');
assert.equal(pickFund(funds, 300, 4663)!.ctx.chainId, 8453, 'dana lokal kurang → jangan dipaksakan');
assert.equal(pickFund(funds, 9999, 4663)!.ctx.chainId, 8453, 'tak ada yang cukup → kembalikan terkaya utk laporan kurang');
assert.equal(pickFund([], 100, 4663), null, 'dompet kosong harus null, bukan lempar');

// --- awaitArrival: proof is the balance delta, never the quote. ---
const ctxWith = (seq: bigint[]) => {
  let i = 0;
  return { label: 'dest', wallet: { address: '0xw' }, provider: { getBalance: async () => seq[Math.min(i++, seq.length - 1)] } } as any;
};
const NATIVE = '0x0000000000000000000000000000000000000000';

// Fill lands on the second poll → accepted, and reports what actually arrived.
const ok = await awaitArrival(ctxWith([100n, 100n, 900n]), NATIVE, 100n, 500n, 20_000);
assert.equal(ok.received, 800n, 'jumlah diterima harus dari selisih saldo');

// Fill lands BELOW the confirmed minimum → must fail loudly with the real figure.
await assert.rejects(
  () => awaitArrival(ctxWith([100n, 400n]), NATIVE, 100n, 500n, 9000),
  /arrived short: got 300/,
  'fill di bawah minimum tak boleh dianggap sukses',
);

// Nothing ever arrives → distinct error, so a stuck bridge is not read as a bad rate.
await assert.rejects(
  () => awaitArrival(ctxWith([100n]), NATIVE, 100n, 500n, 9000),
  /nothing arrived on dest/,
  'bridge nyangkut harus punya pesan sendiri',
);

// --- sweepable: what a treasury sweep is allowed to move. ---
import { sweepable } from '../src/commands/treasury.js';
const pot = [fund(8453, 500), fund(4663, 120), fund(56, 3), fund(999, 80)];
assert.deepEqual(sweepable(pot, 8453).map((f) => f.ctx.chainId), [4663, 999], 'chain home & debu harus dikecualikan');
assert.deepEqual(sweepable(pot, 999).map((f) => f.ctx.chainId), [8453, 4663], 'home pindah → yg lain ikut tersapu');
assert.equal(sweepable([fund(8453, 500)], 8453).length, 0, 'semua sudah di rumah → tak ada yg disapu');
assert.equal(sweepable(pot.map((f) => ({ ...f, usd: 1 })), 8453).length, 0, 'semua debu → jangan bakar ongkos bridge');
console.log('ok: sapuan treasury hanya menyentuh dana di luar chain rumah & di atas ambang debu');

// --- gas pocket: sizing and the reserve it must never spend. ---
import { ethers } from 'ethers';
import { gasUsdNeeded, gasSpendable, GAS_KEEP_WEI } from '../src/xchain.js';

// Destination native is not always ETH, so the size goes through USD, not 1:1.
assert.equal(gasUsdNeeded(ethers.parseEther('0.01'), 3000), 30 * 1.03, 'gas disizing lewat USD + margin 3%');
assert.ok(
  gasUsdNeeded(ethers.parseEther('0.01'), 600) < gasUsdNeeded(ethers.parseEther('0.01'), 3000),
  'native murah (BNB/HYPE) harus butuh dolar lebih sedikit drpd ETH utk jumlah yg sama',
);

// The pocket signs its own bridge, so it can never send everything it holds.
assert.equal(gasSpendable(GAS_KEEP_WEI), 0n, 'saldo pas-pasan = tak ada yg boleh dikirim');
assert.equal(gasSpendable(GAS_KEEP_WEI - 1n), 0n, 'di bawah cadangan jangan pernah negatif');
assert.equal(gasSpendable(GAS_KEEP_WEI + 5n), 5n, 'hanya kelebihan di atas cadangan yg boleh pergi');
console.log('ok: kantong gas menyisakan ongkos tx-nya sendiri & disizing lewat USD lintas native');

console.log('ok: pemilihan dana lintas chain benar, dan kedatangan hanya diakui lewat selisih saldo');
