// FILE PATH: lib/tg.js
// (GitHub repo te ei path e file ta rakhbe: lib/tg.js)
export async function tgSend(chatId, text, extra = {}) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
  return r.json();
}

// ── more Telegram helpers (ported from NEWTUBE lib/telegram.js) ─────────────
export async function tgApi(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

// Is this user a member of the channel/group? Used by Channel/Group Join tasks (the bot must be admin there).
async function memberStatus(userId, chat) {
  try {
    const r = await tgApi('getChatMember', { chat_id: chat, user_id: Number(userId) });
    if (!r?.ok) return { ok: false };
    return { ok: true, status: r.result?.status };
  } catch { return { ok: false }; }
}
export async function isMember(userId, chat) {
  let r = await memberStatus(userId, chat);
  if (!r.ok) { await new Promise((x) => setTimeout(x, 500)); r = await memberStatus(userId, chat); } // one retry
  if (!r.ok) return false;                                                                           // fail closed
  return ['member', 'administrator', 'creator'].includes(r.status);
}

// Is OUR bot an admin of this channel/group? Checked before an API task is created (nobody pays for a task that can never be verified).
let __botId = null;
async function getBotId() {
  if (__botId) return __botId;
  try { const r = await tgApi('getMe', {}); if (r?.ok) __botId = r.result.id; } catch { /* ignore */ }
  return __botId;
}
export async function checkBotAdmin(chat) {
  const botId = await getBotId();
  if (!botId) return { ok: false, error: 'server_error' };
  let r;
  try { r = await tgApi('getChatMember', { chat_id: chat, user_id: botId }); } catch { return { ok: false, error: 'server_error' }; }
  if (!r?.ok || !['administrator', 'creator'].includes(r.result?.status)) return { ok: false, error: 'bot_not_admin' };
  let title = null;
  try { const c = await tgApi('getChat', { chat_id: chat }); if (c?.ok) title = c.result?.title || null; } catch { /* ignore */ }
  return { ok: true, title };
}
