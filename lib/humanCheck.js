// FILE PATH: lib/humanCheck.js
// 🧑 HUMAN CHECK ("bot fighter"): a tiny "Tap the Apple" test that a real person solves in 2 seconds.
// When is it asked?
//   • Withdraw: the user must have passed the check in the last 7 days (humanOkAt).
//   • Ads / Farm claims: only when botGuard found a suspicious pattern (user.humanRequired = true).
// How it works (ZERO extra database reads for making a question, the question is signed, not stored):
//   1) GET  /api/human            -> server makes a signed question + 6 emoji options
//   2) POST /api/human {verify}   -> server checks the signature, the time (not too fast, not too slow) and the answer
//   3) pass  -> humanOkAt = now, humanRequired removed       fail -> humanFails + 1; 5 fails in a row -> account locked + admin alert
import crypto from 'crypto';
import { tgSend } from './tg.js';

// ===== EDIT HERE =====
export const HUMAN = {
  VALID_MS: 7 * 24 * 3600 * 1000,   // a passed check counts for 7 days (withdraw)
  SKIP_BOTGUARD_MS: 6 * 3600 * 1000, // after a pass, botGuard does not ask again for 6 hours
  MIN_SOLVE_MS: 1200,               // answered faster than this = a script
  MAX_SOLVE_MS: 120 * 1000,         // question expires after 2 minutes
  LOCK_AFTER_FAILS: 5,              // wrong answers in a row before the account is locked
};
// =====================

const ITEMS = [['🍎', 'Apple'], ['🍌', 'Banana'], ['🍇', 'Grapes'], ['🍓', 'Strawberry'], ['🍊', 'Orange'], ['🍉', 'Watermelon'],
  ['🍒', 'Cherries'], ['🥕', 'Carrot'], ['🌽', 'Corn'], ['🐶', 'Dog'], ['🐱', 'Cat'], ['🐸', 'Frog'], ['🐟', 'Fish'], ['⭐', 'Star'], ['🚗', 'Car'], ['⚽', 'Ball']];

const key = () => crypto.createHash('sha256').update('human:' + process.env.BOT_TOKEN).digest();
const sign = (s) => crypto.createHmac('sha256', key()).update(s).digest('hex');
const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Does this user have to pass the check right now?  kind: 'withdraw' | 'claim'
export function humanNeeded(user, kind) {
  if (user.humanRequired) return true;
  if (kind === 'withdraw') {
    const t = user.humanOkAt ? new Date(user.humanOkAt).getTime() : 0;
    return Date.now() - t > HUMAN.VALID_MS;
  }
  return false;
}

// Make a signed question. Nothing is saved anywhere.
export function makeChallenge(tgId) {
  const pool = [...ITEMS].sort(() => crypto.randomInt(3) - 1).slice(0, 6);
  const [emoji, name] = pool[crypto.randomInt(pool.length)];
  const body = Buffer.from(JSON.stringify({ u: String(tgId), n: crypto.randomBytes(6).toString('hex'), t: Date.now(), e: emoji })).toString('base64url');
  return { token: `${body}.${sign(body)}`, question: `Tap the ${name}`, options: pool.map((p) => p[0]) };
}

// Check an answer. Returns { ok, reason, nonce }. reason: bad_token | expired | too_fast | wrong
export function checkAnswer(tgId, token, answer) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return { ok: false, reason: 'bad_token' };
    const a = Buffer.from(sign(body)), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_token' };
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.u !== String(tgId)) return { ok: false, reason: 'bad_token' };
    const age = Date.now() - p.t;
    if (age > HUMAN.MAX_SOLVE_MS || age < 0) return { ok: false, reason: 'expired' };
    if (age < HUMAN.MIN_SOLVE_MS) return { ok: false, reason: 'too_fast', nonce: p.n };
    if (String(answer) !== p.e) return { ok: false, reason: 'wrong', nonce: p.n };
    return { ok: true, nonce: p.n };
  } catch {
    return { ok: false, reason: 'bad_token' };
  }
}

// Too many wrong answers: lock the account (admin can Unlock) and tell the admin.
export async function lockForHumanFail(db, user) {
  const tgId = String(user.telegramId);
  const r = await db.collection('users').updateOne(
    { telegramId: tgId, accountLocked: { $ne: true }, isBanned: { $ne: true } },
    { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'human_fail' } }
  );
  const adminId = process.env.ADMIN_ID;
  if (r.modifiedCount > 0 && adminId) {
    tgSend(adminId,
      `🧑‍🔧 <b>Human check failed ${HUMAN.LOCK_AFTER_FAILS}× — account LOCKED</b>\n\nUser: <code>${esc(tgId)}</code>${user.username ? ' (@' + esc(user.username) + ')' : ''}\n💰 Balance: <b>${(user.egBalance || 0).toLocaleString()} MM$</b>\n\n<i>A real person passes "Tap the Apple" at once. This is most likely a script.</i>`,
      { reply_markup: { inline_keyboard: [[{ text: '🔓 Unlock', callback_data: `unlock_${tgId}` }, { text: '🚫 Ban User', callback_data: `ban_${tgId}` }]] } }).catch(() => {});
  }
  return r.modifiedCount > 0;
}
