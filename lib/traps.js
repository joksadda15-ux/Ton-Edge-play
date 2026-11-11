// FILE PATH: lib/traps.js
// 🪤 TRIPWIRES: things a normal user of the real app can NEVER do, so one hit means someone is poking the API by hand / with a script.
// The real app (index.html) never sends these, so there are no false alarms from normal users:
//   • an unknown action / a farm number that does not exist
//   • extra "decoy" fields in a request body that the app never sends (reward, amount, balance ...) = someone tries to change the price/reward
//   • calling a hidden decoy URL (honeypot) such as /api/admin or /api/grant
// What happens:
//   1st hit  -> logged on the user (trapHits, trapLog) + ONE alert to the admin (max 1 per user per 24h)
//   3rd hit  -> the account is auto-locked (no withdraw, no rewards) and the admin gets a Lock/Ban alert
// Admin: 🕵️ Fraud Scans → 🪤 Trap Hits lists the latest hits.
import { tgSend } from './tg.js';

export const TRAP = { LOCK_AT: 3, ALERT_EVERY_MS: 24 * 3600 * 1000 };
const ADMIN_ID = process.env.ADMIN_ID;
const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Fields the real app never sends to the money endpoints. If one of them shows up, somebody edited the request.
const DECOY_FIELDS = ['reward', 'amount', 'balance', 'egBalance', 'price', 'hours', 'usdtAmount', 'bonus', 'multiplier', 'isAdmin', 'admin'];
export function decoyFieldsIn(body) {
  if (!body || typeof body !== 'object') return [];
  return DECOY_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
}

// Record one trap hit for a user. Never throws, never blocks the request (caller may ignore the result).
// Returns true when the account is (now) locked because of traps.
export async function trapHit(db, tgId, kind, detail = '') {
  try {
    if (!tgId) return false;
    const users = db.collection('users');
    const now = new Date();
    const r = await users.findOneAndUpdate(
      { telegramId: String(tgId) },
      { $inc: { trapHits: 1 }, $set: { lastTrapAt: now }, $push: { trapLog: { $each: [{ k: String(kind).slice(0, 40), d: String(detail).slice(0, 120), t: now }], $slice: -10 } } },
      { returnDocument: 'after' }
    );
    const u = r?.value !== undefined ? r.value : r;
    if (!u) return false;
    db.collection('trapEvents').insertOne({ telegramId: String(tgId), kind: String(kind).slice(0, 40), detail: String(detail).slice(0, 120), at: now }).catch(() => {});

    let locked = !!u.accountLocked;
    if ((u.trapHits || 0) >= TRAP.LOCK_AT && !u.accountLocked && !u.isBanned) {
      const l = await users.updateOne(
        { telegramId: String(tgId), accountLocked: { $ne: true } },
        { $set: { accountLocked: true, accountLockedAt: now, accountLockedReason: 'trap' } }
      );
      locked = locked || l.modifiedCount > 0;
    }
    // alert: at most once per 24h per user, but ALWAYS when the account was just locked
    const justLocked = locked && !u.accountLocked;
    const last = u.lastTrapAlertAt ? new Date(u.lastTrapAlertAt).getTime() : 0;
    if (ADMIN_ID && (justLocked || Date.now() - last > TRAP.ALERT_EVERY_MS)) {
      await users.updateOne({ telegramId: String(tgId) }, { $set: { lastTrapAlertAt: now } });
      tgSend(ADMIN_ID,
        `🪤 <b>Trap triggered${justLocked ? ' — account LOCKED' : ''}</b>\n\n` +
        `User: <code>${esc(tgId)}</code>${u.username ? ' (@' + esc(u.username) + ')' : ''}\n` +
        `Trap: <b>${esc(kind)}</b>${detail ? `\n<code>${esc(String(detail).slice(0, 120))}</code>` : ''}\n` +
        `Hits so far: <b>${u.trapHits}</b> (auto-lock at ${TRAP.LOCK_AT})\n` +
        `💰 Balance: <b>${(u.egBalance || 0).toLocaleString()} MM$</b>\n\n` +
        `<i>The real app can never trigger this. Someone is calling the API by hand or with a script.</i>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🔎 Review', callback_data: `lookup_${tgId}` }, { text: u.accountLocked || justLocked ? '🔓 Unlock' : '🔒 Lock', callback_data: `${u.accountLocked || justLocked ? 'unlock' : 'lock'}_${tgId}` }],
          [{ text: '🚨 Scam: Reject + Zero + Ban', callback_data: `scam_${tgId}` }],
        ] } }
      ).catch(() => {});
    }
    return locked;
  } catch (e) { console.error('trapHit failed:', e.message); return false; }
}

// Honeypot URLs: nothing in the real app calls these. Bots and hackers scanning for "admin" style endpoints do.
export const HONEYPOT_PATHS = ['admin', 'debug', 'grant', 'giveBalance', 'setBalance', 'config', 'export', 'backup', 'wallet', 'reward'];
const seenIp = new Map(); // ip -> last log time (log each IP at most once per 10 minutes, so a scanner cannot flood the database)
export async function honeypotHit(db, req, name, tgIdMaybe) {
  try {
    const ip = req.shieldIp || req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    if (tgIdMaybe) await trapHit(db, tgIdMaybe, 'honeypot_url', `/api/${name}`);
    const last = seenIp.get(ip) || 0;
    if (Date.now() - last < 600000) return;
    seenIp.set(ip, Date.now());
    if (seenIp.size > 5000) seenIp.clear();
    await db.collection('trapEvents').insertOne({ telegramId: tgIdMaybe ? String(tgIdMaybe) : null, kind: 'honeypot_url', detail: `/api/${name}`, ip, at: new Date() });
  } catch { /* ignore */ }
}

let trapIndexReady = false;
export async function ensureTrapIndex(db) {
  if (trapIndexReady) return;
  trapIndexReady = true;
  await db.collection('trapEvents').createIndex({ at: 1 }, { expireAfterSeconds: 14 * 86400 }).catch(() => {}); // log is deleted after 14 days
}
