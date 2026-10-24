// FILE PATH: lib/auth.js
// (GitHub repo te ei path e file ta rakhbe: lib/auth.js)
// Telegram initData verification (ported from NEWTUBE lib/telegramAuth.js).
// Upgrades: (1) session expires after 24h (replay protection), (2) timing-safe compare.
import crypto from 'crypto';

const MAX_AUTH_AGE_SECONDS = 86400;

export function verifyTelegramInit(initData) {
  try {
    if (!initData || typeof initData !== 'string' || !process.env.BOT_TOKEN) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const authDate = parseInt(params.get('auth_date'), 10);
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (isNaN(authDate) || age > MAX_AUTH_AGE_SECONDS || age < -60) return null;

    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}
