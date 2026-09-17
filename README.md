# PHILIPS

**A Telegram bot that opens single-sided liquidity positions for you.**

You deposit one token. The position sits there like a limit order, earning trading
fees while it waits for your price. When price arrives, your deposit converts into
the other token, and you were paid to wait.

No dashboards, no browser wallet. You tap buttons in a Telegram chat.


## Install in one command

On a fresh Ubuntu server :

```bash
curl -fsSL https://raw.githubusercontent.com/whoismoaru/PHILIPS/main/philips.sh -o philips.sh && bash philips.sh
```

Pick **option 1**. The script installs Node, downloads the code, asks you a few
questions, and starts the bot as a system service. It never asks for your private
key. That happens inside Telegram, later.

You will need two things before you start :

| What | Where to get it |
|---|---|
| A bot token | Message [@BotFather](https://t.me/BotFather), send `/newbot` |
| Your Telegram id | Message [@userinfobot](https://t.me/userinfobot) |

An RPC endpoint helps too. Use a keyed one (Alchemy, your own node).
Free public endpoints rate-limit, and then every read fails at once. Every chain
also carries a public backup that takes over when the primary errors or stalls, so
one bad endpoint no longer takes the bot down with it.

---

## First run

After the installer finishes, open Telegram and talk to your bot :

**1.** The installer already sent you a test message and said whether Telegram accepted
it, so a wrong token or id is caught before you get here. Send `/start`; you should see a
welcome card. If the bot stays silent even though the test message arrived, read
`journalctl -u philips-bot -n 50`: a 409 there means the same token is being polled by
another instance, and only one of them can ever receive anything.

**2.** Send `/settings` → **Connect Wallet** → paste a private key or seed phrase.
The message is deleted from the chat immediately, and the key is stored encrypted
on your server (`data/keystore.json`, scrypt + AES, file mode 600).

**3.** Send `/portfolio`. Your balances should appear. If they do, the bot can read
the chain correctly.

**4.** Paste a token's contract address and walk through the wizard. The bot starts in
**DRY RUN**, so it simulates everything and sends no transactions and in that mode the
plan card is shown instead of a deposit being made.

**5.** When all of that looks right, run `bash philips.sh` again and pick
**option 6** to switch to LIVE. Start with a small amount.

---

## Opening a position

Send `/add_lp`, or just paste a token's contract address into the chat.

**Step 0. The bot screens the token first.** Contract verified or proxy, how
concentrated the holders are, how deep the liquidity is, how old the pool is, and
a simulated sell to catch honeypots.

  The card reports what it found and leaves the judgement to you. One case is not
  left to you: a token that fails the hard checks **stops the wizard**, and there is
  no button to override it.

**Step 1. Pick a pool.** Up to three, ranked by liquidity and volume, gathered
from the Uniswap gateway, Krystal, and on-chain scans.

**Step 2. Pick how wide the range is.** Five buttons, **Tightest** (±10%) through
**Widest** (±90%).

You always deposit the **base** side, ETH / BNB / a stablecoin, never the token
itself. The position waits *below* the current price: a limit buy that earns fees
while it waits. The base is fixed the moment you pick the pool, so there is no
side to choose. (Token-side entries were removed in September 2026.)

**The shape is a setting, not a step.** `/settings` → **LP Shape** decides how every
base-side entry is laid out, so the wizard never asks.

- **Spot.** One position near the price. Simplest, and it harvests the most fees.
- **Bid-Ask.** A ladder of several positions, with more money placed at the lower
  prices. It buys more of the token the deeper it dips and protects your capital,
  but earns less in fees. You pick how many legs **8 to 10 is the sweet spot**.
  More legs is smoother but needs a paid RPC; on a free endpoint it makes the bot
  slow. All the legs open in one batched transaction and are managed as one position.

  Open any leg and the card shows the ladder first: deposit, current value, fees,
  PnL, and how many rungs are filled, active, or still waiting then the one leg you
  tapped. A leg that fills is doing its job, so it is marked filled rather than
  flagged as a position gone wrong.

**Step 3b. How many legs** only when LP shape is BID-ASK. The choices come from
`/settings` → **Ladder legs**, and anything from 15 up is marked as needing a paid RPC.

**Step 4. How much.** Tap a percentage of your balance, or type an exact number.
Percentages are taken from your *usable* balance: the gas reserve is set aside
first, so the largest button never leaves you unable to pay for the transaction.
The buttons themselves are yours to change see **Quick percentages** below.

**The amount is the last question, and answering it opens the position.** There is no
confirmation card in between: the range, the shape and the pool are already chosen by
then, so the number you enter is the one that goes on chain.

---

## Commands

| Command | What it does |
|---|---|
| `/start` · `/help` | Menu and bot mode |
| `/portfolio` | Total equity, and what you hold on each chain |
| `/positions` | Your live positions; tap one for full detail |
| `/pnl` | Pick a chain, then a period: the recap renders as a picture card |
| paste a contract address | Audit the token, then open a position, buy, or sell |
| `/claim_fees` | Take the fees, leave the position running |
| `/swap` | Swap any token in your wallet, via the best available route |
| `/bridge` | Move funds between chains |
| `/withdraw` | Withdraw a token or native to another address |
| `/gas` | What a transaction costs right now on every chain, in USD and Rupiah |
| `/settings` | Mode, LP shape, quick percentages, PnL card background (it *shows* the per-tx limits; those are set in `.env`) |
| `/alerts` | Which notifications you want |
| `/add_lp` | Open a position without pasting a contract address first |

`/stop`, `/buy` and `/unwrap` still work when typed, but are kept off the menu: closing
belongs to the position it closes, buying starts from a pasted contract address, and
stray wrapped native is unwrapped by the monitor every minute. `/sell` and `/send` are
the old names for `/swap` and `/withdraw`, and `/status` for `/portfolio`, kept alive as
hidden aliases.

**Nothing asks twice.** Swapping, bridging, withdrawing and opening an LP all execute on
the amount you enter, and **Close Position** and **Close All** execute on the tap. Every step still has
**Back**, every money path is guarded against double-taps, and every one of them checks
your balance, the per-transaction limit and the gas reserve *before* anything is sent
what was removed is the second tap, not the guards.

**`/swap` sees your whole wallet,** not just what the bot bought: it reads the token
balances straight from the chain, so a coin you picked up somewhere else is still
sellable here.

`/positions` lists what is open, one block per position:

```
📊 POSITIONS

🟢 $PONS/USDT | #1234567 (V3)
├ Chain: BSC
├ Strategy: USDT Single Side (buy the dip)
├ Invested: 197,2980 USDT
├ Total Fees: +$8,48
├ PnL: +2.4% / $5
├ Range: $33.16M ⇄ $16.47M / now $34.06M
└ Status: Active (in range), 30m

🟢 $VYNEX/USDG | #1234568 (V4)
├ Chain: Robinhood
├ Strategy: USDG Single Side (buy the dip)
├ Invested: 199,0800 USDG
├ Total Fees: +$6,70
├ PnL: +3.1% / $7
├ Range: $1.68M ⇄ $165.5K / now $1.70M
└ Status: Active (in range), 25m

Your liquidity is in range and earning fees.

13 Sep 2026, 14:06 WIB
```

Tap one for the full card. A ladder shows the whole ladder first, then the leg you
opened:

```
🟢 $VYNEX/USDG | #1234568 (V4)
├ Fee: 3.01%
├ TVL: $1.2M
├ APR: 12.4%
├ Fills: 0%
├ Volume: $184.2K (24h)
└ Liquidity: 12.480,55 USDG

LADDER, 8 legs
Deposit: 199,0807 USDG
Value now: 204,23 USDG
Ladder PnL: +$5,15 (+2,6%)
Rungs: 0 filled, 1 active, 7 waiting
leg 1 of 8, 2.8% of ladder capital

13 Sep 2026, 14:06 WIB
```

`/portfolio` answers the other question, where your money actually is:

```
💰 PORTFOLIO

EQUITY :
├  Total: $1.250,00
├  In LP: $400,00 · 8 positions
└  Free: $850,00

BY CHAIN :
├  RH: $775,00 (0.3000 ETH / 25.00 USDG)
├  BSC: $68,00 (0.0800 BNB / 12.00 USDT)
├  BASE: $2,50 (0.0010 ETH)
├  HyperEVM: $4,50 (0.0500 HYPE)
└  Arc: $8.29 USDC

13 Sep 2026, 14:06 WIB
```

Anything under **$0.10** is left out of `/portfolio` and `/swap`: dust from an old
position is not worth a line you have to read past.

`/gas` answers the question you ask before every move, which chain is cheapest
right now:

```
⛽️ GAS FEE

SWAP
├ HyperEVM: $0.00258 / Rp45
├ Base: $0.00494 / Rp87
├ BSC: $0.012 / Rp207
└ Robinhood: $0.070 / Rp1.235

OPEN LP
├ HyperEVM: $0.00351 / Rp62
├ Base: $0.00672 / Rp118
├ BSC: $0.016 / Rp282
└ Robinhood: $0.096 / Rp1.681

CLOSE LP
├ HyperEVM: $0.00236 / Rp41
├ Base: $0.00452 / Rp79
├ BSC: $0.011 / Rp190
└ Robinhood: $0.064 / Rp1.130

WITHDRAW & APPROVE
├ HyperEVM: $0.000363 / Rp6
├ Base: $0.000695 / Rp12
├ BSC: $0.00166 / Rp29
└ Robinhood: $0.00991 / Rp174

13 Sep 2026, 14:06 WIB
```

Each section is a tree, ranked cheapest first. The gas price comes from each chain's own
RPC, the same number the bot pays with. The gas *units* are the median of this
wallet's real transactions over 14 days, not a textbook estimate, because a v4
`modifyLiquidities` burns more than 260k and that is the operation you use most.
The Rupiah column uses Indodax, the rate you actually face selling crypto locally.

`/pnl` asks which chain first (or all of them), then sums up the trades you closed in
that period. All time, 1 day, 1 week, 1 month, switchable in place:

![Lifetime PnL recap](assets/pnl-recap.jpg)

A ladder counts as **one** position there, however many legs it was closed in. It
opens as one deposit and closes in one transaction, so scoring it per leg would
split the result eight ways and drop every slice under the break-even threshold,
inflating the trade count while quietly deleting most of the wins and losses.

Thousands are grouped Indonesian-style throughout the bot (`1.268,62`), and every
figure on a card is converted to dollars rather than left in the asset it was earned in.

All figures on this page are examples, not anyone's real history.

---

## Closing a position

`/positions` lists what you have open and puts a close button on each one. Tapping close
on any leg of a ladder closes the whole ladder in one batched transaction. Either
way the bot withdraws the liquidity, collects the fees, swaps the token back to
what you deposited, and sends you a result card: deposit, received, how long you held
it, and the fees you earned.

![Closed position card](assets/pnl-closed.jpg)

The artwork behind that card is just a file. The two cards above use one, and the
repo ships a different one, which is the whole point. The shipped one lives in
`assets/pnl-card.jpg`; to use your own, send the bot a photo from `/settings` and it
becomes the backdrop on every card from then on (it is saved to `data/pnl-bg.jpg`, and
it wins over the shipped one). Wide images with the subject on one side work best; the
text sits on the other.

The card draws its text in Liberation Sans and DejaVu Mono. A server with **no fonts
installed** renders the artwork and no text at all. Install them with
`apt install fonts-liberation fonts-dejavu-core fonts-dejavu-mono` (the one-command
installer does this for you).

The result is reported **in dollars**, each side priced at its own moment: the deposit at
the rate stored when the position opened, the proceeds at the rate now. For a stablecoin
base both rates are 1, so nothing is folded in. For a native base the figure does include
the base asset's own move, which is what your money actually did. If neither rate can be
read, the card falls back to the deposited asset rather than inventing a dollar number.

Withdrawals carry a price floor, on v3 and v4 alike. If someone pushes the pool
while your transaction is in flight, it reverts instead of filling at whatever price
they made. The floor is a **price band**: the amounts are computed at both edges of a
0.5% move and the smaller of each side is taken. A per-side percentage would be the
obvious way to do it and it is the wrong one, because in a narrow range each side's
amount moves far faster than price does, so a perfectly ordinary 0.2% drift is enough
to fail a healthy close. Bounding the price instead bounds the thing an attacker
actually controls. On the rare occasion the floor cannot be worked out, the bot says
so on the card rather than staying quiet.

---

## Quick percentages

Every amount step shows percentage buttons. You decide what they are.

`/settings` → **Buy %**, **Swap %**, **Add LP %**, **Close LP %**, **Bridge %**,
**Withdraw %**, plus **LP shape** and **Ladder legs** (how many rungs a bid-ask ladder
offers, 2 to 69).
Each one opens a small card with the current numbers and an **Edit** button. Type up
to four numbers `10 25 50 90`, `10,25,50`, or `10/25/50` all work and they become
the buttons for that flow. **Reset** puts the defaults back.

**Close LP %** is the one exception: 100% is not allowed there, because taking
everything out closes the position, and that has its own button. **Ladder legs** takes
counts rather than percentages, so its range is 2 to 69, and **LP shape** is a toggle
between SPOT and BID-ASK rather than a list of numbers.

`/settings` also takes a **PnL card background**: send the bot a photo and it becomes
the backdrop on every PnL card from then on.

Your choices live in `data/pctpresets.json` and survive restarts. So does a prompt
that is waiting on you: if the bot restarts while a settings card is asking for
numbers, the prompt is still there when you answer.

---

## Chains

Six are configured out of the box. Turn the extra ones on in `.env`:

| Chain | DEX | You can deposit | On by default |
|---|---|---|---|
| Robinhood | Uniswap v3 + v4 | ETH · USDG | yes (primary) |
| BSC | PancakeSwap v3 + Uniswap v3 + v4 | BNB · USDT | yes |
| Base | Uniswap v3 + v4 | ETH · USDC | yes |
| HyperEVM | HyperSwap v3 | HYPE · USDT0 | yes |
| Arc | Uniswap v3 + v4 | USDC only | no, needs `ARC_RPC_URL` |
| Ink | Velodrome Slipstream | ETH · USDT0 | no, too quiet to be worth the RPC |

**Arc is the odd one.** Gas there IS USDC, so there is no wrapped native and no ETH
base: USDC is the only asset you can deposit, and it pays its own gas. It stays out
of the registry until you give it an RPC, even with `ARC_ENABLED=true`. Funding it
goes through Circle's CCTP (about 30 seconds, a fraction of a cent); `/bridge` picks
that route on its own when both sides are USDC, and falls back to LI.FI otherwise.

`/positions` and `/portfolio` read v4 on **every** chain that has it, not just the
one you are pointed at, so a BSC v4 ladder shows up while your primary chain is
Robinhood.

The primary chain is whatever you put in `.env`. It was built and tested against
Robinhood Chain. Pointing it at a different EVM chain works, but you'll need to
edit `src/chains.ts` (the explorer URL and the stablecoin address are set there).

---

## Read this before you fund it

This bot holds a hot wallet key and signs transactions on its own. Treat it like
a hot wallet, not a vault.

- **One owner.** Your Telegram id is the entire access control. Anyone who gets
  into that Telegram account controls the wallet. Don't share the bot.
- **It signs unattended.** A background loop sweeps leftover tokens and unwraps
  stray WETH by itself, once a minute.
- **There is no stop-loss.** A position that moves against you keeps running until
  you close it. Alerts tell you; they don't act.
- **Closing sells what the position produced, and only that.** The token balance you
  already held before the close is read first and held back, so a spot bag in the same
  token is not swept into the cash-out. What the LP itself returns is sold.
- **Per-transaction caps** (`MAX_ETH_PER_TX`, `MAX_STABLE_PER_TX`) can be raised in
  `.env`, or switched off with `off`. Leaving them empty does *not* remove them
  it falls back to the built-in defaults, so a typo can't quietly open the wallet.
  With the caps off, the only ceiling is the balance you actually hold.
- **Gas has its own ceiling** (`MAX_TX_FEE_NATIVE`, default `0.005` native). It is
  checked at broadcast, so every path is covered. A transaction that could cost more
  is refused before it is sent.
- **Your keystore is only as strong as `WALLET_SECRET`.** The installer generates a
  random one. Anyone who can read both your disk and your `.env` can open the wallet.

What the bot does do for you:

- **Approvals are for the exact amount**, never unlimited. A router you swap through
  once cannot come back for the rest of your balance later.
- **Swaps have a floor.** The minimum output comes from a quote and is never zero, so
  a swap that would land far below the price you agreed to reverts instead.
- **On BSC, transactions go out through a private relay** so they never sit in the
  public mempool waiting to be sandwiched. The other four chains have a single
  sequencer and no public mempool, so there is nothing to hide from there.
- **Every transaction is simulated first.** If the simulation reverts, nothing is sent.

---

## Your data

Everything lives in `data/`, which is never committed to git:

Worth backing up: `keystore.json` (your encrypted key) · `positions.json` ·
`v4positions.json` · `journal.jsonl`

Settings, rebuilt by hand if lost: `alerts.json` · `pctpresets.json` · `lpshape.json` ·
`pnl-bg.jpg` (the PnL card background you sent)

Caches and scratch, safe to delete: `poolkeys.json` · `sweep.json` ·
`pctpending.json` · `wallet.disconnected`

**Back up that folder.** `journal.jsonl` and `positions.json` are the only record
of what you paid for each position. If `positions.json` is ever corrupt, the bot
moves it aside and refuses to start rather than quietly overwriting it.

---

## Running it yourself

If you'd rather not use the installer:

```bash
git clone https://github.com/whoismoaru/PHILIPS.git philips && cd philips
npm ci
cp .env.example .env      # every field is documented inside
npm start
```

Needs Node 20 or newer.

**Read-only checks.** None of these send a transaction:

```bash
npm run check                        # typecheck
npx tsx scripts/smoke.ts             # read prices, build a plan
npx tsx scripts/smoke-journal.ts     # accounting sanity

for f in scripts/smoke-*.ts; do npx tsx "$f"; done   # all of them
```

The `smoke-*` scripts stand in for a test suite, 59 of them at the time of writing.
They cover the parts where a mistake costs money: slippage ladders, approval amounts,
withdrawal price floors, sell routing, and PnL accounting. Several are pure maths and
need no network at all; the rest read live chains but never sign anything.

---

## When something breaks

| Symptom | Fix |
|---|---|
| Bot doesn't reply | `sudo journalctl -u philips-bot -n 50`; usually a wrong Telegram id |
| "Missing X in your .env file" | That field is empty. `bash philips.sh` → option 3 |
| Every read fails at once | Your RPC is rate-limiting. Use a keyed endpoint |
| Transaction says insufficient funds | Not enough native token left for gas; try `/unwrap` |
| Position won't close | Check `journalctl`; the bot holds tokens rather than dumping them at any price |

---

## Not supported

Multiple users on one instance · non-custodial signing · automatic position opening

---

MIT licensed. Run your own instance.
