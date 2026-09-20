import 'dotenv/config';

/**
 * Reads and validates the configuration in .env.
 * When something required is missing, the program stops with a clear message naming
 * exactly what has not been filled in.
 */

// This used to throw on the FIRST empty field, so a new installation meant
// run-fail-edit four times over to discover four missing values. They are now collected
// and reported together.
const missing: string[] = [];

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    missing.push(name);
    return '';
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    allowedUserId: Number(required('TELEGRAM_ALLOWED_USER_ID')),
  },
  chain: {
    rpcUrl: required('RPC_URL'),
    chainId: Number(required('CHAIN_ID')),
  },
  // BSC is optional: leave BSC_ENABLED empty (or set it to 'false') to switch the chain
  // off entirely -- the bot runs perfectly well on Robinhood alone.
  bsc: {
    enabled: (process.env.BSC_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
  },
  base: {
    enabled: (process.env.BASE_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  },
  hyperevm: {
    enabled: (process.env.HYPEREVM_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.HYPEREVM_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  },
  ink: {
    enabled: (process.env.INK_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.INK_RPC_URL || 'https://rpc-gel.inkonchain.com',
  },
  /**
   * Arc (Circle's USDC-gas L1, chain 5042). OFF until an RPC is supplied: the one public
   * endpoint that answers, rpc.arc-scan.org, dropped roughly a third of the calls made
   * while the contracts were being verified, and a bot that moves money cannot run on
   * that. There is deliberately NO default URL here -- an empty ARC_RPC_URL keeps the
   * chain out of the registry even if ARC_ENABLED is set by mistake.
   */
  arc: {
    enabled: (process.env.ARC_ENABLED ?? 'false').toLowerCase() === 'true' && !!process.env.ARC_RPC_URL,
    rpcUrl: process.env.ARC_RPC_URL || '',
  },
  /**
   * Solana (Meteora DLMM). NOT an entry in the CHAINS registry: a ChainCtx is an ethers
   * object (provider, Contract, Wallet) and Solana has none of those, so it lives in
   * src/solana/ behind its own context. Same rule as Arc, and for the same reason: no
   * default URL, because the free endpoints are not good enough to run on. During the
   * Meteora survey publicnode DISABLED getProgramAccounts outright and mainnet-beta
   * rate-limited every burst, and reading positions depends on exactly that call.
   *
   * An empty SOLANA_RPC_URL does not hide the feature, it degrades it: token screening is
   * pure HTTP and still works, while anything needing chain reads says so on the card
   * rather than printing '?' and letting it look like missing data.
   */
  solana: {
    enabled: (process.env.SOLANA_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.SOLANA_RPC_URL || '',
  },
  wallet: {
    // Optional since /connect exists: used once to adopt an older installation into the
    // encrypted keystore (walletStore.ts), and safe to delete afterwards.
    privateKey: optional('PRIVATE_KEY', ''),
  },
  uniswap: {
    factory: optional('UNISWAP_V3_FACTORY', ''),
    positionManager: optional('UNISWAP_V3_POSITION_MANAGER', ''),
    quoter: optional('UNISWAP_V3_QUOTER', ''),
    swapRouter: optional('UNISWAP_V3_SWAP_ROUTER', ''),
    weth: optional('WETH_ADDRESS', ''),
  },
  safety: {
    maxEthPerTx: optional('MAX_ETH_PER_TX', ''), // empty means no limit (see index.ts)
    // A separate limit for stablecoin bases (USDT/USDG), denominated in dollars rather
    // than ETH. Empty means no limit.
    maxStablePerTx: optional('MAX_STABLE_PER_TX', ''),
    // A ceiling on one transaction's GAS COST, in that chain's native asset. 'off' or '0'
    // means no ceiling; empty falls back to the default in chains.ts. This is not a limit
    // on the transaction's own amount.
    maxTxFeeNative: optional('MAX_TX_FEE_NATIVE', ''),
    dryRun: optional('DRY_RUN', 'true').toLowerCase() === 'true',
  },
  // The Krystal Cloud API: a far more complete pool source than Uniswap's gateway, which
  // misses deep ETH/token pools. Empty switches it off and falls back to the gateway.
  krystal: {
    apiKey: optional('KRYSTAL_API_KEY', ''),
  },
};

/**
 * The exit code for a CONFIGURATION error (EX_CONFIG). The systemd unit sets
 * RestartPreventExitStatus=78, so a mistake that waiting will never fix is not retried
 * every ten seconds forever -- it fails once, stops, and waits for a human to fix .env.
 */
export const EXIT_CONFIG = 78;

if (missing.length > 0) {
  console.error(
    `Missing ${missing.length} required field${missing.length === 1 ? '' : 's'} in your .env file:\n` +
      missing.map((m) => `  - ${m}`).join('\n') +
      '\nEvery field is documented in .env.example.',
  );
  process.exit(EXIT_CONFIG);
}

