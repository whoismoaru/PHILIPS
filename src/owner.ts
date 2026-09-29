import * as evmWallet from './walletStore.js';
import * as solWallet from './solana/walletStore.js';

/**
 * Who owns a record: the connected wallet of THAT chain's family. Solana has its own key,
 * so its records belong to the Solana address, not the EVM one.
 *
 * Every store stamps this on write and filters by it on read, so switching wallets shows
 * only that wallet's positions, limits and history. A record with no stamp (written before
 * 30 Sep 2026) is treated as someone else's: fails closed, same rule as the journal.
 */
export function ownerOf(chain?: string): string | undefined {
  return (chain === 'solana' ? solWallet.address() : evmWallet.address()?.toLowerCase()) ?? undefined;
}

export function isMine(chain: string | undefined, wallet: string | undefined): boolean {
  const me = ownerOf(chain);
  return !!me && wallet === me;
}
