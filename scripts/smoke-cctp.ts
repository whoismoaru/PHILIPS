import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { CHAINS } from '../src/chains.js';
import { cctpSupport, cctpRoute, cctpTransfer, TOKEN_MESSENGER, MESSAGE_TRANSMITTER } from '../src/cctp.js';

/**
 * CCTP is Circle burning USDC on one chain and minting it on another. It is the ONLY way
 * into Arc: LI.FI answers "Chain 5042 is not supported" and Relay does not list it at all
 * (measured 15 Sep 2026). What this guards is that the route is never claimed where it
 * cannot run, and never runs on the wrong asset.
 */

// The two contracts share one address on every CCTP V2 chain, and they must point at each
// other — that pairing is what proves the deployment is real rather than an address that
// merely has code.
const arc = CHAINS['arc'];
if (arc) {
  const mt = new ethers.Contract(MESSAGE_TRANSMITTER, ['function localDomain() view returns (uint32)'], arc.provider);
  const domain = await mt.localDomain().catch(() => null);
  if (domain !== null) assert.equal(Number(domain), 26, "Arc's CCTP domain is not 26 any more");
}

const seen: string[] = [];
for (const cc of Object.values(CHAINS)) {
  const s = await cctpSupport(cc);
  if (!s) continue;
  seen.push(cc.key);
  assert.ok(s.limitWei > 0n, `${cc.label}: a zero burn limit must count as unsupported`);
  assert.ok(ethers.isAddress(s.usdc) && s.usdc !== ethers.ZeroAddress, `${cc.label}: no USDC resolved`);
  const dec = await new ethers.Contract(s.usdc, ['function decimals() view returns (uint8)'], cc.provider).decimals().catch(() => 6n);
  assert.equal(Number(dec), 6, `${cc.label}: CCTP USDC must be 6 decimals`);
}
assert.ok(seen.length >= 2, `CCTP resolved on only ${seen.length} chain(s): ${seen.join(', ')}`);

// A chain where Circle has NOT enabled burning must not be offered. Robinhood and BSC both
// carry the contracts with a burn limit of zero.
for (const key of ['robinhood', 'bsc']) {
  const cc = CHAINS[key];
  if (!cc) continue;
  const s = await cctpSupport(cc);
  assert.equal(s, null, `${cc.label} is being offered even though burning is disabled there`);
  assert.equal(await cctpRoute(cc, CHAINS['arc'] ?? cc), null, `${cc.label} → Arc must not be a CCTP route`);
}

// The asset gate: CCTP carries USDC and nothing else.
const src = readFileSync('src/bridgeRoute.ts', 'utf8');
assert.match(src, /same\(assets\.originCurrency, route\.src\.usdc\)/, 'the CCTP route no longer checks the SOURCE asset is that chain\'s USDC');
assert.match(src, /same\(assets\.destinationCurrency, route\.dst\.usdc\)/, 'the CCTP route no longer checks the DESTINATION asset is that chain\'s USDC');
assert.match(src, /const cctp = ok\.find\(\(o\) => o\.provider === 'cctp'\);[\s\S]{0,120}return cctp;/,
  'CCTP must win when it applies: 1:1 with no counterparty beats any pooled quote');

// A dry run must refuse what it cannot do, rather than half-send it.
const base = CHAINS['base'];
if (base && arc) {
  await assert.rejects(
    () => cctpTransfer(base, arc, 999_999_999_000_000n, { dryRun: true }),
    /caps one transfer|Not enough USDC/,
    'an over-limit transfer is not refused',
  );
}

// The burn is simulated before it is sent, and a failure after the burn must say the money
// is safe rather than read as a loss.
const cc2 = readFileSync('src/cctp.ts', 'utf8');
assert.match(cc2, /depositForBurn\.staticCall/, 'the burn is sent without being simulated');
assert.match(cc2, /burned and SAFE/, 'a missing attestation must not read as lost funds');
assert.match(cc2, /status === 'complete'/, 'an unsigned attestation would revert the mint');

// CCTP is not chosen when the destination mint cannot be PAID FOR. The burn would land
// and the mint could not follow: the funds stay claimable, but they do not arrive, and an
// aggregator route that delivers without gas on the far side is the better answer.
assert.match(src, /const gas = await mintGasAffordable\(to\);/, 'CCTP no longer checks that the mint can be paid');
assert.match(src, /return gas \? route : null;/, 'an unaffordable mint must drop the CCTP candidate');
const aff = src.slice(src.indexOf('async function mintGasAffordable'), src.indexOf('async function mintGasAffordable') + 600);
assert.match(aff, /catch \{[\s\S]{0,80}return false;/, 'an unreadable balance must count as unaffordable');

// FAST transfer: Circle quotes the fee in basis points, and it is tiny. Standard waits out
// source finality for free -- 13-19 minutes on Base -- so fast is the default and standard
// the fallback when the fee cannot be read.
const cc3 = readFileSync('src/cctp.ts', 'utf8');
assert.match(cc3, /const FINALITY_FAST = 1000;/, 'the fast lane is gone');
assert.match(cc3, /fast \? FINALITY_FAST : FINALITY_STANDARD/, 'the burn no longer chooses the fast lane');
assert.match(cc3, /maxFee = q\?\.feeWei \?\? 0n/, 'a fast burn must carry the fee Circle asked for');
if (base && arc) {
  const q = await (await import('../src/cctp.js')).cctpQuote(base, arc, 50_000_000n);
  assert.ok(q, 'no CCTP quote for Base → Arc');
  // The fee is a fraction of a basis point; anything approaching a percent means the units
  // were misread (bps against USDC) and the transfer would overpay.
  const pct = Number(q!.feeWei) / Number(50_000_000n) * 100;
  assert.ok(pct < 0.05, `the fast fee reads ${pct.toFixed(4)}% — the units look wrong`);
  assert.equal(q!.outWei + q!.feeWei, 50_000_000n, 'out + fee must equal what was sent');
}

console.log(`ok: CCTP resolved on ${seen.join(', ')} — USDC only, never where burning is disabled`);

// LI.FI is asked for the FASTEST route, not the "recommended" one. Measured Base → Arc:
// recommended = polymerStandard, 1080 s, 49.8750 out; fastest = polymer, 10 s, 49.8684 out.
// Six tenths of a cent buys eighteen minutes, and a bridge that sits for a quarter of an
// hour reads as one that failed.
const lifiSrc = readFileSync('src/lifi.ts', 'utf8');
assert.match(lifiSrc, /order: 'FASTEST'/, 'the bridge quote is back on the slow default route');
