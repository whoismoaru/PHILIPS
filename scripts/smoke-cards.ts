import * as m from '../src/messages.js';

/** Render semua kartu utama dengan data contoh — cek HTML & tata letak tanpa jaringan. */
const out: string[] = [];
const show = (name: string, text: string) => out.push(`\n══════ ${name} ══════\n${text}`);

show(
  'START — bot hidup (dengan sinkron)',
  m.msgStarted({ dryRun: false, chainLabel: 'Robinhood', chainId: 4663, positions: 1, imported: 2, gone: 1 }),
);
show(
  'START — tanpa sinkron, DRY RUN',
  m.msgStarted({ dryRun: true, chainLabel: 'Robinhood', chainId: 4663, positions: 0, imported: 0, gone: 0 }),
);
show('HELP (daftar perintah)', m.msgHelp(false));

show(
  'UANG (/status)',
  m.msgStatus({
    dryRun: false,
    chainId: 4663n as unknown as bigint,
    positions: 1,
    limitLabel: '∞',
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    chains: [
      { label: 'Robinhood', amount: '0.0421', symbol: 'ETH', usd: 151.2 },
      { label: 'Ethereum', amount: '0.0000', symbol: 'ETH', usd: 0 },
    ],
    usdg: { amount: '12.50', usd: 12.5 },
    totalUsd: 163.7,
    holdingsCount: 2,
    refreshRel: '42 detik lalu',
  }),
);

show('UANG — baca token gagal', m.msgStatus({
  dryRun: false,
  chainId: 4663n as unknown as bigint,
  positions: 0,
  limitLabel: '∞',
  wallet: '0x1234567890abcdef1234567890abcdef12345678',
  chains: [{ label: 'Robinhood', amount: '0.0421', symbol: 'ETH', usd: null }],
  totalUsd: null,
  holdingsCount: null,
}));

show(
  'POSISI',
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
    known: 106,
    excluded: 13,
    count: 138,
    wins: 93,
    losses: 13,
    netEth: 0.122745,
    grossWin: 0.2,
    grossLoss: -0.077,
    best: { symbol: 'VLAD', pnlEth: 0.03 },
    worst: { symbol: 'PONS', pnlEth: -0.02 },
  }),
);

show(
  'PREVIEW 4/4 — kurang saldo',
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
  'PREVIEW 4/4 — biaya gagal dibaca',
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

show('ADD 3/4 (nominal + saldo)', m.msgAmountStep('WETH', '∞', '0.0376 ETH'));

show(
  'KONFIRMASI BELI — BAHAYA',
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
  'KONFIRMASI BELI — saldo kurang',
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

show(
  'HUB TOKEN — BAHAYA, punya bag + LP',
  m.msgTokenHub({
    symbol: 'TENDIES',
    chainLabel: 'Robinhood',
    ca: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    verdict: 'BAHAYA',
    verdictNote: 'likuiditas $1.8K · pool 6 jam',
    priceUsd: '0.00004312',
    balanceLabel: '12,345.6789 TENDIES',
    balanceUsd: 43.2,
    lpCount: 1,
    lpIds: ['178449'],
    dryRun: false,
  }),
);
show(
  'HUB TOKEN — bersih, belum dipegang',
  m.msgTokenHub({
    symbol: 'PONS',
    chainLabel: 'Robinhood',
    ca: '0x92d176ccbeeffecd8089e841d09ea17b6c22d969',
    verdict: 'AMAN',
    verdictNote: 'likuiditas $1.2M · pool 940 jam',
    priceUsd: '1.23',
    dryRun: false,
  }),
);
show(
  'HUB TOKEN — screening gagal',
  m.msgTokenHub({
    symbol: 'FOO',
    chainLabel: 'Base',
    ca: '0x1111111111111111111111111111111111111111',
    verdict: null,
    balanceLabel: '500.0000 FOO',
    dryRun: true,
  }),
);

show('ALERT ANJLOK', m.msgPriceDrop('12345', 'TENDIES', 31.4, 'WETH'));
show('ERROR (revert ethers multi-baris)', m.msgError('close', 'execution reverted: STF\n  reason=STF, code=CALL_EXCEPTION\n  transaction={...}'));
show('UNKNOWN — CA ditempel', m.msgUnknown('0x020bfc650a365f8bb26819deaabf3e21291018b4', true));
show('SIZE', m.msgSizeList('ETH', 'ETH', [0.01, 0.05, 0.1, 0.5]));
show('TUTUP SEMUA (v3+v4)', m.msgCloseAllPick(2, 1));
show('BRIDGE selesai', m.msgFundDone(['0xabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab'], '19.29 USDT0', false));

console.log(out.join('\n'));

// Cek dasar: tak boleh ada tag HTML rusak / escape ganda di semua kartu.
const all = out.join('\n');
const bad = all.match(/&lt;(b|i|code|pre|blockquote)&gt;/g);
if (bad) {
  console.error('\n❌ DOUBLE-ESCAPE terdeteksi:', [...new Set(bad)].join(' '));
  process.exit(1);
}
const opens = (all.match(/<(b|i|code|pre|blockquote)>/g) ?? []).length;
const closes = (all.match(/<\/(b|i|code|pre|blockquote)>/g) ?? []).length;
console.log(`\n✅ tag seimbang: ${opens} buka / ${closes} tutup`);
if (opens !== closes) process.exit(1);
