import { ethers } from 'ethers';
import { sendTxNonceSafe } from './core.js';
import type { ChainCtx } from './chains.js';

/**
 * Circle's CCTP V2 — native USDC across chains, by BURN and MINT.
 *
 * Not a bridge in the usual sense: no wrapped token, no liquidity pool, no custodian. The
 * USDC is destroyed on the source chain and freshly minted on the destination by Circle
 * itself. That matters for Arc, where USDC is the gas AND the only LP base, and where no
 * third-party bridge routes at all (LI.FI answers "Chain 5042 is not supported"; Relay
 * does not list it).
 *
 * Every address and domain below was read OFF THE CHAIN on 15 Sep 2026, not copied from a
 * table: the messenger and the transmitter point at each other, and each chain's USDC came
 * from its own TokenMinter. Arc's published docs list TESTNET addresses that carry no code
 * on mainnet, which is exactly the kind of thing this pins down.
 */

/** TokenMessengerV2 and MessageTransmitterV2 share one address across every CCTP V2 chain. */
export const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';

/** Circle's attestation service. */
const IRIS = 'https://iris-api.circle.com/v2';

const MESSENGER_ABI = [
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function localMinter() view returns (address)',
];
const MINTER_ABI = [
  'function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)',
  'function burnLimitsPerMessage(address token) view returns (uint256)',
];
const TRANSMITTER_ABI = [
  'function localDomain() view returns (uint32)',
  'function receiveMessage(bytes message, bytes attestation)',
];
const ERC20_ABI = [
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

/** USDC on Ethereum, used only as the key for looking a chain's own USDC up. */
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/**
 * 2000 = the STANDARD transfer: Circle attests once the source chain is finalised, and
 * charges no fee. The fast lane (1000) costs a fee and is not worth it for moving LP
 * capital, which is not waiting on seconds.
 */
const FINALITY_STANDARD = 2000;

type Support = { domain: number; usdc: string; limitWei: bigint };
/**
 * A SUCCESS is cached for good -- domains and addresses do not change. A failure is cached
 * only briefly: Arc's public RPC drops roughly a third of its calls, and caching "no CCTP
 * here" permanently would take the chain off the bridge menu for the rest of the process
 * over one timeout.
 */
const supportCache = new Map<string, Support>();
const supportMiss = new Map<string, number>();
const MISS_TTL_MS = 60_000;

/**
 * What CCTP can do on this chain: its domain, its native USDC, and how much may be burned
 * in one message. A limit of ZERO means the contracts are deployed but burning is not
 * enabled — measured on Robinhood and BSC, where a transfer would revert on send.
 */
export async function cctpSupport(cc: ChainCtx): Promise<Support | null> {
  const hit = supportCache.get(cc.key);
  if (hit) return hit;
  const missed = supportMiss.get(cc.key) ?? 0;
  if (Date.now() - missed < MISS_TTL_MS) return null;
  const out = await (async (): Promise<Support | null> => {
    try {
      // Three attempts per read: on Arc a single 503 is ordinary, and treating it as "no
      // CCTP" would quietly remove the only route that chain has.
      const retry = async <T>(f: () => Promise<T>): Promise<T> => {
        let last: unknown;
        for (let i = 0; i < 3; i++) {
          try {
            return await f();
          } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 700));
          }
        }
        throw last;
      };
      const code = await retry(() => cc.provider.getCode(TOKEN_MESSENGER));
      if (!code || code === '0x') return null;
      const domain = Number(
        await retry(() => new ethers.Contract(MESSAGE_TRANSMITTER, TRANSMITTER_ABI, cc.provider).localDomain() as Promise<bigint>),
      );
      const minter: string = await retry(() => new ethers.Contract(TOKEN_MESSENGER, MESSENGER_ABI, cc.provider).localMinter() as Promise<string>);
      const usdc: string = await retry(() =>
        new ethers.Contract(minter, MINTER_ABI, cc.provider).getLocalToken(0, ethers.zeroPadValue(ETH_USDC, 32)) as Promise<string>,
      );
      if (!usdc || usdc === ethers.ZeroAddress) return null;
      const limitWei: bigint = await retry(() =>
        new ethers.Contract(minter, MINTER_ABI, cc.provider).burnLimitsPerMessage(usdc) as Promise<bigint>,
      );
      if (limitWei <= 0n) return null; // deployed, but Circle has not switched burning on here
      return { domain, usdc, limitWei };
    } catch {
      return null;
    }
  })();
  if (out) supportCache.set(cc.key, out);
  else supportMiss.set(cc.key, Date.now());
  return out;
}

/** true when USDC can move between these two chains through CCTP. */
export async function cctpRoute(from: ChainCtx, to: ChainCtx): Promise<{ src: Support; dst: Support } | null> {
  const [src, dst] = await Promise.all([cctpSupport(from), cctpSupport(to)]);
  return src && dst ? { src, dst } : null;
}

/** Circle's attestation for one burn, polled until it is ready. */
async function attestation(srcDomain: number, txHash: string, timeoutMs: number): Promise<{ message: string; attestation: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'pending';
  while (Date.now() < deadline) {
    const res = await fetch(`${IRIS}/messages/${srcDomain}?transactionHash=${txHash}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.ok) {
      const j: any = await res.json().catch(() => null);
      const m = j?.messages?.[0];
      lastStatus = m?.status ?? lastStatus;
      // 'complete' is the only status that carries a usable attestation. Circle returns the
      // message itself immediately, long before it is signed -- sending that would revert.
      if (m?.status === 'complete' && m?.attestation && m.attestation !== '0x' && m?.message) {
        return { message: m.message, attestation: m.attestation };
      }
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(
    `Circle has not attested the burn yet (status: ${lastStatus}). The USDC is burned and SAFE — ` +
      `it can still be claimed on the destination chain once the attestation appears.`,
  );
}

/**
 * Move USDC from one chain to another. Two transactions with a wait between them: the burn
 * on the source chain, then the mint on the destination once Circle signs.
 *
 * If the second half fails the funds are NOT lost -- the burn is attested for good and the
 * mint can be claimed later -- so the error says so rather than reading as a loss.
 */
export async function cctpTransfer(
  from: ChainCtx,
  to: ChainCtx,
  amountWei: bigint,
  opts: { dryRun: boolean; onStep?: (s: string) => Promise<void>; timeoutMs?: number } = { dryRun: true },
): Promise<{ dryRun?: boolean; burnTx?: string; mintTx?: string; usdcSrc: string; usdcDst: string }> {
  const route = await cctpRoute(from, to);
  if (!route) throw new Error(`CCTP does not carry USDC between ${from.label} and ${to.label}.`);
  const { src, dst } = route;
  if (amountWei > src.limitWei) {
    throw new Error(
      `CCTP caps one transfer at ${ethers.formatUnits(src.limitWei, 6)} USDC on ${from.label}; ` +
        `${ethers.formatUnits(amountWei, 6)} is over that. Send it in smaller pieces.`,
    );
  }
  const me = from.wallet.address;
  const usdc = new ethers.Contract(src.usdc, ERC20_ABI, from.wallet);
  const bal: bigint = await usdc.balanceOf(me);
  if (bal < amountWei) {
    throw new Error(
      `Not enough USDC on ${from.label}: need ${ethers.formatUnits(amountWei, 6)}, have ${ethers.formatUnits(bal, 6)}.`,
    );
  }

  const messenger = new ethers.Contract(TOKEN_MESSENGER, MESSENGER_ABI, from.wallet);
  const recipient = ethers.zeroPadValue(to.wallet.address, 32);
  const args = [amountWei, dst.domain, recipient, src.usdc, ethers.ZeroHash, 0n, FINALITY_STANDARD] as const;

  if (opts.dryRun) return { dryRun: true, usdcSrc: src.usdc, usdcDst: dst.usdc };

  const allowance: bigint = await usdc.allowance(me, TOKEN_MESSENGER);
  if (allowance < amountWei) {
    await opts.onStep?.('approving USDC…');
    await (await usdc.approve(TOKEN_MESSENGER, amountWei)).wait();
  }
  // Simulated first, like every other money path: a revert here costs nothing.
  await messenger.depositForBurn.staticCall(...args, { from: me });
  await opts.onStep?.(`burning ${ethers.formatUnits(amountWei, 6)} USDC on ${from.label}…`);
  const burn = await sendTxNonceSafe(from.wallet as ethers.Wallet, await messenger.depositForBurn.populateTransaction(...args));
  const burnRc = await burn.wait();
  const burnTx = burnRc?.hash ?? burn.hash;

  await opts.onStep?.('waiting for Circle to attest…');
  const att = await attestation(src.domain, burnTx, opts.timeoutMs ?? 15 * 60_000);

  await opts.onStep?.(`minting on ${to.label}…`);
  const transmitter = new ethers.Contract(MESSAGE_TRANSMITTER, TRANSMITTER_ABI, to.wallet);
  await transmitter.receiveMessage.staticCall(att.message, att.attestation, { from: to.wallet.address });
  const mint = await sendTxNonceSafe(to.wallet as ethers.Wallet, await transmitter.receiveMessage.populateTransaction(att.message, att.attestation));
  const mintRc = await mint.wait();
  return { burnTx, mintTx: mintRc?.hash ?? mint.hash, usdcSrc: src.usdc, usdcDst: dst.usdc };
}
