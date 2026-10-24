// FILE PATH: lib/ipRegistry.js
// (GitHub repo te ei path e file ta rakhbe: lib/ipRegistry.js)
// One-account-per-DEVICE gate (ported from NEWTUBE Season 4). Keyed by the device fingerprint,
// with raw IP only as a soft fallback (Bangladeshi mobile carriers share one IP between many phones,
// so a pure IP gate blocks real people).
import { tgSend } from './tg.js';

export const IP_SIGNUP_VELOCITY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
export const IP_SIGNUP_VELOCITY_THRESHOLD = 15;            // 15+ new accounts from one IP inside the window -> locked

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return req.socket?.remoteAddress || 'unknown';
}

export async function recordSignupAndCheckVelocity(db, ip) {
  if (!ip || ip === 'unknown') return { count: 0 };
  const r = await db.collection('ipSignupVelocity').findOneAndUpdate(
    { _id: ip },
    { $push: { recentSignups: { $each: [new Date()], $slice: -50 } } },
    { upsert: true, returnDocument: 'after' }
  );
  const entry = r?.value !== undefined ? r.value : r;
  const start = Date.now() - IP_SIGNUP_VELOCITY_WINDOW_MS;
  return { count: (entry?.recentSignups || []).filter(t => new Date(t).getTime() >= start).length };
}

export function registryKey(fingerprint, ip) {
  if (fingerprint && typeof fingerprint === 'string' && fingerprint.length >= 16) return fingerprint;
  if (ip && ip !== 'unknown') return `ip:${ip}`;
  return null;
}

// { blocked:false } free / already yours.  { blocked:true, ownerId } a DIFFERENT account owns this device.
export async function checkDevice(db, fingerprint, ip, tgId) {
  const key = registryKey(fingerprint, ip);
  if (!key) return { blocked: false, key: null };
  const entry = await db.collection('ipRegistry').findOne({ _id: key });
  if (!entry) return { blocked: false, unclaimed: true, key };
  if (entry.userId === tgId) {
    db.collection('ipRegistry').updateOne({ _id: key }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    return { blocked: false, key };
  }
  if (key.startsWith('ip:')) return { blocked: false, fallbackCollision: true, ownerId: entry.userId, key }; // soft
  return { blocked: true, ownerId: entry.userId, key };
}

export async function claimDevice(db, key, tgId) {
  if (!key) return;
  await db.collection('ipRegistry').updateOne(
    { _id: key },
    { $set: { userId: tgId, claimedAt: new Date(), lastSeenAt: new Date() } },
    { upsert: true }
  );
}

// "Switch account": force-claim a device owned by someone else, at the cost of wiping this account's balance.
// Same device can only be force-switched once per 24h.
const SWITCH_COOLDOWN_HOURS = 24;
export async function claimDeviceForUser(db, key, tgId) {
  if (!key) return { ok: true };
  const registry = db.collection('ipRegistry');
  const entry = await registry.findOne({ _id: key });
  if (entry?.lastSwitchAt) {
    const wait = SWITCH_COOLDOWN_HOURS * 3600000 - (Date.now() - new Date(entry.lastSwitchAt).getTime());
    if (wait > 0) return { ok: false, retryAfterMs: wait };
  }
  const updated = await registry.findOneAndUpdate(
    { _id: key },
    { $set: { userId: tgId, claimedAt: new Date(), lastSeenAt: new Date(), lastSwitchAt: new Date() }, $inc: { switchCount: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  await db.collection('users').updateOne(
    { telegramId: tgId },
    { $set: { egBalance: 0, lastAccountSwitchAt: new Date() }, $inc: { accountSwitchCount: 1 } }
  );
  const n = updated?.switchCount ?? updated?.value?.switchCount;
  if ((n === 5 || n === 15 || n === 50) && process.env.ADMIN_ID) {
    tgSend(process.env.ADMIN_ID, `🚩 <b>Device switched ${n}× (no action taken)</b>\n\nOne device was force-switched to a different account ${n} times. Latest account: <code>${tgId}</code>`).catch(() => {});
  }
  return { ok: true };
}

export async function getOwnerPublicInfo(db, ownerId) {
  const o = await db.collection('users').findOne({ telegramId: ownerId }, { projection: { firstName: 1, username: 1 } });
  return { telegramId: ownerId, firstName: o?.firstName || 'User', username: o?.username || null };
}
