import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '../src/pctPresets.js';
import { ERC20_ABI } from '../src/chain.js';

/**
 * /send is one-way with no undo, so every guard has to be in place: address
 * validation, a gas reserve for the native asset, a separate confirmation, an
 * in-flight lock, and a warning when the destination is a contract.
 */
const src = readFileSync(join(process.cwd(), 'src', 'commands', 'send.ts'), 'utf8');

assert.ok(/ethers\.isAddress\(t\)/.test(src), 'the destination address is not validated');
assert.ok(/gasBuffer\(cc\)/.test(src), 'native is sent without setting gas aside');
assert.ok(/getCode\(/.test(src), 'the destination is never checked for being a contract');
assert.ok(/sending\.has\(uid\)/.test(src), 'no anti double-tap lock');
assert.ok(/store\.beginMoneyOp\(\)/.test(src) && /store\.endMoneyOp\(\)/.test(src), 'the monitor is not locked while sending');
assert.ok(/flows\.delete\(uid\);/.test(src), 'the flow is not cleared before execution, so it can send twice');
assert.ok(/config\.safety\.dryRun/.test(src), 'DRY RUN is ignored');

// One EVM address serves every chain, so the chain must never be guessed from it.
assert.ok(/assetsOn\(cc\)/.test(src), 'the chain is not picked from real balances');

// Preset persen /send ada dan sah.
assert.ok(p.get('send').length > 0, 'the send presets are empty');
assert.ok(p.sanitize(p.defaultsFor('send'), 'send'), 'the send defaults fail their own validation');
assert.equal(p.unitFor('send'), '%');

// The sample address is a valid one, which is what keeps the helper honest. It is
// synthetic on purpose: a real wallet in a file that gets pushed would tie this
// public repository to its owner's money.
assert.ok(ethers.isAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'));

// Base addresses in chains.ts are not uniformly cased: Robinhood's USDG is lower
// case, the rest are checksummed. Comparing the strings as-is makes an asset that
// read as "balance is gone", which happened on 28 Aug 2026 the first time /send was tried.
assert.ok(
  /x\.address\?\.toLowerCase\(\)/.test(src),
  'asset matching still compares addresses verbatim, so it is case sensitive',
);
assert.ok(!/=== \(addr \?\? 'native'\)[\s\S]{0,40}getAddress/.test(src), 'the callback is checksummed and then compared raw');

// The shared ERC20_ABI has NO transfer, since this bot normally goes through a router, so
// /send has to use an ABI that carries it, or every send dies on "transfer is not a function"
// only surfaced AFTER the user tapped Confirm. It happened on 28 Aug 2026.
const fnNames = (abi: readonly string[]) =>
  new ethers.Interface(abi as string[]).fragments.filter((f) => f.type === 'function').map((f: any) => f.name);
const sendAbi = [...ERC20_ABI, 'function transfer(address to, uint256 amount) returns (bool)'];
assert.ok(!fnNames(ERC20_ABI).includes('transfer'), 'ERC20_ABI changed: re-check what /send assumes');
assert.ok(fnNames(sendAbi).includes('transfer'), 'the /send ABI has no transfer');
assert.ok(/ERC20_SEND_ABI/.test(src), '/send does not use the transfer-bearing ABI');
assert.ok(!/ERC20_ABI, cc\.wallet\)\.transfer/.test(src), 'transfer is still called through an ABI that lacks it');

// "0.1%" has to read as a PERCENTAGE, not be rejected as an invalid amount.
assert.ok(/\^\(\\d\+\(\?:\\\.\\d\+\)\?\)\\s\*%\$/.test(src), '/send does not recognise a percentage amount');
const usable = 208_670_000n;
const calc = (pct: number) => (pct >= 100 ? usable : (usable * BigInt(Math.round(pct * 1000))) / 100_000n);
for (const pct of [0.1, 12.5, 33.3, 99.9, 100]) {
  const w = calc(pct);
  assert.ok(w > 0n, `${pct}% membulat jadi nol`);
  assert.ok(w <= usable, `${pct}% exceeds the balance`);
}

console.log('ok: the address and ABI are right, typed percentages are accepted, and gas is reserved.');
