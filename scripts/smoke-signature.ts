import assert from 'node:assert/strict';
import { bot } from '../src/core.js';

/**
 * The ownership mark belongs on EVERY outgoing message, whichever path it takes: replies to
 * commands, card edits, document captions, and monitor alerts that call
 * bot.telegram.sendMessage directly. It sits in the telegram layer so no path can
 * miss it, and this test intercepts callApi, BELOW that wrapper.
 */
const tg = bot.telegram as any;
const sent: Array<{ method: string; text: string }> = [];
tg.callApi = async (method: string, p: any) => {
  sent.push({ method, text: p?.text ?? p?.caption ?? '' });
  return {};
};

await tg.sendMessage(1, 'HALO');
await tg.editMessageText(1, 2, undefined, 'EDIT');
await tg.sendDocument(1, 'x', { caption: 'CARD' });
for (const s of sent) assert.ok(s.text.endsWith('<i>Powered by Moaru</i>'), `${s.method} carries no signature`);

// Repeated edits must not stack signatures.
sent.length = 0;
await tg.sendMessage(1, 'ALREADY\n\n<i>Powered by Moaru</i>');
assert.equal((sent[0].text.match(/Powered by Moaru/g) ?? []).length, 1, 'the signature stacks on an edit');

// A message at the limit: better to lose the signature than to have the message REJECTED
// Telegram for being too long.
sent.length = 0;
const huge = 'X'.repeat(4090);
await tg.sendMessage(1, huge);
assert.equal(sent[0].text, huge, 'a message at the limit was pushed over it');
assert.ok(sent[0].text.length <= 4096);

console.log('ok: every outgoing path is signed, nothing stacks, and nothing exceeds the limit.');
