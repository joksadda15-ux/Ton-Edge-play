// FILE PATH: lib/cronAuth.js
// (GitHub repo te ei path e file ta rakhbe: lib/cronAuth.js)
// Protects cron endpoints. Needs env CRON_SECRET (long random string). Fail-closed.
// Accepts header  Authorization: Bearer <CRON_SECRET>  or  ?secret=<CRON_SECRET>
import crypto from 'crypto';

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = String(req.headers?.['authorization'] || '');
  const q = String(req.query?.secret || '');
  return safeEq(bearer, `Bearer ${secret}`) || safeEq(q, secret);
}
