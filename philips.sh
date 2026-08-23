#!/bin/bash
# PHILIPS — installer satu kali jalan.
# Pasang, konfigurasi, dan jalankan bot LP single-sided di Telegram.

clear
HEADER_WIDTH=52
TITLE="PHILIPS LP BOT"
SUB="single-sided liquidity, dari Telegram"

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
die()  { echo -e "[x] $*" >&2; exit 1; }

ask() { # ask "Pertanyaan" "default" -> jawaban di $REPLY_VAL
  local q="$1" def="$2" a
  if [ -n "$def" ]; then read -rp "    $q [$def]: " a; else read -rp "    $q: " a; fi
  REPLY_VAL="${a:-$def}"
}

# ── 1. Node.js ──────────────────────────────────────────────────────
function install_node() {
  if command -v node >/dev/null 2>&1; then
    local v; v="$(node -v | sed 's/v//;s/\..*//')"
    if [ "$v" -ge 20 ]; then ok "Node $(node -v) sudah ada, skip."; return; fi
    warn "Node $(node -v) terlalu lama — PHILIPS butuh 20+."
  fi
  info "Memasang Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node $(node -v) terpasang."
}

# ── 2. Ambil kode ───────────────────────────────────────────────────
function clone_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    info "Repo sudah ada di $APP_DIR, menarik versi terbaru..."
    git -C "$APP_DIR" pull --ff-only || warn "pull dilewati (ada perubahan lokal)."
  else
    info "Mengunduh PHILIPS ke $APP_DIR..."
    git clone "$REPO" "$APP_DIR"
  fi
  info "Memasang dependensi (butuh 1-2 menit)..."
  ( cd "$APP_DIR" && npm ci )
  ok "Kode siap."
}

# ── 3. Konfigurasi ──────────────────────────────────────────────────
function setup_env() {
  local f="$APP_DIR/.env"
  if [ -f "$f" ]; then
    ask "File .env sudah ada. Timpa? (y/N)" "N"
    [[ "$REPLY_VAL" =~ ^[Yy]$ ]] || { ok ".env lama dipertahankan."; return; }
    cp "$f" "$f.bak-$(date +%s)"
    info "Cadangan lama disimpan."
  fi

  echo
  echo "  --- Telegram ---"
  echo "  Token dari @BotFather, dan id numerikmu dari @userinfobot."
  ask "TELEGRAM_BOT_TOKEN" ""; local TOKEN="$REPLY_VAL"
  [ -n "$TOKEN" ] || die "Token tak boleh kosong."
  ask "TELEGRAM_ALLOWED_USER_ID" ""; local UID_TG="$REPLY_VAL"
  [ -n "$UID_TG" ] || die "Telegram id tak boleh kosong."

  echo
  echo "  --- Chain utama ---"
  echo "  Pakai RPC berkunci milikmu sendiri; RPC publik kena rate-limit."
  ask "RPC_URL" ""; local RPC="$REPLY_VAL"
  ask "CHAIN_ID" "4663"; local CID="$REPLY_VAL"

  echo
  echo "  Alamat kontrak Uniswap v3 di chain itu."
  echo "  (Enter untuk memakai bawaan Robinhood Chain)"
  ask "UNISWAP_V3_FACTORY"          "0x1F98431c8aD98523631AE4a59f267346ea31F984"; local F="$REPLY_VAL"
  ask "UNISWAP_V3_POSITION_MANAGER" "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; local PM="$REPLY_VAL"
  ask "UNISWAP_V3_QUOTER"           "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; local Q="$REPLY_VAL"
  ask "UNISWAP_V3_SWAP_ROUTER"      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; local R="$REPLY_VAL"
  ask "WETH_ADDRESS"                ""; local W="$REPLY_VAL"

  echo
  echo "  --- Chain tambahan (opsional) ---"
  ask "Aktifkan BSC? (y/N)" "N"; local BSC="false" BSC_RPC=""
  if [[ "$REPLY_VAL" =~ ^[Yy]$ ]]; then
    BSC="true"; ask "BSC_RPC_URL (Enter = dataseed publik)" ""; BSC_RPC="$REPLY_VAL"
  fi
  ask "Aktifkan Base? (y/N)" "N"; local BASE="false" BASE_RPC=""
  if [[ "$REPLY_VAL" =~ ^[Yy]$ ]]; then
    BASE="true"; ask "BASE_RPC_URL (Enter = mainnet.base.org)" ""; BASE_RPC="$REPLY_VAL"
  fi

  # Frasa sandi keystore dibuat acak — jauh lebih kuat daripada yang diketik manual.
  local SECRET; SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '\n=/+' | head -c 40)"

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

# WAJIB true sampai kamu selesai memeriksa /status dan /positions.
DRY_RUN=true

GMGN_API_KEY=
KRYSTAL_API_KEY=
EOF
  chmod 600 "$f"
  ok ".env dibuat (izin 600). WALLET_SECRET diacak otomatis."
  warn "DRY_RUN=true — bot menyimulasi, belum mengirim transaksi."
}

# ── 4. systemd ──────────────────────────────────────────────────────

# Folder kerja service yang sudah terpasang; kosong bila belum ada.
function service_dir() {
  local u="/etc/systemd/system/$1.service"
  [ -f "$u" ] || return 0
  grep -oP '(?<=^WorkingDirectory=).*' "$u" 2>/dev/null | head -1
}

# Menolak menimpa instalasi LAIN. Satu server boleh menjalankan beberapa PHILIPS
# (dompet berbeda), tapi menimpa unit milik instalasi lain berarti bot itu diam
# -diam berhenti memantau posisi yang masih memegang uang.
function ensure_free_service() {
  local existing; existing="$(service_dir "$SERVICE")"
  [ -z "$existing" ] && return 0
  [ "$existing" = "$APP_DIR" ] && return 0

  echo
  warn "Service '$SERVICE' SUDAH dipakai instalasi lain:"
  warn "  folder terpasang : $existing"
  warn "  folder sekarang  : $APP_DIR"
  warn "Menimpanya akan menghentikan bot itu — termasuk pemantauan posisinya."
  echo
  echo "    1) Pakai nama service lain (aman, keduanya jalan berdampingan)"
  echo "    2) Batalkan"
  ask "Pilih" "1"
  [ "$REPLY_VAL" = "1" ] || die "Dibatalkan. Instalasi lama tak disentuh."

  local suggest; suggest="philips-bot-$(basename "$APP_DIR")"
  ask "Nama service baru" "$suggest"
  SERVICE="$REPLY_VAL"
  [ -z "$(service_dir "$SERVICE")" ] || die "Nama '$SERVICE' juga sudah dipakai. Jalankan lagi dengan nama lain."
  ok "Memakai service '$SERVICE'."
}

function setup_service() {
  ensure_free_service
  info "Membuat service systemd '$SERVICE'..."
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
# 78 = galat konfigurasi (.env salah / token tak sah). Mengulangnya tiap 10 detik
# hanya membanjiri log — berhenti, dan tunggu manusia memperbaiki.
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE" >/dev/null 2>&1
  sudo systemctl restart "$SERVICE"
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    ok "Bot jalan. Buka Telegram, kirim /start ke botmu."
    return 0
  fi
  warn "Bot gagal menyala. Sebabnya:"
  sudo journalctl -u "$SERVICE" -n 15 --no-pager | grep -vE "^\s*at |systemd\[1\]" | tail -8
  return 1
}

# Sebelum menyentuh service, pastikan ia memang milik folder ini.
# Mengembalikan 1 (bukan keluar): pilihan yang salah harus mengembalikan user ke
# MENU, bukan menendangnya keluar dari skrip.
function assert_ours() {
  local d; d="$(service_dir "$SERVICE")"
  if [ -z "$d" ]; then
    warn "Service '$SERVICE' belum ada — jalankan opsi 1 dulu."
    return 1
  fi
  if [ "$d" != "$APP_DIR" ]; then
    warn "Service '$SERVICE' milik $d, bukan $APP_DIR."
    warn "Jalankan ulang dengan: SERVICE=<nama-service-mu> bash philips.sh"
    return 1
  fi
}

function show_logs()   { assert_ours; sudo journalctl -u "$SERVICE" -f; }
function restart_bot() { assert_ours; sudo systemctl restart "$SERVICE"; ok "Bot di-restart."; }
function stop_bot()    { assert_ours; sudo systemctl stop "$SERVICE"; ok "Bot dihentikan."; }

function go_live() {
  local f="$APP_DIR/.env"
  [ -f "$f" ] || die ".env belum ada — jalankan opsi 1 dulu."
  echo
  warn "LIVE artinya bot mengirim transaksi SUNGGUHAN dengan uangmu."
  warn "Pastikan /status, /positions, dan satu /add_lp kering sudah kamu periksa."
  ask "Lanjut? ketik LIVE untuk konfirmasi" ""
  [ "$REPLY_VAL" = "LIVE" ] || { ok "Dibatalkan, tetap DRY RUN."; return; }
  assert_ours
  sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' "$f"
  sudo systemctl restart "$SERVICE"
  ok "Mode LIVE aktif. Mulai dari nominal kecil."
}

function install_all() {
  install_node
  clone_repo
  setup_env
  # Jangan mengaku selesai kalau botnya tak menyala — menyuruh orang membuka
  # Telegram saat bot mati adalah cara tercepat membuatnya menyerah.
  if ! setup_service; then
    echo
    warn "Pemasangan berhenti di sini. Perbaiki sebab di atas, lalu:"
    echo "      - ubah konfigurasi : jalankan skrip ini lagi, pilih 3"
    echo "      - coba nyalakan    : pilih 5"
    return 1
  fi
  echo
  ok "Selesai. Langkah berikutnya di Telegram:"
  echo "      1. /start"
  echo "      2. /settings -> Connect Wallet -> tempel private key / seed"
  echo "      3. /status untuk memastikan saldo terbaca"
  echo "      4. kembali ke sini, pilih menu 6 saat siap LIVE"
}

function print_menu() {
  echo
  echo "=== PHILIPS Installer ==="
  echo "1. Pasang semua (Node + kode + konfigurasi + service)"
  echo "2. Perbarui kode saja"
  echo "3. Ubah konfigurasi (.env)"
  echo "4. Lihat log langsung"
  echo "5. Restart bot"
  echo "6. Ganti ke mode LIVE"
  echo "7. Hentikan bot"
  echo "0. Keluar"
  echo -n "Pilih opsi: "
}

while true; do
  print_menu
  read -r opt
  case "$opt" in
    # '|| true': kegagalan satu opsi mengembalikan user ke MENU, bukan menendangnya
    # keluar dari skrip (set -e). Sebabnya sudah dicetak masing-masing fungsi.
    1) install_all || true ;;
    2) { clone_repo && restart_bot; } || true ;;
    3) { setup_env && restart_bot; } || true ;;
    4) show_logs || true ;;
    5) restart_bot || true ;;
    6) go_live || true ;;
    7) stop_bot || true ;;
    0) echo "Sampai jumpa."; exit 0 ;;
    *) warn "Opsi tak dikenal." ;;
  esac
done
