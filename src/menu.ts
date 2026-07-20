/**
 * Menu keyboard bawah yang persisten (reply keyboard) — aksi umum sekali tap tanpa
 * mengetik command. Tombol mengirim labelnya sebagai teks biasa; resolveMenu() memetakan
 * label → command. Dispatch ada di handler teks index.ts (label bukan '/command', jadi
 * bot.command tidak menangkapnya). Emoji di sini = label tombol (diizinkan tg-ui).
 */

export const MENU_KEYBOARD = {
  keyboard: [
    ['📊 Status', '📋 Posisi'],
    ['💰 PnL', '🧾 Riwayat'],
    ['➕ Tambah LP', '⛔ Tutup'],
    ['⚙️ Ukuran', '❔ Bantuan'],
  ] as string[][],
  resize_keyboard: true,
  is_persistent: true,
};

const MENU_MAP: Record<string, string> = {
  '📊 Status': '/status',
  '📋 Posisi': '/positions',
  '💰 PnL': '/pnl',
  '🧾 Riwayat': '/history',
  '➕ Tambah LP': '/add',
  '⛔ Tutup': '/stop',
  '⚙️ Ukuran': '/setsize',
  '❔ Bantuan': '/help',
};

/** Label menu → command, atau null bila teks bukan tombol menu. */
export function resolveMenu(text: string): string | null {
  return MENU_MAP[text] ?? null;
}
