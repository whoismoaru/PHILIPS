import assert from 'node:assert/strict';
import * as msg from '../src/messages.js';

/**
 * The portfolio lists chains worth reading. A row for four cents is noise that pushes the
 * figures that matter off the first screen, so anything under a dime is left out (16 Sep
 * 2026). Two things must NOT be swept up with it.
 */
const card = (chains: any[]) =>
  msg.msgStatus({ dryRun: false, totalUsd: 100, lpUsd: 0, positions: 0, chains } as any).replace(/<[^>]+>/g, '');

const out = card([
  { label: 'Robinhood', amount: '0.0004', symbol: 'ETH', usd: 1.01, stables: [{ symbol: 'USDG', amount: '1.212,93', usd: 1212.93 }] },
  { label: 'HyperEVM', amount: '0.0005', symbol: 'HYPE', usd: 0.04, stables: [] },
  { label: 'Arc', amount: '10.43', symbol: 'USDC', usd: 10.43, stables: [], stableNative: true },
  { label: 'Ink', amount: '0.0001', symbol: 'ETH', usd: null, stables: [] },
]);

assert.ok(out.includes('RH:'), 'a chain holding real money was dropped');
assert.ok(out.includes('Arc: $10,43 USDC'), 'the stablecoin-gas row is gone or reads twice');
assert.ok(!out.includes('HyperEVM'), 'a $0,04 chain is still listed');
// 1) An UNREADABLE value is not dust. Hiding it would quietly shrink the reported total,
//    which is the one thing this card must never do.
assert.ok(out.includes('Ink: —'), 'a chain whose value could not be read was hidden');
// 2) Exactly at the threshold counts as readable.
assert.ok(card([{ label: 'Base', amount: '0.00004', symbol: 'ETH', usd: 0.1, stables: [] }]).includes('BASE:'),
  'a chain worth exactly $0,10 must still be listed');
assert.ok(!card([{ label: 'Base', amount: '0.00004', symbol: 'ETH', usd: 0.09, stables: [] }]).includes('BASE:'),
  '$0,09 is below the threshold and must be hidden');

console.log('ok: chains under $0,10 are hidden, an unreadable value never is');
