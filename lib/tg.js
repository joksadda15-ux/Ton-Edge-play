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
