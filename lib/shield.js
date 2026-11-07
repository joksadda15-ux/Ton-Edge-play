// FILE PATH: lib/shield.js
// 🛡 SHIELD: rate limit + auto-block + webhook protection. Keeps a hacker's "unlimited calls" from crashing the server.
// Layers (all in memory, ZERO database calls, so it costs almost no CPU):
//   1) Telegram webhook (/api/bot): must carry the secret token (env WEBHOOK_SECRET), otherwise rejected at once.
//   2) Per IP: LIMITS.ipPerMin calls per minute (high on purpose: Bangladeshi mobile carriers share one IP between many phones).
//   3) Per verified Telegram user: max 100 calls per minute in total + a smaller limit per route (withdraw POST = 6 per minute).
//   4) Fake / invalid sessions (junk requests): max 30 per minute per IP, and a global budget. Real users are never affected by it.
//   5) 3 strikes in 10 minutes -> temporary block (10 min) + an alert to the admin (max 1 alert per hour per key).
import crypto from 'crypto';
import { verifyTelegramInit } from './auth.js';
import { tgSend } from './tg.js';

const MIN = 60_000;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// ===== EDIT HERE =====
export const LIMITS = {
  userPerMin: num(process.env.RL_USER_PER_MIN, 100),   // ALL calls of one user, per minute
  ipPerMin: num(process.env.RL_IP_PER_MIN, 600),       // all calls of one IP, per minute (shared carrier IPs!)
  badSessionPerMin: 30,                                // invalid-session calls per IP per minute
  badGlobalPerMin: 1500,                               // invalid-session calls from everyone, per minute (circuit breaker)
  routePerMin: { user: 30, farm: 40, ads: 40, tasks: 60, daily: 15, payments: 40, withdraw: 30 },
  withdrawPostPerMin: 6,                               // creating a withdrawal / wallet change
  strikesToBlock: 3,
  strikeWindowMs: 10 * MIN,
  blockMs: 10 * MIN,
};
// =====================

const ADMIN_ID = process.env.ADMIN_ID;
const counters = new Map(); // key -> { n, reset }
const blocks = new Map();   // key -> until (ms)
const alerted = new Map();  // key -> last alert (ms)
const MAX_KEYS = 200_000;

function hit(key, limit, windowMs = MIN) {
  const now = Date.now();
  let c = counters.get(key);
  if (!c || c.reset <= now) { c = { n: 0, reset: now + windowMs }; counters.set(key, c); }
  c.n++;
  return { ok: c.n <= limit, n: c.n, retry: Math.max(1, Math.ceil((c.reset - now) / 1000)) };
}
const blockedFor = (key) => { const u = blocks.get(key); if (!u) return 0; if (u <= Date.now()) { blocks.delete(key); return 0; } return Math.ceil((u - Date.now()) / 1000); };

setInterval(() => {                       // housekeeping: forget old counters so memory never grows
  const now = Date.now();
  for (const [k, c] of counters) if (c.reset <= now) counters.delete(k);
  for (const [k, u] of blocks) if (u <= now) blocks.delete(k);
  for (const [k, t] of alerted) if (now - t > 3600_000) alerted.delete(k);
  if (counters.size > MAX_KEYS) counters.clear(); // spoofed-key flood: drop everything rather than run out of memory
}, MIN).unref();

const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// Cloudflare (Render sits behind it) sets cf-connecting-ip and a client cannot fake it; else fall back to the first x-forwarded-for.
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function deny(res, retry, error = 'rate_limited') {
  res.set('Retry-After', String(retry));
  return res.status(429).json({ ok: false, success: false, error, retryAfter: retry });
}

function alertAdmin(key, text, markup) {
  if (!ADMIN_ID) return;
  const last = alerted.get(key) || 0;
  if (Date.now() - last < 3600_000) return;
  alerted.set(key, Date.now());
  tgSend(ADMIN_ID, text, markup ? { reply_markup: markup } : {}).catch(() => {});
}

// one strike; the 3rd strike inside 10 minutes blocks the key and tells the admin
function strike(key, label, userId) {
  const s = hit('st:' + key, LIMITS.strikesToBlock, LIMITS.strikeWindowMs);
  if (s.n < LIMITS.strikesToBlock) return;
  blocks.set(key, Date.now() + LIMITS.blockMs);
  const mins = Math.round(LIMITS.blockMs / MIN);
  if (userId) {
    alertAdmin(key,
      `🛡 <b>Shield: user blocked for ${mins} min</b>\n\n👤 <code>${userId}</code> sent far too many requests (more than ${LIMITS.userPerMin}/min). Possible script / hacker.\nHe gets "429 Too many requests" until the block ends. Nothing else was changed.`,
      { inline_keyboard: [[{ text: '🔎 Review', callback_data: `lookup_${userId}` }, { text: '🔒 Lock', callback_data: `lock_${userId}` }], [{ text: '🚨 Scam: Reject + Zero + Ban', callback_data: `scam_${userId}` }]] });
  } else {
    alertAdmin(key, `🛡 <b>Shield: IP blocked for ${mins} min</b>\n\n${label}\nIP: <code>${key.replace(/^ip:/, '')}</code>`);
  }
}

// ── 1st layer: before the body is read. Webhook secret + per-IP limit ──
export function shieldIp(req, res, next) {
  const p = req.path;
  if (p === '/health') return next();
  const ip = clientIp(req);
  req.shieldIp = ip;

  if (p === '/api/bot') {                                    // only Telegram knows the secret token
    const secret = process.env.WEBHOOK_SECRET;
    if (secret && !safeEq(req.headers['x-telegram-bot-api-secret-token'] || '', secret)) {
      const b = hit('badbot:' + ip, 20);
      if (!b.ok) blocks.set('ip:' + ip, Date.now() + LIMITS.blockMs);
      return res.status(403).json({ ok: false });
    }
    return next();
  }
  const key = 'ip:' + ip;
  const left = blockedFor(key);
  if (left) return deny(res, left, 'temporarily_blocked');
  const r = hit(key, LIMITS.ipPerMin);
  if (!r.ok) { strike(key, `One IP made more than ${LIMITS.ipPerMin} requests in a minute.`); return deny(res, r.retry); }
  next();
}

// ── 2nd layer: after the body is read. Per verified user + fake-session limit ──
export function shieldUser(req, res, next) {
  const m = /^\/api\/([a-z]+)\/?$/.exec(req.path);
  if (!m) return next();
  const name = m[1];
  if (name === 'bot' || name === 'cron' || name === 'logo') return next();
  if (name === 'ads' && req.query?.s2s) return next();            // Adsgram server callback (has its own secret)
  if (name === 'payments' && req.query?.cron) return next();      // cron (has its own secret)

  const src = req.method === 'GET' ? req.query : (req.body || {});
  const initData = typeof src?.initData === 'string' ? src.initData : (typeof req.query?.initData === 'string' ? req.query.initData : '');
  const tg = initData ? verifyTelegramInit(initData) : null;
  const ip = req.shieldIp || clientIp(req);

  if (!tg || !tg.id) {                                           // junk / fake session: the handler will answer 403, we only count it
    const g = hit('badglobal', LIMITS.badGlobalPerMin);
    const b = hit('bad:' + ip, LIMITS.badSessionPerMin);
    if (!b.ok) {
      blocks.set('ip:' + ip, Date.now() + LIMITS.blockMs);
      alertAdmin('ip:' + ip, `🛡 <b>Shield: IP blocked for ${Math.round(LIMITS.blockMs / MIN)} min</b>\n\n${LIMITS.badSessionPerMin}+ requests with a fake Telegram session in one minute.\nIP: <code>${ip}</code>`);
      return deny(res, b.retry);
    }
    if (!g.ok) return deny(res, g.retry);
    return next();
  }

  const uid = String(tg.id), key = 'u:' + uid;
  const left = blockedFor(key);
  if (left) return deny(res, left, 'temporarily_blocked');
  const routeName = name === 'withdraw' && req.method === 'POST' ? 'withdraw:post' : name;
  const routeLimit = routeName === 'withdraw:post' ? LIMITS.withdrawPostPerMin : (LIMITS.routePerMin[name] || LIMITS.userPerMin);
  const all = hit(key, LIMITS.userPerMin);
  const rt = hit(`${key}:${routeName}`, routeLimit);
  if (!all.ok || !rt.ok) { strike(key, '', uid); return deny(res, Math.max(all.ok ? 0 : all.retry, rt.ok ? 0 : rt.retry) || 1); }
  req.shieldUserId = uid;
  next();
}
