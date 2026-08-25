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
Free public endpoints rate-limit, and then every read fails at once.

---

## First run

After the installer finishes, open Telegram and talk to your bot :

**1.** Send `/start`. You should see a welcome card. If nothing happens, your
Telegram id in `.env` is wrong. Only that one account can use the bot.

**2.** Send `/settings` → **Connect Wallet** → paste a private key or seed phrase.
The message is deleted from the chat immediately, and the key is stored encrypted
on your server (`data/keystore.json`, scrypt + AES, file mode 600).

**3.** Send `/status`. Your balances should appear. If they do, the bot can read
the chain correctly.

**4.** Try `/add_lp` and walk through the wizard without confirming. The bot starts
in **DRY RUN**, so it simulates everything and sends no transactions.

**5.** When all of that looks right, run `bash philips.sh` again and pick
**option 6** to switch to LIVE. Start with a small amount.

---

## Opening a position

Send `/add_lp`, or just paste a token's contract address into the chat.

**Step 0. The bot screens the token first.** Contract verified or proxy, how
concentrated the holders are, how deep the liquidity is, how old the pool is, and
a simulated sell to catch honeypots.

  The verdict is one of three :
  - ✅ **Safe to LP**
  - ⚠️ **Proceed with caution**
  - 🚫 **Do not LP**, and this one **stops the wizard**. There is no button to
  override it.

**Step 1. Pick a pool.** Up to three, ranked by liquidity and volume, gathered
from the Uniswap gateway, Krystal, and on-chain scans.

**Step 2. Pick which side you deposit.**

- **Base side.** You deposit ETH / BNB / a stablecoin. The position waits *below*
  the current price. It's a limit buy that earns fees while it waits.
- **Token side.** You deposit the token itself. The position waits *above* the
  price. A limit sell that earns fees while it waits.

**Step 3. Pick how wide the range is.** From conservative to extreme.

**Step 3b. Pick the shape** (base side only).

- **Spot.** One position near the price. Simplest, and it harvests the most fees.
- **Bid-Ask.** A ladder of several positions, with more money placed at the lower
  prices. It buys more of the token the deeper it dips and protects your capital,
  but earns less in fees. You pick how many legs — **8 to 10 is the sweet spot**.
  More legs is smoother but needs a paid RPC; on a free endpoint it makes the bot
  slow. All the legs open in one batched transaction and are managed as one position.

**Step 4. How much.** Tap 30% / 50% / 70% / 90% of your balance, or type an exact
number. Percentages are taken from your *usable* balance. The gas reserve is kept
aside, so 90% never leaves you unable to pay for the transaction.

**Step 5. Review and confirm.** The card shows the real price range, what you're
depositing, and the estimated gas. Nothing is signed until you tap confirm.

---

## Commands

| Command | What it does |
|---|---|
| `/start` · `/help` | Menu and bot mode |
| `/status` | Equity, balances per chain, idle tokens |
| `/positions` | Your live positions; tap one for full detail |
| `/pnl` | Profit recap from closed trades, as a picture card |
| `/add_lp` | Open a position (or `/add_lp <contract address>`) |
| `/claim_fees` | Take the fees, leave the position running |
| `/remove_lp` | Withdraw 25 / 50 / 75% |
| `/stop` | Close a position and cash out |
| `/buy` · `/sell` | Swap a token via the best available route |
| `/unwrap` | Turn stuck WETH / WBNB back into gas |
| `/bridge` | Move funds between chains |
| `/settings` | Connect or disconnect your wallet |
| `/alerts` | Which notifications you want |

Every step has **Back** and **Cancel**. Anything that moves money takes one
explicit confirmation tap and is guarded against double-taps.

---

## Chains

Five are configured out of the box. Turn the extra ones on in `.env`:

| Chain | DEX | You can deposit |
|---|---|---|
| Robinhood | Uniswap v3 + v4 | ETH · USDG |
| BSC | PancakeSwap v3 + Uniswap v3 | BNB · USDT |
| Base | Uniswap v3 | ETH · USDC |
| HyperEVM | HyperSwap v3 | HYPE · USDT0 |
| Ink | Velodrome Slipstream | ETH · USDT0 |

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
- **Closing cashes out your whole bag.** `/stop` doesn't stop at the position's own
  output. It swaps **every** unit of that token in the wallet. If you hold the same
  token outside the LP, move it elsewhere first.
- **Per-transaction caps** (`MAX_ETH_PER_TX`, `MAX_STABLE_PER_TX`) can be raised in
  `.env`, but never switched off.
- **Your keystore is only as strong as `WALLET_SECRET`.** The installer generates a
  random one. Anyone who can read both your disk and your `.env` can open the wallet.

---

## Your data

Everything lives in `data/`, which is never committed to git:

`keystore.json` (your encrypted key) · `positions.json` · `journal.jsonl` ·
`settings.json` · `alerts.json`

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
```

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
