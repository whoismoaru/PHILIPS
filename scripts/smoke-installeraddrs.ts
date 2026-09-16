/**
 * One runnable check on the installer's chain addresses.
 *
 * Four of them used to default to ETHEREUM MAINNET's Uniswap deployment under a prompt
 * that read "Press Enter to accept the Robinhood Chain defaults". Three of those four
 * carry bytecode on Robinhood as well -- something unrelated lives there -- so an
 * existence check passed while every pool read came back empty, and the first swap died
 * with `could not decode result data ... getPool`. The defaults must be the addresses
 * that actually answer on Robinhood, and the installer must ask the chain before it
 * writes them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sh = readFileSync('philips.sh', 'utf8');

// Verified on-chain: PM.factory() and Router.factory() both return this factory, and
// PM.WETH9() returns this WETH.
const ROBINHOOD = {
  UNISWAP_V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  UNISWAP_V3_POSITION_MANAGER: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  UNISWAP_V3_QUOTER: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  UNISWAP_V3_SWAP_ROUTER: '0xcaf681a66d020601342297493863e78c959e5cb2',
  WETH_ADDRESS: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};
for (const [key, want] of Object.entries(ROBINHOOD)) {
  const m = sh.match(new RegExp(`ask "${key}"\\s*"(0x[0-9a-fA-F]{40})"`));
  assert.ok(m, `${key} lost its default`);
  assert.equal(m![1].toLowerCase(), want.toLowerCase(), `${key} does not default to the address that answers on Robinhood`);
}

// Ethereum mainnet's deployment must not reappear as a "Robinhood default".
for (const mainnet of [
  '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
]) {
  assert.ok(!sh.includes(mainnet), `${mainnet} is an Ethereum mainnet address and is back in the installer`);
}

// Addresses alone are not enough -- the chain has to confirm they belong together.
assert.ok(/function verify_contracts\(\)/.test(sh), 'the live cross-check is gone');
assert.ok(/0xc45a0155/.test(sh), 'factory() is no longer called to cross-check the position manager');
assert.ok(
  sh.indexOf('verify_contracts "$RPC"') < sh.indexOf('--- Extra chains'),
  'verify_contracts must run BEFORE the rest of setup, not after .env is written',
);

console.log('ok: the installer ships addresses that answer, and asks the chain to confirm them');
