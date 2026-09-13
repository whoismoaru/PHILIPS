#!/bin/bash

clear
HEADER_WIDTH=52
TITLE="PHILIPS LP BOT"
SUB="single-sided liquidity, from Telegram"

printf '=%.0s' $(seq 1 $HEADER_WIDTH); echo
printf "%*s%s\n" $(( (HEADER_WIDTH - ${#TITLE}) / 2 )) "" "$TITLE"
printf "%*s%s\n" $(( (HEADER_WIDTH - ${#SUB}) / 2 )) "" "$SUB"
printf '=%.0s' $(seq 1 $HEADER_WIDTH); echo
echo

set -e

APP_DIR="${APP_DIR:-$HOME/philips}"
REPO="https://github.com/whoismoaru/PHILIPS.git"
SERVICE="${SERVICE:-philips-bot}"

ok()   { echo -e "[✓] $*"; }
info() { echo -e "[+] $*"; }
warn() { echo -e "[!] $*"; }

ask() { # ask "Question" "default" -> the answer lands in $REPLY_VAL
  local q="$1" def="$2" a
  if [ -n "$def" ]; then read -rp "    $q [$def]: " a; else read -rp "    $q: " a; fi
  REPLY_VAL="${a:-$def}"
}

# ── 1. Node.js ──────────────────────────────────────────────────────
function install_node() {
  if command -v node >/dev/null 2>&1; then
    local v; v="$(node -v | sed 's/v//;s/\..*//')"
    if [ "$v" -ge 20 ]; then ok "Node $(node -v) is already here, skipping."; return; fi
    warn "Node $(node -v) is too old; PHILIPS needs 20 or newer."
  fi
  info "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node $(node -v) installed."
}

# -- 2. Fetch the code ----------------------------------------------
function clone_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    info "The repo is already at $APP_DIR, pulling the latest version..."
    git -C "$APP_DIR" pull --ff-only || warn "pull skipped: there are local changes."
  else
    info "Downloading PHILIPS into $APP_DIR..."
    git clone "$REPO" "$APP_DIR"
  fi
  info "Installing dependencies (this takes a minute or two)..."
  ( cd "$APP_DIR" && npm ci )
  ok "Code ready."
}

# -- 3. Configuration -----------------------------------------------
function setup_env() {
  local f="$APP_DIR/.env"
  if [ -f "$f" ]; then
    ask ".env already exists. Overwrite it? (y/N)" "N"
    [[ "$REPLY_VAL" =~ ^[Yy]$ ]] || { ok "Keeping the existing .env."; return; }
    cp "$f" "$f.bak-$(date +%s)"
    info "A backup of the old one was saved."
  fi

  echo
  echo "  --- Telegram ---"
  echo "  The token comes from @BotFather, your numeric id from @userinfobot."
  ask "TELEGRAM_BOT_TOKEN" ""; local TOKEN="$REPLY_VAL"
  [ -n "$TOKEN" ] || { warn "The token cannot be empty."; return 1; }
  ask "TELEGRAM_ALLOWED_USER_ID" ""; local UID_TG="$REPLY_VAL"
  [ -n "$UID_TG" ] || { warn "The Telegram id cannot be empty."; return 1; }

  echo
  echo "  --- Primary chain ---"
  echo "  Use your own keyed RPC; public ones get rate limited."
  ask "RPC_URL" ""; local RPC="$REPLY_VAL"
  ask "CHAIN_ID" "4663"; local CID="$REPLY_VAL"

  echo
  echo "  The Uniswap v3 contract addresses on that chain."
  echo "  (Press Enter to accept the Robinhood Chain defaults)"
  ask "UNISWAP_V3_FACTORY"          "0x1F98431c8aD98523631AE4a59f267346ea31F984"; local F="$REPLY_VAL"
  ask "UNISWAP_V3_POSITION_MANAGER" "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; local PM="$REPLY_VAL"
  ask "UNISWAP_V3_QUOTER"           "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; local Q="$REPLY_VAL"
  ask "UNISWAP_V3_SWAP_ROUTER"      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; local R="$REPLY_VAL"
  ask "WETH_ADDRESS"                ""; local W="$REPLY_VAL"

  echo
  echo "  --- Extra chains (optional) ---"
  ask "Enable BSC? (y/N)" "N"; local BSC="false" BSC_RPC=""
  if [[ "$REPLY_VAL" =~ ^[Yy]$ ]]; then
    BSC="true"; ask "BSC_RPC_URL (Enter = the public dataseed)" ""; BSC_RPC="$REPLY_VAL"
  fi
  ask "Enable Base? (y/N)" "N"; local BASE="false" BASE_RPC=""
  if [[ "$REPLY_VAL" =~ ^[Yy]$ ]]; then
    BASE="true"; ask "BASE_RPC_URL (Enter = mainnet.base.org)" ""; BASE_RPC="$REPLY_VAL"
  fi

  local SECRET="" SECRET_NOTE="A WALLET_SECRET was generated for you."
  for old in "$f" "$f".bak-*; do
    [ -f "$old" ] || continue
    SECRET="$(grep -m1 '^WALLET_SECRET=' "$old" 2>/dev/null | cut -d= -f2-)"
    [ -n "$SECRET" ] && break
  done
  if [ -n "$SECRET" ]; then
    SECRET_NOTE="The previous WALLET_SECRET was kept, so the keystore still opens."
  else
    SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '\n=/+' | head -c 40)"
  fi

  umask 077
  cat > "$f" <<EOF
TELEGRAM_BOT_TOKEN=$TOKEN
TELEGRAM_ALLOWED_USER_ID=$UID_TG

WALLET_SECRET=$SECRET

RPC_URL=$RPC
CHAIN_ID=$CID
UNISWAP_V3_FACTORY=$F
UNISWAP_V3_POSITION_MANAGER=$PM
UNISWAP_V3_QUOTER=$Q
UNISWAP_V3_SWAP_ROUTER=$R
WETH_ADDRESS=$W

BSC_ENABLED=$BSC
BSC_RPC_URL=$BSC_RPC

BASE_ENABLED=$BASE
BASE_RPC_URL=$BASE_RPC

MAX_ETH_PER_TX=0.05
MAX_STABLE_PER_TX=250

# Keep this true until you have checked /status and /positions.
DRY_RUN=true

GMGN_API_KEY=
KRYSTAL_API_KEY=
EOF
  chmod 600 "$f"
  ok ".env written with mode 600. $SECRET_NOTE"
  warn "DRY_RUN=true: the bot simulates and sends no transactions yet."
}

# ── 4. systemd ──────────────────────────────────────────────────────
function service_dir() {
  local u="/etc/systemd/system/$1.service"
  [ -f "$u" ] || return 0
  grep -oP '(?<=^WorkingDirectory=).*' "$u" 2>/dev/null | head -1
}

function ensure_free_service() {
  local existing; existing="$(service_dir "$SERVICE")"
  [ -z "$existing" ] && return 0
  [ "$existing" = "$APP_DIR" ] && return 0

  echo
  warn "Service '$SERVICE' is ALREADY used by another installation:"
  warn "  installed folder : $existing"
  warn "  current folder   : $APP_DIR"
  warn "Overwriting it stops that bot, and its position monitoring with it."
  echo
  echo "    1) Use a different service name (safe, both run side by side)"
  echo "    2) Cancel"
  ask "Choose" "1"
  [ "$REPLY_VAL" = "1" ] || { warn "Cancelled. The existing installation was left alone."; return 1; }

  local suggest; suggest="philips-bot-$(basename "$APP_DIR")"
  ask "New service name" "$suggest"
  SERVICE="$REPLY_VAL"
  [ -z "$(service_dir "$SERVICE")" ] || { warn "The name '$SERVICE' is taken as well. Try another."; return 1; }
  ok "Using service '$SERVICE'."
}

function setup_service() {
  ensure_free_service || return 1
  info "Creating the systemd service '$SERVICE'..."
  sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=PHILIPS LP Bot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=10
TimeoutStopSec=15
# 78 means a configuration error: a bad .env or an invalid token. Retrying every 10
# seconds would only flood the log, so stop and wait for a human to fix it.
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE" >/dev/null 2>&1
  sudo systemctl restart "$SERVICE"
  verify_running "The bot is running. Open Telegram and send /start to it."
}

function verify_running() {
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    ok "${1:-The bot is running.}"
    return 0
  fi
  warn "The bot is NOT running. Here is why:"
  sudo journalctl -u "$SERVICE" -n 15 --no-pager | grep -vE "^\s*at |systemd\[1\]" | tail -8
  return 1
}

function assert_ours() {
  local d; d="$(service_dir "$SERVICE")"
  if [ -z "$d" ]; then
    warn "Service '$SERVICE' does not exist yet; run option 1 first."
    return 1
  fi
  if [ "$d" != "$APP_DIR" ]; then
    warn "Service '$SERVICE' belongs to $d, not $APP_DIR."
    warn "Run it again as: SERVICE=<your-service-name> bash philips.sh"
    return 1
  fi
}

# assert_ours guards each of these with && , never ; -- with a semicolon a refusal is
# printed and the command runs anyway, which once stopped a DIFFERENT installation's bot.
function show_logs()   { assert_ours && sudo journalctl -u "$SERVICE" -f; }
function restart_bot() { assert_ours && sudo systemctl restart "$SERVICE" && verify_running "The bot restarted and is running."; }
function stop_bot()    { assert_ours && sudo systemctl stop "$SERVICE" && ok "The bot was stopped."; }

function go_live() {
  local f="$APP_DIR/.env"
  [ -f "$f" ] || { warn ".env does not exist yet; run option 1 first."; return 1; }
  echo
  warn "LIVE means the bot sends REAL transactions with your money."
  warn "Make sure you have checked /status, /positions, and one dry /add_lp."
  ask "Continue? type LIVE to confirm" ""
  [ "$REPLY_VAL" = "LIVE" ] || { ok "Cancelled, staying in DRY RUN."; return; }
  assert_ours || return 1
  sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' "$f"
  sudo systemctl restart "$SERVICE"
  verify_running "LIVE mode is on. Start small."
}

function install_all() {
  install_node
  clone_repo
  setup_env
  
  if ! setup_service; then
    echo
    warn "Installation stopped here. Fix the cause above, then:"
    echo "      - change the config : run this script again and pick 3"
    echo "      - try starting it   : pick 5"
    return 1
  fi
  echo
  ok "Done. Next steps, in Telegram:"
  echo "      1. /start"
  echo "      2. /settings -> Connect Wallet -> tempel private key / seed"
  echo "      3. /status, to confirm the balances read correctly"
  echo "      4. come back here and pick 6 when you are ready to go LIVE"
}

function print_menu() {
  echo
  echo "=== PHILIPS Installer ==="
  echo "1. Install everything (Node + code + config + service)"
  echo "2. Update the code only"
  echo "3. Edit the configuration (.env)"
  echo "4. Follow the live log"
  echo "5. Restart the bot"
  echo "6. Switch to LIVE mode"
  echo "7. Stop the bot"
  echo "0. Quit"
  echo -n "Choose an option: "
}

while true; do
  print_menu
  read -r opt
  case "$opt" in
    1) install_all || true ;;
    2) { clone_repo && restart_bot; } || true ;;
    3) { setup_env && restart_bot; } || true ;;
    4) show_logs || true ;;
    5) restart_bot || true ;;
    6) go_live || true ;;
    7) stop_bot || true ;;
    0) echo "See you."; exit 0 ;;
    *) warn "Unknown option." ;;
  esac
done
