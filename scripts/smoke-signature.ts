import assert from 'node:assert/strict';
import { bot } from '../src/core.js';

/**
 * Tanda kepemilikan wajib ada di SETIAP keluaran, lewat jalur mana pun: balasan
 * command, edit kartu, caption dokumen, dan alert monitor yang memakai
 * bot.telegram.sendMessage langsung. Dipasang di lapisan telegram supaya tak ada
 * jalur yang terlewat — pengujiannya mencegat callApi, di BAWAH pembungkus itu.
 */
const tg = bot.telegram as any;
const sent: Array<{ method: string; text: string }> = [];
tg.callApi = async (method: string, p: any) => {
  sent.push({ method, text: p?.text ?? p?.caption ?? '' });
  return {};
};

await tg.sendMessage(1, 'HALO');
await tg.editMessageText(1, 2, undefined, 'EDIT');
await tg.sendDocument(1, 'x', { caption: 'KARTU' });
for (const s of sent) assert.ok(s.text.endsWith('<i>Powered by Moaru</i>'), `${s.method} tak bertanda tangan`);

// Edit berulang tak boleh menumpuk tanda tangan.
sent.length = 0;
await tg.sendMessage(1, 'SUDAH\n\n<i>Powered by Moaru</i>');
assert.equal((sent[0].text.match(/Powered by Moaru/g) ?? []).length, 1, 'tanda tangan menumpuk saat edit');

// Pesan mepet batas: lebih baik kehilangan tanda tangan daripada pesan DITOLAK
// Telegram karena kepanjangan.
sent.length = 0;
const huge = 'X'.repeat(4090);
await tg.sendMessage(1, huge);
assert.equal(sent[0].text, huge, 'pesan mepet batas jadi kepanjangan');
assert.ok(sent[0].text.length <= 4096);

console.log('OK — signature: semua jalur keluaran bertanda, tak menumpuk, tak melewati batas.');
