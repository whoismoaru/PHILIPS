import 'dotenv/config';

/**
 * Membaca & memvalidasi konfigurasi dari file .env.
 * Kalau ada yang wajib tapi kosong, program berhenti dengan pesan jelas
 * supaya kita tahu persis apa yang belum diisi.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Konfigurasi "${name}" belum diisi di file .env`);
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
  wallet: {
    // Opsional sejak /connect ada: dipakai sekali untuk mengadopsi pemasangan
    // lama jadi keystore terenkripsi (walletStore.ts), lalu boleh dihapus.
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
    maxEthPerTx: optional('MAX_ETH_PER_TX', ''), // kosong = tanpa batas (lihat index.ts)
    dryRun: optional('DRY_RUN', 'true').toLowerCase() === 'true',
  },
};
