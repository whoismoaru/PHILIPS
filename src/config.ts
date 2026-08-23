import 'dotenv/config';

/**
 * Membaca & memvalidasi konfigurasi dari file .env.
 * Kalau ada yang wajib tapi kosong, program berhenti dengan pesan jelas
 * supaya kita tahu persis apa yang belum diisi.
 */

// Dulu melempar pada field kosong PERTAMA: pemasang baru harus jalankan-gagal-edit
// empat kali berturut-turut untuk menemukan keempat field yang kurang. Sekarang
// semuanya dikumpulkan dan dilaporkan sekali.
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
  // BSC opsional: kosongkan BSC_ENABLED (atau isi 'false') untuk mematikan chain-nya
  // sama sekali — bot tetap jalan hanya dengan Robinhood.
  bsc: {
    enabled: (process.env.BSC_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
  },
  base: {
    enabled: (process.env.BASE_ENABLED ?? 'false').toLowerCase() === 'true',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
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
    // Batas terpisah utk base stablecoin (USDT/USDG): satuannya dolar, bukan ETH.
    // Kosong = tanpa batas.
    maxStablePerTx: optional('MAX_STABLE_PER_TX', ''),
    dryRun: optional('DRY_RUN', 'true').toLowerCase() === 'true',
  },
  // Krystal Cloud API — sumber pool yang jauh lebih lengkap dari gateway Uniswap
  // (mis. pool ETH/token yang gateway lewatkan). Kosong = fitur mati, jatuh ke gateway.
  krystal: {
    apiKey: optional('KRYSTAL_API_KEY', ''),
  },
};

/**
 * Kode keluar utk galat KONFIGURASI (EX_CONFIG). Unit systemd memakai
 * RestartPreventExitStatus=78, jadi kesalahan yang takkan sembuh dengan menunggu
 * tidak diulang tiap 10 detik selamanya — cukup sekali, lalu berhenti dan
 * menunggu manusia memperbaiki .env.
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

