import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { rpcUrl } from './rpc.js';
import { highPriorityMicro, broadcastOfficial } from './fees.js';
import type { SolKeypair } from './keys.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function solConn(): Connection {
  const url = rpcUrl();
  if (!url) throw new Error('No Solana RPC configured.');
  return new Connection(url, 'confirmed');
}

/**
 * Sign and land a set of instructions: the official "high" fee bid, sent to our RPC and
 * the official one, re-broadcast every 2s until confirmed. An expired wait asks the chain
 * whether it landed before calling it a failure.
 */
export async function landInstructions(
  kp: SolKeypair,
  ixs: TransactionInstruction[],
  alts: AddressLookupTableAccount[] = [],
  cuLimit = 200_000,
): Promise<string> {
  const conn = solConn();
  const user = Keypair.fromSeed(Buffer.from(kp.seed));
  const micro = Math.max(50_000, (await highPriorityMicro())?.micro ?? 0);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }), ...ixs],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(message);
  tx.sign([user]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 3 });
  const b64 = Buffer.from(raw).toString('base64');
  broadcastOfficial(b64);
  const resend = setInterval(() => {
    conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    broadcastOfficial(b64);
  }, 2_000);
  try {
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').catch(async (e) => {
      for (let i = 0; i < 5; i++) {
        const st = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null))?.value;
        if (st) return { value: { err: st.err } };
        await new Promise((res) => setTimeout(res, 3_000));
      }
      throw new Error(`the transaction never landed (${sig}); nothing left the wallet, so it is safe to try again. ${(e as Error).message.slice(0, 60)}`);
    });
    if (r.value.err) throw new Error(`the transaction failed on-chain (${sig})`);
  } finally {
    clearInterval(resend);
  }
  return sig;
}

const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/**
 * Send `amount` base units of `mint` (WSOL = native SOL) to `to`. An SPL token goes from
 * the owner's associated account to the recipient's, which is created first if missing
 * (the sender pays its rent, ~0.002 SOL). Works for both the classic and 2022 programs.
 */
export async function sendSol(kp: SolKeypair, to: string, mint: string, amount: bigint): Promise<string> {
  const from = Keypair.fromSeed(Buffer.from(kp.seed)).publicKey;
  const dest = new PublicKey(to);
  if (mint === WSOL) {
    return landInstructions(kp, [SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: amount })], [], 20_000);
  }
  const conn = solConn();
  const m = new PublicKey(mint);
  const info = await conn.getAccountInfo(m);
  if (!info) throw new Error('That token mint could not be read.');
  const program = info.owner;
  const decimals = info.data[44];
  const src = ata(from, m, program);
  const dst = ata(dest, m, program);
  const createDst = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: false },
      { pubkey: m, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent: a no-op when the account already exists
  });
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  const transfer = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: from, isSigner: true, isWritable: false },
    ],
    data,
  });
  return landInstructions(kp, [createDst, transfer], [], 80_000);
}
