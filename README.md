# PHILIPS

**A Telegram bot that opens single-sided liquidity positions for you, on EVM chains and Solana.**

You deposit one asset: ETH, BNB, SOL or a stablecoin. The position sits below the
current price like a limit buy. While it waits it earns trading fees, and if the price
comes down to it, your deposit turns into the token. You were paid to wait for your
entry.

There is no dashboard and no browser wallet. Everything happens in a Telegram chat.


## Install

On a fresh Ubuntu server:

```bash
curl -fsSL https://raw.githubusercontent.com/whoismoaru/PHILIPS/main/philips.sh -o philips.sh && bash philips.sh
```

Pick **option 1**. The script installs Node, downloads the code, asks a few questions
and starts the bot as a system service. It never asks for your private key; you give
that to the bot later, inside Telegram.

Have these ready:

| What | Where |
|---|---|
| A bot token | [@BotFather](https://t.me/BotFather), send `/newbot` |
| Your Telegram user id | [@userinfobot](https://t.me/userinfobot) |
| RPC endpoints | A keyed provider such as Alchemy. Public endpoints rate-limit and then every read fails. |
| For Solana | A keyed Solana RPC (Helius, QuickNode, Triton) and a free Jupiter API key from [developers.jup.ag/portal](https://developers.jup.ag/portal) |

Every EVM chain also has a public backup RPC that takes over when yours errors or stalls.

---

## First run

1. **Send `/start`.** The installer already sent you a test message, so a wrong token
   or user id shows up before this point. If the bot stays silent, run
   `journalctl -u philips-bot -n 50`. A 409 there means another copy of the bot is
   using the same token.
2. **Connect a wallet.** `/settings` → **Connect Wallet** for EVM, **Connect SOL Wallet**
   for Solana. Paste a private key or seed phrase. The bot deletes your message right
   away and stores the key encrypted on your server (`data/keystore.json`, scrypt + AES,
   file mode 600).
3. **Send `/portfolio`.** If your balances show up, the bot can read the chains.
4. **Paste a token's contract address** and try the flow. The bot starts in **DRY RUN**:
   it simulates everything and sends nothing.
5. **Go live.** Run `bash philips.sh` again and pick **option 6**. Start small.

---

## Chains

| Chain | Where it LPs | You deposit | On by default |
|---|---|---|---|
| Robinhood | Uniswap v3 + v4 | ETH, USDG | yes (primary) |
| BSC | PancakeSwap v3, Uniswap v3 + v4 | BNB, USDT | yes |
| Base | Uniswap v3 + v4 | ETH, USDC | yes |
| HyperEVM | HyperSwap v3 | HYPE, USDT0 | yes |
| Solana | Meteora DLMM | SOL | when `SOLANA_ENABLED` and an RPC are set |
| Arc | Uniswap v3 + v4 | USDC only | no, needs `ARC_RPC_URL` |
| Ink | Velodrome Slipstream | ETH, USDT0 | no |

You can switch chains on and off at any time: `/settings` → **Chains on/off**.

**Arc** pays gas in USDC, so USDC is the only thing you can deposit there. `/bridge`
reaches it through Circle's CCTP.

**Solana** runs on its own code path rather than through the EVM chain registry. It
LPs only in Meteora DLMM pools, and every close ends in native SOL.

---

## Looking at a token

Paste any contract address, EVM or Solana. The bot finds which chain it lives on and
shows one card:

```
📊 TOKEN STATISTICS

$TRUMAN | Truman World (BSC)
├ Price: $0.001164
├ MCap: $1.16M
├ Liq: $79.2K
├ Vol 24h: $1.17M
└ Age: 4d 3h

💦 AVAILABLE POOLS :
1. $TRUMAN/$USDT (v4, fee 4.7%)
   └ Tvl: $10.3K | Vol: $5.1K | Bin: 9.86%
2. $TRUMAN/$USDT (v4, fee 5.2%)
   └ Tvl: $8.1K | Vol: $0 | Bin: 0.01%
```

Under it are buttons to **buy** (four fixed amounts and four percentages of your
balance), one button per pool to **open an LP** in it, and **Sell** or **Close LP** if
you already hold the token or have a position in it.

**Bin** is the price step between two usable ticks: the width of one rung in the pool.
Token stats come from GMGN, with GeckoTerminal as the fallback. Pools come from
GeckoTerminal. When a v4 pool's key is not known to any API, the bot reads it from the
pool's creation event on-chain.

---

## Opening a position

Tap a pool on the token card.

**The bot screens the token first** (EVM). It checks whether the contract is verified,
how concentrated the holders are, how deep the liquidity is, how old the pool is, and it
simulates a sell to catch honeypots. The card tells you what it found. A token that fails
the hard checks stops the flow, and there is no button to override that.

**Pick a range**: `-10%`, `-30%`, `-50%`, `-70%` or `-90%` below the current price. Every
position here is single-sided from the top: you deposit the base (ETH, BNB, SOL, a
stablecoin), never the token, and it converts only as the price falls into your range.

**Pick an amount.** Tap one of four fixed amounts or four percentages, or type a number.
Percentages come from your usable balance, after the gas reserve is set aside.

**The amount is the last step, and it opens the position.** There is no extra confirm
screen. You get a POSITION OPENED card with the gas you paid and a link to the
transaction.

### Spot or bid-ask

`/settings` → **LP shape** decides how every deposit is laid out, on both EVM and Solana.

- **Spot**: one position across the whole range. Simple, and it earns the most fees.
- **Bid-ask**: a ladder of several positions with more money at the lower prices. It
  buys more of the token the further it drops, but earns less in fees. After the range,
  the bot asks how many legs you want. The choices come from **Ladder legs** in settings.

On EVM, all the legs open in one batched transaction. On Solana each leg is its own
DLMM position and opens in its own transaction.

### Solana notes

- **Rent.** Opening a DLMM position locks about 0.057 SOL of rent, which you get back
  when you close. Sometimes a range is the first to use part of a pool, and Meteora
  charges extra rent to set that part up. That extra part is **not** refunded. The bot
  quotes the cost before sending, and it refuses to open anything where less than 90%
  of the cost comes back.
- **Wide ranges.** One DLMM position holds at most 69 bins. With bid-ask, a range that
  needs more bins is split across legs, so `-90%` still works.
- **The range is shown as market cap**, the same way as on EVM.

---

## Closing a position

`/positions` lists everything that is open, across every chain:

```
📊 POSITIONS

🟢 $VYNEX/USDG | #1234568 (V4)
├ Chain: Robinhood
├ Strategy: USDG Single Side (buy the dip)
├ Invested: 199,0800 USDG
├ Total Fees: +$6,70
├ PnL: +3.1% / $7
├ Range: $1.68M ⇄ $165.5K / now $1.70M
└ Status: Active (in range), 25m
```

Tap one for detail and a **Close Position** button. Closing runs straight away:
withdraw the liquidity, collect the fees, swap the token back, and send you a POSITION
CLOSED card plus a PnL picture.

- **EVM** positions cash out into what you deposited (ETH, BNB or the stablecoin).
- **Solana** positions always cash out into native SOL.
- **A ladder closes as one**: every leg, one swap, one card, one PnL.
- If the swap back fails on Solana, the bot keeps retrying in the background for 15
  minutes, then adds the result to that position's PnL.

`/stop` shows every open position with its own close button, and **Close All** in
`/positions` closes them all, EVM and Solana.

![Closed position card](assets/pnl-closed.jpg)

To use your own artwork behind the PnL card, send the bot a photo from `/settings` →
**PnL bg**. The text is drawn in Liberation Sans and DejaVu Mono. On a server with no
fonts installed you get the picture and no text, so install them with
`apt install fonts-liberation fonts-dejavu-core fonts-dejavu-mono` (the installer does
this for you).

---

## Limit orders

So you don't have to watch the chart. Both are based on **market cap**.

- **Limit entry.** Walk through the LP flow as usual, and at the amount step tap
  **⏰ Limit Entry** instead of an amount. Type the target market cap and the amount,
  for example `500K 100`. When the market cap reaches that target, the bot opens the
  position with the pool, range and legs you picked.
- **Take profit.** Open a position from `/positions` and tap **🎯 Take Profit**. Type
  the market cap to close at, for example `2M`. When it gets there, the bot closes the
  position exactly as the Close button would.

`/limits` lists your open orders and lets you cancel them.

How it works, and what that means for you:

- The bot checks every 30 seconds. A move that starts and ends inside that window can
  be missed.
- Nothing is placed on-chain. If the bot is stopped, nothing fires.
- When a target is crossed, the bot replays the same taps you would make, so every
  normal check still applies: balance, gas reserve, price impact, the Solana rent rule.
  It fills at the price of that moment, not at your target.
- An order runs once. If it fails, the bot tells you why and removes it.
- Limit orders only run in LIVE mode.

---

## Commands

| Command | What it does |
|---|---|
| `/start` | The main menu |
| `/portfolio` | Total equity, what is in LP, and your balances on every chain |
| `/positions` | Open positions on every chain; tap one to see it, close it, or set a take profit |
| `/limits` | Your limit entry and take-profit orders |
| `/pnl` | Pick a chain and a period; the recap comes back as a picture |
| paste an address | The token card: buy, sell, or open an LP |
| `/swap` | Sell anything in your wallets, EVM or Solana, sorted by value |
| `/bridge` | Move funds between EVM chains, or between an EVM chain and Solana |
| `/withdraw` | Send funds to another address. Paste a `0x…` or a Solana address |
| `/claim_fees` | Collect fees and keep the position running |
| `/gas` | What a swap, an LP and a withdrawal cost right now on each chain, in USD and Rupiah |
| `/alerts` | Choose which notifications you get |
| `/settings` | Presets, LP shape, chains, wallets |
| `/help` | A short guide |

`/stop`, `/buy`, `/unwrap` and `/add_lp` still work when you type them, but they are
kept off the menu: each one starts somewhere else now. `/sell`, `/send` and `/status`
are old names for `/swap`, `/withdraw` and `/portfolio`.

**Nothing asks twice.** Buying, selling, bridging, withdrawing and opening an LP all run
the moment you pick the amount, and closing runs on the tap. The checks still happen
first: balance, gas reserve, price impact and slippage. Every money action is also
guarded against a double tap.

---

## Settings

`/settings` has two sections, one per chain family, plus a few shared options.

**EVM Settings**
- **Buy, Swap and Add LP presets.** Each has four amounts and four percentages. Native
  presets are in each chain's own coin (ETH, BNB, HYPE). Stablecoin presets are in
  dollars and are used when a pool or purchase is paid in USDG, USDT or USDC.
- **LP shape** and **Ladder legs**.
- **Close LP %**: the buttons for a partial close.

**SOL Settings**
- **Buy, Swap and Add LP presets**, in SOL.
- **Range -%**: the range buttons for a Solana LP.
- **LP shape** and **Ladder legs**, the same settings as on EVM.

**Shared**: **Bridge %**, **Withdraw %**, **Chains on/off**, **PnL bg**, and
connecting or disconnecting each wallet.

A preset is edited in one line, amounts first:

```
0.01 0.05 0.1 0.5 & 10% 25% 50% 100%
```

Everything is saved in `data/` and survives restarts.

---

## Limits the bot enforces

These are fixed in the code, on every chain:

| Rule | Value |
|---|---|
| Price impact, buying | 3% max |
| Price impact, selling | 10% max |
| Swap slippage | starts at 1%, retries at 2%, then 3% max |
| Bridge price impact | 3% max |
| Gas | each chain's official "high" rate, no ceiling, so transactions land |
| Solana priority fee | the official RPC's "high" rate for that account |

Price impact is measured against a trade one tenth the size on the same route, so the
pool's own fee is not counted as impact.

---

## Bridging

`/bridge` picks the route for you:

- **EVM to EVM**: LI.FI or Relay, whichever returns more. USDC to USDC goes through
  Circle's CCTP.
- **EVM and Solana**: Relay, in both directions. You choose the asset to send (native
  or stablecoin), and when sending from Solana, whether to receive native or a stablecoin.

The result card shows what arrived, the bridge fee, the gas, and buttons to the
explorer and the bridge's tracker. When Relay can confirm the funds have landed, the
card says **BRIDGE FILLED**. Until it can, the card says **BRIDGE SENT**.

---

## Before you fund it

This bot holds hot wallet keys and signs transactions by itself. Treat it like a hot
wallet, not a vault.

- **One owner.** Your Telegram user id is the only access control. Whoever controls that
  Telegram account controls the wallets.
- **It signs unattended.** A background loop sweeps leftover tokens and unwraps stray
  wrapped native once a minute.
- **There is no stop-loss.** Alerts tell you when a position moves. They don't act.
  Take profit is the only automatic close.
- **Limit orders act on their own.** When a target is crossed, the bot opens or closes a
  position without asking.
- **Gas has no ceiling.** The bot pays whatever each chain's official "high" rate is at
  that moment. During a spike that can be expensive.
- **Your keystore is only as strong as `WALLET_SECRET`.** The installer generates a
  random one. Anyone who can read your disk and your `.env` can open the wallets.

What the bot does to protect you:

- **Approvals are for the exact amount**, never unlimited.
- **Swaps have a floor.** The minimum output comes from a quote and is never zero.
- **Closes have a price band.** A withdrawal reverts rather than fill after someone moves
  the pool against it (3% band).
- **Closing sells only what the position returned.** Tokens you already held are left alone.
- **On BSC, transactions go through a private relay**, so they never sit in the public
  mempool waiting to be sandwiched.
- **Every EVM transaction is simulated first.** If the simulation fails, nothing is sent.
- **A Solana transaction is sent to your RPC and the official one**, and re-sent every
  2 seconds until it confirms. If it expires, the bot asks the chain whether it landed
  before telling you anything, so a retry never opens a second position.

---

## Your data

Everything lives in `data/`, which is never committed.

- **Back these up**: `keystore.json`, `keystore-sol.json` (your encrypted keys),
  `positions.json`, `v4positions.json`, `solpositions.json`, `journal.jsonl`
- **Settings**: `pctpresets.json`, `lpshape.json`, `chains-off.json`, `alerts.json`,
  `pnl-bg.jpg`
- **Safe to delete**: `poolkeys.json`, `sweep.json`, `pctpending.json`

`journal.jsonl` and the positions files are the only record of what you paid for each
position. Lose them and PnL is lost with them.

---

## Running it yourself

```bash
git clone https://github.com/whoismoaru/PHILIPS.git philips && cd philips
npm ci
cp .env.example .env      # every setting is explained inside
npm start
```

Needs Node 20 or newer.

**Checks that never send a transaction:**

```bash
npm run check                                        # typecheck
for f in scripts/smoke-*.ts; do npx tsx "$f"; done   # the smoke tests
```

The smoke scripts cover the parts where a mistake costs money: slippage, approval
amounts, withdrawal floors, sell routing and PnL accounting. Some are pure maths; the
rest read live chains but never sign.

Set `PHILIPS_HARNESS=1` to load every handler without connecting to Telegram or starting
the background loops. That lets a script drive the bot through `bot.handleUpdate` with
a fake Telegram API.

---

## When something breaks

| Symptom | What to do |
|---|---|
| The bot doesn't reply | `sudo journalctl -u philips-bot -n 50`. Usually a wrong user id |
| "Missing X in your .env file" | That setting is empty. `bash philips.sh` → option 3 |
| Every read fails at once | Your RPC is rate-limiting you. Use a keyed endpoint |
| "Insufficient funds" | Not enough native coin left for gas. Try `/unwrap` |
| A Solana swap or LP is slow | Your Solana RPC is rate-limiting (HTTP 429). A paid plan fixes it |
| A position won't close | Check `journalctl`. The bot holds tokens rather than dump them at any price |

---

## Not supported

Several users on one bot, signing without holding the key, stop-loss orders.

---

MIT licensed. Run your own copy.
