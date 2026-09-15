import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * A Refresh button REDRAWS. It does not redo work, and it does not post a new card.
 *
 * On the pool step it did both: the handler dropped the screening verdict it already held,
 * so every tap re-audited the token and pushed a fresh screening card on top of the list
 * (15 Sep 2026). The rule below is deliberately structural rather than about that one
 * button, so the next refresh added anywhere has to obey it too -- v3, v4, any chain.
 */
const idxSrc = readFileSync('src/index.ts', 'utf8');
const files = ['src/index.ts', ...readdirSync('src/commands').map((f) => `src/commands/${f}`)];
const handlers: Array<{ file: string; name: string; body: string }> = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // Every bot.action whose callback name mentions a refresh.
  const re = /bot\.action\(\s*(?:\/\^?)?['"/]([^'"/)]*refresh[^'"/)]*)/gi;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const body = src.slice(m.index, src.indexOf('\nbot.action', m.index + 10) + 1 || m.index + 1200);
    handlers.push({ file: f, name: m[1], body: body.slice(0, 1400) });
  }
}
// Three more buttons are LABELLED Refresh while their callbacks are named after what they
// redraw (a v3 card, a v4 card, one position's detail). They are held to the same rule --
// the label is what the owner reads, not the callback name.
for (const cb of ['back:card', 'detail:', 'posv4:']) {
  assert.match(idxSrc, new RegExp(`Markup\\.button\\.callback\\('🔄 Refresh', \`${cb.replace(':', ':')}`), `the Refresh button for ${cb} is gone`);
  const at = idxSrc.indexOf(`bot.action(/^${cb.replace(':', '')}`);
  if (at < 0) continue;
  // Stop at the NEXT handler: reading past it pulls in that one's replies and blames them
  // on this button.
  const end = idxSrc.indexOf('\nbot.action', at + 10);
  const body = idxSrc.slice(at, end > at ? end : at + 1200);
  handlers.push({ file: 'src/index.ts', name: cb, body });
}
assert.ok(handlers.length >= 7, `only ${handlers.length} refresh handlers found — the scan is not seeing them`);

for (const h of handlers) {
  // 1) It must EDIT the card it was tapped on. A refresh that replies pushes a duplicate
  //    down the chat and leaves the stale one above it.
  // Either it edits the message itself, or it calls a renderer with the edit flag set --
  // `renderX(ctx, …, true)` is how most of these redraw.
  const edits = /editMessageText|editMessageMedia|message_id|render\w*\([^)]*\btrue\)|cmd\w*\(ctx, true\)/.test(h.body);
  assert.ok(edits, `${h.file} ${h.name}: refresh does not edit in place`);

  // 2) It must not send a NEW card of its own. ctx.reply inside a refresh is how the
  //    screening card ended up stacked on the pool list; an error reply is the exception.
  const replies = [...h.body.matchAll(/ctx\.reply\(/g)];
  for (const r of replies) {
    const line = h.body.slice(Math.max(0, r.index! - 120), r.index! + 60);
    assert.match(line, /msgError|catch|Error/, `${h.file} ${h.name}: refresh sends a card that is not an error`);
  }

  // 3) "not modified" is Telegram saying nothing changed, never a failure to report.
  if (/editMessageText/.test(h.body))
    assert.match(h.body, /not modified/i, `${h.file} ${h.name}: an unchanged card will surface as an error`);
}

// 4) The specific regression: the pool refresh keeps the verdict it already has.
const pool = idxSrc.slice(idxSrc.indexOf("bot.action('pool:refresh'"), idxSrc.indexOf("bot.action('pool:refresh'") + 900);
assert.match(pool, /bahaya: flow\.screenBahaya/, 'the pool refresh will re-audit the token again');

console.log(`ok: ${handlers.length} refresh buttons all redraw in place, none redo the audit`);
