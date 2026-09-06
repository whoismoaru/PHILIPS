/**
 * What a Uniswap V4 hook is PERMITTED to do, read from its own address.
 *
 * V4 encodes a hook's permissions in the low 14 bits of the hook address — the
 * PoolManager itself dispatches off those bits, so they cannot lie: a hook whose
 * AFTER_SWAP bit is clear will never have afterSwap called, whatever its source
 * code says.
 *
 * This is arithmetic on an address we already hold. No API, no key, no network,
 * no credits, and it keeps answering when a paid audit is down, out of credits,
 * or has simply never seen the hook. It is a PERMISSIONS read, not an audit: it
 * says what the hook MAY do, never whether it does it honestly.
 */

/** Bit -> name, index = bit position. Order is fixed by the V4 spec. */
const FLAGS = [
  'afterRemoveLiquidityReturnDelta',
  'afterAddLiquidityReturnDelta',
  'afterSwapReturnDelta',
  'beforeSwapReturnDelta',
  'afterDonate',
  'beforeDonate',
  'afterSwap',
  'beforeSwap',
  'afterRemoveLiquidity',
  'beforeRemoveLiquidity',
  'afterAddLiquidity',
  'beforeAddLiquidity',
  'afterInitialize',
  'beforeInitialize',
] as const;

export type HookPower = {
  /** Plain-language capability, worst first. */ label: string;
  /** true = can cost the LP money or block an exit. */ severe: boolean;
};

/**
 * The powers that matter TO AN LP, not to a trader.
 *
 * `beforeRemoveLiquidity` is the one that ends positions: a hook holding it can
 * refuse the burn, and the money is simply stuck. The *ReturnDelta bits are the
 * skim — they let the hook keep part of the amount that would otherwise be paid
 * out. Everything else is disclosed but not flagged.
 */
const MEANING: Partial<Record<(typeof FLAGS)[number], HookPower>> = {
  beforeRemoveLiquidity: { label: 'can block/condition your EXIT', severe: true },
  afterRemoveLiquidityReturnDelta: { label: 'can skim your withdrawal', severe: true },
  afterAddLiquidityReturnDelta: { label: 'can skim your deposit', severe: true },
  beforeSwapReturnDelta: { label: 'can take a cut of every swap', severe: true },
  afterSwapReturnDelta: { label: 'can take a cut of every swap', severe: true },
  beforeAddLiquidity: { label: 'can block/condition deposits', severe: false },
  afterRemoveLiquidity: { label: 'runs code on withdrawal', severe: false },
  beforeSwap: { label: 'runs code on every swap', severe: false },
  afterSwap: { label: 'runs code on every swap', severe: false },
};

export type HookFlags = {
  address: string;
  bits: number;
  /** Every permission the address grants, in spec order. */ granted: readonly string[];
  /** Deduplicated LP-relevant powers, severe first. */ powers: HookPower[];
  severe: boolean;
};

/** `null` when there is no hook (address zero) or the address is unreadable. */
export function decodeHookFlags(addr: string | null | undefined): HookFlags | null {
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  const bits = Number(BigInt(addr) & 0x3fffn);
  if (bits === 0) return null; // a hookless pool, or a hook with no permissions

  const granted = FLAGS.filter((_, i) => ((bits >> i) & 1) === 1);
  const seen = new Set<string>();
  const powers: HookPower[] = [];
  for (const n of granted) {
    const m = MEANING[n];
    // The two swap-skim bits share one label; showing it twice says nothing new.
    if (m && !seen.has(m.label)) {
      seen.add(m.label);
      powers.push(m);
    }
  }
  powers.sort((a, b) => Number(b.severe) - Number(a.severe));
  return { address: addr, bits, granted, powers, severe: powers.some((p) => p.severe) };
}
