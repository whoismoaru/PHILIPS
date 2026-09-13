/**
 * A single retry for money paths, refereed by on-chain state.
 *
 * On a money path the most common failure happens AFTER the transaction has landed: a
 * stale balance read, a wait that times out, a verification that fails. Retrying there
 * means buying, selling or minting twice with money nobody approved twice. So the referee
 * is on-chain state, NEVER the kind of error -- an error message can never be trusted about
 * what did or did not land.
 *
 * An error thrown once the state HAS moved is marked `landed = true`: the transaction
 * landed, so a plain "failed" message would mislead the owner into thinking the money never
 * left and trying again. See `msgError`.
 *
 * `probe` returns a number that is CERTAIN to change if anything landed: a balance, a
 * liquidity figure, a position NFT count. Returning -1n or throwing means it cannot be
 * established, which is treated as "it moved" and never retried. When in doubt, stop.
 */
export type RetryLog = (line: string) => void;

export async function retryOnce<T>(
  label: string,
  probe: () => Promise<bigint>,
  run: () => Promise<T>,
  opts: { onRetry?: () => Promise<void>; sleepMs?: number; log?: RetryLog } = {},
): Promise<T> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const before = await probe().catch(() => -1n);
  try {
    return await run();
  } catch (first) {
    const after = await probe().catch(() => -1n);
    const why = (first as Error).message.slice(0, 160);
    if (before < 0n || after < 0n || after !== before) {
      log(`[retry:${label}] TAK diulang (state ${before}→${after}): ${why}`);
      // A valid probe whose number moved means the transaction REALLY landed (a mint, close or swap
      // succeeded even though run() threw). A -1n probe means unreadable, so claim nothing.
      if (before >= 0n && after >= 0n) (first as { landed?: boolean }).landed = true;
      throw first;
    }
    log(`[retry:${label}] attempt 1 failed and the chain did not move, retrying: ${why}`);
    if (opts.onRetry) await opts.onRetry().catch(() => {});
    await new Promise((r) => setTimeout(r, opts.sleepMs ?? 2500));
    return await run();
  }
}
