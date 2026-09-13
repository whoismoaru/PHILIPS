import * as m from '../src/messages.js';

const out: string[] = [];
const show = (name: string, text: string) => out.push(`\n══════ ${name} ══════\n${text}`);

show(
  'START -- bot alive, with a sync',
  m.msgStarted({ dryRun: false, chainLabel: 'Robinhood', chainId: 4663, positions: 1, imported: 2, gone: 1 }),
);
show(
  'START -- no sync, DRY RUN',
  m.msgStarted({ dryRun: true, chainLabel: 'Robinhood', chainId: 4663, positions: 0, imported: 0, gone: 0 }),
);
show('HELP (the command list)', m.msgHelp(false));

show(
  'UANG (/status)',
  m.msgStatus({
    dryRun: false,
    positions: 1,
    chains: [
      {
        label: 'Robinhood',
        amount: '0.0421',
        symbol: 'ETH',
        usd: 151.2,
        stables: [{ symbol: 'USDG', amount: '12.50', usd: 12.5 }],
      },
      { label: 'BSC', amount: '0.0019', symbol: 'BNB', usd: 1.9 },
    ],
    totalUsd: 163.7,
  }),
);

show('MONEY -- the native price could not be read', m.msgStatus({
  dryRun: false,
  positions: 0,
  chains: [{ label: 'Robinhood', amount: '0.0421', symbol: 'ETH', usd: null }],
  totalUsd: null,
}));

show(
  'POSITION',
  m.msgPositionsList({
    dryRun: false,
    activeCount: 4,
    totalInvestLabel: '≈ 0.1200 WETH',
    totalPnlUsd: 4.73,
    outOfRange: 1,
    rows: [
      { id: '409161', pair: 'WETH/SalaryC', investLabel: '0.0010', age: '0m', pnlUsd: -0.001, pnlPct: -0.1, inRange: false },
      { id: '409182', pair: 'ETH/USDT', investLabel: '0.0450', age: '12m', pnlUsd: 1.24, pnlPct: 2.8, inRange: true },
      { id: '409203', pair: 'SOL/USDT', investLabel: '1.2000', age: '4m', pnlUsd: -0.38, pnlPct: -0.3, inRange: true },
      { id: '409215', pair: 'BTC/USDT', investLabel: '0.0021', age: '27m', pnlUsd: 3.87, pnlPct: 5.1, inRange: true },
    ],
  }),
);

show(
  'RIWAYAT (/history)',
  m.msgJournal(
    [
      { tokenId: '353277', symbol: 'VLAD', pnlPct: 1.08, pnlEth: 0.00065, reason: 'cashed', closedAt: Date.now() - 3600_000 },
      { tokenId: '353100', symbol: 'TENDIES', pnlPct: -3.2, pnlEth: -0.0019, reason: 'cashed', closedAt: Date.now() - 7200_000 },
      { tokenId: '352990', symbol: 'PONS', pnlPct: 0, pnlEth: 0, reason: 'burned', closedAt: Date.now() - 86400_000 },
    ],
    138,
  ),
);

show(
  'PnL',
  m.msgPnl({
    dryRun: false,
    chainLabel: 'Robinhood',
    periodLabel: 'All Time',
    trades: 138,
    grossWin: 1819,
    grossLoss: -724,
    winratePct: 87,
  }),
);

show(
  'PREVIEW 4/4 -- not enough balance',
  m.msgPlanStep({
    screenDanger: false,
    screenFailed: false,
    baseSymbol: 'WETH',
    symbol: 'TENDIES',
    fee: 10000,
    depositAmount: '0.05',
    depositUsd: 175,
    pctHigh: 0,
    pctLow: -30,
    currentPrice: '0.0000123',
    gasEth: '0.000412',
    needLabel: '0.050412 ETH',
    balanceLabel: '0.037600 ETH',
    shortLabel: '0.012812 ETH',
    dryRun: false,
  }),
);

show(
  'PREVIEW 4/4 -- the cost failed to read',
  m.msgPlanStep({
    screenDanger: false,
    screenFailed: false,
    baseSymbol: 'USDG',
    symbol: 'TENDIES',
    fee: 3000,
    depositAmount: '50',
    pctHigh: 0,
    pctLow: -30,
    currentPrice: '0.0000123',
    gasEth: '?',
    needLabel: '?',
    balanceLabel: '?',
    shortLabel: null,
    costFailed: true,
    dryRun: false,
  }),
);

show('ADD 3/4 (amount + balance)', m.msgAmountStep('WETH', '∞', '0.0376 ETH'));

show(
  'BUY CONFIRMATION -- DANGER',
  m.msgTSwapConfirm({
    buy: true,
    chainLabel: 'Robinhood',
    tokenSym: 'TENDIES',
    amountInLabel: '0.02 WETH',
    estOutLabel: '12,345.6789 TENDIES',
    route: 'uniswap 1.00%',
    dryRun: false,
    danger: true,
    balanceLabel: '0.031 ETH',
    shortLabel: null,
  }),
);

show(
  'BUY CONFIRMATION -- short on balance',
  m.msgTSwapConfirm({
    buy: true,
    chainLabel: 'Robinhood',
    tokenSym: 'TENDIES',
    amountInLabel: '0.05 WETH',
    estOutLabel: '30,000 TENDIES',
    route: 'relay',
    dryRun: false,
    balanceLabel: '0.031 ETH',
    shortLabel: '0.019 ETH',
  }),
);

show('ALERT ANJLOK', m.msgPriceDrop('12345', 'TENDIES', 31.4, 'WETH', 30));
show('ERROR (a multi-line ethers revert)', m.msgError('close', 'execution reverted: STF\n  reason=STF, code=CALL_EXCEPTION\n  transaction={...}'));
show('UNKNOWN — CA ditempel', m.msgUnknown('0x020bfc650a365f8bb26819deaabf3e21291018b4'));
show('CLOSE ALL (v3 + v4)', m.msgCloseAllPick(2, 1));

console.log(out.join('\n'));

const all = out.join('\n');
const bad = all.match(/&lt;(b|i|code|pre|blockquote)&gt;/g);
if (bad) {
  console.error('\n❌ DOUBLE-ESCAPE detected:', [...new Set(bad)].join(' '));
  process.exit(1);
}
const opens = (all.match(/<(b|i|code|pre|blockquote)>/g) ?? []).length;
const closes = (all.match(/<\/(b|i|code|pre|blockquote)>/g) ?? []).length;
console.log(`\n✅ tags balance: ${opens} open / ${closes} close`);
if (opens !== closes) process.exit(1);
