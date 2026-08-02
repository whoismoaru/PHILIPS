/**
 * Retry sekali untuk jalur uang, dijaga state on-chain.
 *
 * Di jalur uang, kegagalan paling lumrah justru terjadi SESUDAH transaksi mendarat
 * (saldo terbaca basi, wait timeout, verifikasi gagal). Mengulang di situ = beli /
 * jual / mint dua kali dengan uang yang tak disetujui pemilik. Karena itu yang jadi
 * wasit adalah state on-chain, BUKAN jenis error-nya — pesan error tak pernah bisa
 * dipercaya soal apa yang sudah mendarat.
 *
 * `probe` mengembalikan angka yang PASTI berubah bila ada yang mendarat (saldo,
 * likuiditas, jumlah NFT posisi). -1n atau melempar = tak bisa dipastikan → dianggap
 * sudah bergerak → tidak diulang. Ragu berarti berhenti.
 */
export type RetryLog = (line: string) => void;

export async function retryOnce<T>(
  label: string,
  probe: () => Promise<bigint>,
  run: () => Promise<T>,
  opts: { onRetry?: () => Promise<void>; sleepMs?: number; log?: RetryLog } = {},
): Promise<T> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const before = await probe().catch(() => -1n);
  try {
    return await run();
  } catch (first) {
    const after = await probe().catch(() => -1n);
    const why = (first as Error).message.slice(0, 160);
    if (before < 0n || after < 0n || after !== before) {
      log(`[retry:${label}] TAK diulang (state ${before}→${after}): ${why}`);
      throw first;
    }
    log(`[retry:${label}] percobaan 1 gagal, on-chain tak berubah — ulang: ${why}`);
    if (opts.onRetry) await opts.onRetry().catch(() => {});
    await new Promise((r) => setTimeout(r, opts.sleepMs ?? 2500));
    return await run();
  }
}
