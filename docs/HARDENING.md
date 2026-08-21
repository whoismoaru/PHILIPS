# PHILIPS — Hardening (branch `hardening`)

Tambalan keselamatan & ketahanan atas cockpit LP manual. Baseline pra-hardening
ada di commit `master` (restore point).

## Aktif

### Lantai swap — anti minOut=0 (sandwich)
`relay.ts:swapViaUniswap`. Sebelumnya: quoter gagal → `minOut = 0` ("last resort")
→ `exactInputSingle` menerima output berapa pun = umpan sandwich. Sekarang: quoter
gagal **atau** `minOut ≤ 0` → **batalkan route ini** (throw). `swapTokenToEthRobust`
mencoba jalur lain; bila semua gagal, token **ditahan** (leftover/STOPPED) & sweep
mencoba lagi nanti — jauh lebih baik daripada dijual di harga berapa pun. Jalur normal
(quoter sukses) tak berubah: floor tetap dari quote − slippage (5% lalu 15%).

### Resiliensi 409 saat launch
`index.ts:launchWithRetry`. Sebelumnya: `bot.launch()` gagal (mis. 409 "conflict:
terminated by other getUpdates" saat deploy overlap) → `exit(1)` langsung → crash-loop
berisik (6 restart/48j, terkonsentrasi saat deploy). Sekarang: retry berbackoff
(409 → tunggu 5s, lain → 2s; maks 6×) memberi instance lama waktu melepas polling;
menyerah setelah maks → `exit(1)` (systemd auto-restart). Success-path identik
(struktur `.then` dipertahankan). Graceful shutdown SIGTERM→`bot.stop()` sudah ada.

### Type-check hijau
Perbaikan `setChatMenuButton` (`menu_button`/`chat_id` → `menuButton`/`chatId`,
camelCase yg diharapkan telegraf) — `npm run check` kini lolos; tombol menu "/"
benar-benar terpasang (sebelumnya key mismatch, senyap krn try/catch).

## Ditunda — dengan alasan

- **amount0Min/amount1Min pada `decreaseLiquidity`** (masih `0n`). `decreaseLiquidity`
  menarik dana SENDIRI (paparan MEV rendah — bukan swap lawan pihak lain), sementara
  memberi `min ≠ 0` yang salah-hitung bisa me-**revert jalur exit** persis saat volatil
  (waktu terburuk untuk gagal keluar). Vektor kerugian riil = swap token→ETH, sudah
  ditutup lantai swap di atas. Versi aman butuh math v3-sdk (`getAmountsForLiquidity`
  dari likuiditas + tick range + harga) → layak jadi follow-up tersendiri, bukan
  ditempel buru-buru ke path close.

## Audit 2026-07-26 — perubahan yang mendarat

Sumber: `report.md` (29 item, 9 domain × 3 lensa verifikasi). Batch 1–5, semua `npm run check` hijau.

### Uang & data (batch 1–3)
- **Tulis JSON atomik** (`store.writeJson`: tmp + `renameSync`) untuk `positions.json`,
  `settings.json`, `v4positions.json`, `sweep.json`. `load()` tak lagi menelan error senyap
  (JSON rusak dulu terbaca sebagai "tidak ada posisi" → basis PnL & kandidat sweep hilang).
- **Race monitor↔close ditutup.** `store.closing` (Map ber-stempel, kunci kedaluwarsa 10 mnt)
  dibaca monitor: posisi yang sedang ditutup tak dijurnalkan `burned`, dan `finalizeClose`
  non-`cashed` mengalah. *Sebab: `data/journal.jsonl` punya entri ganda tokenId 353277
  (`cashed` +0.00065 ETH lalu `burned` PnL 0, jarak 606 ms) — urutan sebaliknya = PnL hilang.*
- **Sweep tak lagi menjual bag spot.** Kandidat dibatasi ke posisi `STOPPED` + token dari
  close < 24 jam (dulu: semua token yang pernah di-LP → token hasil `/buy` ikut terjual).
- **Monitor tak tumpang tindih** (`ticking`) dan **tak menyapu saat ada tx uang berjalan**
  (`store.isBusy()`; `beginMoneyOp`/`endMoneyOp` di add/close/swap/bridge) — nonce & WETH
  perantara aman.
- **Desimal akuntansi** — `JournalEntry.baseKind` + `formatUnits(dec)`; `lifetimeStats`
  mengecualikan denominasi non-WETH. Pola `=== 'usdg' ? 6 : 18` diganti `isStableBase`.
  *Tanpa ini, trade USDG/USDT pertama melahirkan entri rusak permanen (§8.9).*
- **Close v4 dijurnalkan** (hasil = delta saldo native, konservatif) → `/history` & `/pnl`
  melihat v4; `ca` di jurnal membuat sisa token v4 masuk kandidat sweep.
- **`resultEthWei` Relay diukur** dari delta saldo, bukan estimasi quote (yang bisa 0).
- **Jalur pasca-burn tak melempar** — sweep/unwrap/baca-saldo dibungkus; close separuh gagal
  tetap terjurnal + ditandai sisa. **Pool non-base gagal bersih SEBELUM burn** (dan tak
  diimpor lagi) karena tak ada rute cash-out dua sisi.
- **`/add` v3 menghitung ulang rencana** tepat sebelum mint (tick/harga tak basi; jalur v4
  sudah begitu). **`MAX_ETH_PER_TX` ditegakkan di `/buy`/`/sell`.** **Berhenti menebak
  `decimals = 18`** (beli batal; holdings tanpa decimals dilewati). **`parseAmt`** satu
  parser nominal (potong desimal, tolak `1e-9`).
- **`/bridge`**: quote kedaluwarsa 2 menit, quote tanpa nilai ditolak, bridge tanpa tx tak
  lagi dilaporkan "TERKIRIM".
- **`checkV4Status`** mengembalikan `inRange: null` saat RPC gagal (dulu `false` → alert
  "OUT OF RANGE" palsu). **Cadangan gas wrap** dihitung dari `getFeeData()`.
- **Satu alur aktif per user** (`resetFlows` di tiap pintu masuk + Batal); `pendingChain`
  global dihapus (token dibawa di callback). **Guard owner senyap + hanya chat privat.**

### Dibuang (batch 4)
`menu.ts` + dispatch (reply keyboard tak pernah terkirim), `/portfolio` (dilebur ke kartu
uang), `walletHoldings` (≤20 RPC), `discoverPoolsCached`, field `PoolOption.priceTokenInBase`
(**~55 RPC per discovery**), instance kontrak default-chain di `chain.ts`, tombol `➕ addv4`
(jalur uang tanpa screening/preview/cap), CRUD `/setsize` (jadi satu command `/size`), alias `/addlp` `/stoplp` `/setsize` `/fund` `/menu`,
13 fungsi nol-pemanggil di `messages.ts`, `readPoolTick`, loop `deleteMyCommands`.

### Latensi
Screening ∥ pencarian pool di `/add`; quote `/sell` paralel & tak diminta ulang; fee tier
non-standar disaring sebelum ditawarkan.

### Design (batch 5)
Kartu UANG (`/status`) menampilkan ekuitas wallet + LP + realized dan menyembunyikan chain
bersaldo 0; `/positions`, `/history`, PREVIEW pakai blok `<pre>` sejajar; kartu konfirmasi
swap membawa verdikt BAHAYA + saldo dan **tak merender tombol Konfirmasi saat saldo kurang**;
`msgError` satu baris; alert anjlok bertombol `⛔ Tutup Sekarang`; aksi uang selalu baris
sendiri. `callback_data` lama sengaja **tidak** di-rename (tombol di pesan lama tetap hidup).

### Pemeriksa baru (read-only)
`scripts/smoke-journal.ts` (akuntansi & entri ganda), `scripts/smoke-amount.ts` (parser
nominal), `scripts/smoke-cards.ts` (render semua kartu + tag HTML seimbang).

## Belum (rekomendasi lanjutan)
- Uji live USDG (open + close) — jalur akuntansinya kini siap, angkanya belum teruji.
- Debounce notifikasi IN/OUT range (belum perlu: belum ada laporan spam).
- Progres bertahap saat close (butuh threading callback ke 3 call-site — kosmetik).
- Watchdog eksternal (reuse `scripts/watchdog.sh` LAVENDER, sesuaikan unit).
- Test untuk math `planAddSingleSided` & transisi journal/store.
