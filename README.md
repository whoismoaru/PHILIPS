# PHILIPS | Single-sided LP bot for Telegram

Open and manage **single-sided** liquidity positions from a Telegram chat. Three chains
ship configured: Uniswap v3 and v4 on your primary chain, PancakeSwap v3 and Uniswap v3
on BSC, and Uniswap v3 on Base. Pools come from the Uniswap gateway, Krystal, and
on-chain scans, ranked by TVL and volume. You decide when to open and close; the bot
handles the wizard, token screening, valuation, alerts, and cash-out.

> **Self-hosted, single owner.** One running instance serves exactly one Telegram
> account. The wallet, positions, journal, and alert settings are process-global — there
> is no per-user separation. Run your own instance; do not hand the bot to friends.
> See [Security model](#security-model) before funding it.

## Requirements

- Node 20+, npm
- A Telegram bot token (@BotFather) and your numeric Telegram id (@userinfobot)
- An RPC endpoint for your chain — use a keyed one; public endpoints rate-limit
- A wallet you are willing to dedicate to this bot
- Optional: `npm i -g gmgn-cli` for the full token-security card

## Setup

```bash
git clone https://github.com/whoismoaru/PHILIPS.git philips && cd philips
npm install
cp .env.example .env      # then fill it in — every field is documented inside
npm start
```

In Telegram: `/start`, then `/settings` → **Connect Wallet** and paste a private key or
seed phrase. The message containing your key is deleted from the chat immediately and the
key is stored as an encrypted keystore (`data/keystore.json`, scrypt + AES, chmod 600).

Keep `DRY_RUN=true` until `/status`, `/positions`, and a dry `/add_lp` all look right.
Then set `DRY_RUN=false` and start with a small amount.

### Running under systemd

```ini
[Unit]
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0          # do not let a transient outage wedge the unit in "failed"

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/philips
ExecStart=/home/youruser/philips/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=10
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

## Commands

| Command | What it does |
|---|---|
| `/start` · `/help` | Menu, bot mode, command list |
| `/status` | Portfolio: equity, per-chain balances, idle tokens |
| `/positions` | Active LP positions (pair, chain, PnL, range, status) |
| `/pnl` | Lifetime PnL recap from closed trades |
| `/add_lp` | Open a single-side LP — or paste a contract address directly |
| `/claim_fees` | Collect fees without closing the position |
| `/remove_lp` | Withdraw 25 / 50 / 75 / 100% of a position |
| `/stop` | Close a position and cash out |
| `/buy` · `/sell` | Swap a token via the best of Uniswap / Relay |
| `/unwrap` | Convert stuck wrapped native (WETH/WBNB) back to native |
| `/bridge` | Move native funds between chains via Relay |
| `/settings` | Wallet connect/disconnect, transaction preferences |
| `/alerts` | Range, price-drop, and net-loss notification toggles |

Every step has **Back** and **Cancel**. Money actions always take one explicit
confirmation tap and are guarded against double-taps.

## Token screening

Before you LP, the bot screens the token via the chain explorer, DexScreener, and
optionally GMGN: contract verified / proxy, holder concentration (top-1 / top-10),
liquidity and 24h volume, buy-vs-sell ratio, pool age, and a simulated sell (honeypot
check). Verdict: **safe / proceed with caution / do not LP** — a heuristic, not a
guarantee. A "do not LP" verdict blocks the position rather than warning about it.

## Security model

Read this before putting real money in.

- **Single owner.** `TELEGRAM_ALLOWED_USER_ID` is the entire access control. Anyone who
  gets into that Telegram account controls the wallet.
- **The bot holds a hot key.** It signs unattended: the monitor sweeps leftover tokens and
  unwraps stray wrapped native on its own. Fund it like a hot wallet, not a vault.
- **Keystore at rest.** Encrypted with `WALLET_SECRET`. If you leave that empty, the bot
  token is used instead — and rotating your bot token then makes the key unrecoverable.
  Anyone who can read both the disk and `.env` can open the keystore.
- **Slippage floors.** Mints, swaps, and liquidity withdrawals all carry a minimum-output
  floor; `minOut = 0` exists nowhere. Swap previews expire after 2 minutes, and execution
  aborts if the price has moved more than 3% away from the number you approved.
- **Per-transaction caps.** `MAX_ETH_PER_TX` limits native amounts (ETH, BNB),
  `MAX_STABLE_PER_TX` limits stablecoin amounts in dollars. Each denomination has its own
  limit; they are never summed. Empty falls back to a built-in default — a cap can be
  raised, never switched off. Token-side amounts have no fixed number that would mean
  anything, so their ceiling is the wallet's actual balance of that token.

### Closing a position cashes out the whole wallet

By design, `/stop` does not stop at the position's own output: it swaps **every** unit of
that token held by the wallet into native, and unwraps **all** wrapped native. This is
deliberate — closing means ending up in ETH, not carrying a leftover bag. If you keep a
spot position in the same token outside the LP, close the LP first or move that bag to
another wallet.

## Data

Everything lives in `data/` (git-ignored): `keystore.json` (encrypted key),
`positions.json`, `journal.jsonl`, `settings.json`, `alerts.json`, `v4positions.json`.
Back this directory up — `journal.jsonl` and `positions.json` are the only record of your
cost basis. If `positions.json` is ever corrupt the bot moves it aside and refuses to
start rather than silently overwriting it.

## Read-only checks

```bash
npm run check                        # typecheck
npx tsx scripts/smoke.ts             # read prices and build an LP plan, no tx
npx tsx scripts/smoke-journal.ts     # accounting
npx tsx scripts/smoke-amount.ts      # amount parser
```

## Not supported

Multiple users on one instance, non-custodial signing, Solana, and automatic position
opening. The bot proposes; you tap.
