/**
 * Chains switched off from /settings, stored in data/chains-off.json.
 *
 * An off chain is dropped from CHAINS itself (chains.ts), so every card, list and flow that
 * walks CHAINS skips it with no change of its own. Solana is not in CHAINS; its switch is
 * read where its RPC URL is (solana/rpc.ts), which every Solana path goes through.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './store.js';

const FILE = join(process.cwd(), 'data', 'chains-off.json');
let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    cache = new Set(existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

export const isOff = (key: string): boolean => load().has(key);

/** Flip one chain; returns true when it is now ON. */
export function toggle(key: string): boolean {
  const s = load();
  const on = s.has(key);
  if (on) s.delete(key);
  else s.add(key);
  writeJson(FILE, [...s]);
  return on;
}
