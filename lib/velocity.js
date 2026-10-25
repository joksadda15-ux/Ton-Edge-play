// FILE PATH: lib/velocity.js
// Velocity checks (ported from NEWTUBE). "Velocity" = too many signups, too fast.
//   1) Referral velocity: one referrer gets REFERRAL_VELOCITY_THRESHOLD+ signups inside REFERRAL_VELOCITY_WINDOW_MS.
//      Real promotion never delivers signups this fast. ALERT-ONLY: nothing is blocked, the admin decides.
//   2) IP signup velocity: lives in lib/ipRegistry.js (accounts from one IP are auto-locked); the alert is sent from here.
import { tgSend } from './tg.js';
import { IP_SIGNUP_VELOCITY_THRESHOLD, IP_SIGNUP_VELOCITY_WINDOW_MS } from './ipRegistry.js';

// ===== EDIT HERE =====
export const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const REFERRAL_VELOCITY_THRESHOLD = 20;            // 20+ signups under one referrer inside that window
// =====================

const ADMIN_ID = process.env.ADMIN_ID;

// Call with the referrer document AFTER the new signup was pushed onto `recentReferralSignups`.
export async function checkReferralVelocity(db, referrerDoc) {
  if (!referrerDoc || referrerDoc.accountLocked || referrerDoc.velocityFlaggedAt) return;
  const start = Date.now() - REFERRAL_VELOCITY_WINDOW_MS;
  const recent = (referrerDoc.recentReferralSignups || []).filter((t) => new Date(t).getTime() >= start).length;
  if (recent < REFERRAL_VELOCITY_THRESHOLD) return;

  // Atomic guard: only the first signup that crosses the line flags the account and sends the alert.
  const r = await db.collection('users').updateOne(
    { telegramId: referrerDoc.telegramId, velocityFlaggedAt: { $exists: false } },
    { $set: { velocityFlaggedAt: new Date(), velocityFlaggedReason: 'referral_velocity' } }
  );
  if (r.modifiedCount > 0 && ADMIN_ID) {
    const minutes = Math.round(REFERRAL_VELOCITY_WINDOW_MS / 60000);
    tgSend(ADMIN_ID,
      `🚩 <b>Referral velocity alert (no action taken)</b>\n\n` +
      `Referrer <code>${referrerDoc.telegramId}</code> just got <b>${REFERRAL_VELOCITY_THRESHOLD}+</b> signups within <b>${minutes} minutes</b>. Real promotion is never this fast.\n\n` +
      `Nothing is blocked. Check the account, then Lock it if it looks fake, or Clear the flag if it is a real promotion.`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔎 Review', callback_data: `lookup_${referrerDoc.telegramId}` }, { text: '🔒 Lock', callback_data: `lock_${referrerDoc.telegramId}` }],
        [{ text: '✅ Clear flag', callback_data: `vclear_${referrerDoc.telegramId}` }],
      ] } }
    ).catch(() => {});
  }
}

// Admin alert for the IP signup lock. Sent when the threshold is first crossed, then on every 10th signup (not spam).
export function alertIpSignupVelocity(ip, count, newTgId) {
  if (!ADMIN_ID || count < IP_SIGNUP_VELOCITY_THRESHOLD) return;
  if (!(count === IP_SIGNUP_VELOCITY_THRESHOLD || count % 10 === 0)) return;
  const minutes = Math.round(IP_SIGNUP_VELOCITY_WINDOW_MS / 60000);
  tgSend(ADMIN_ID,
    `🔒 <b>IP signup velocity: accounts auto-locked</b>\n\n` +
    `<b>${count}</b> new accounts from one IP in <b>${minutes} minutes</b>. New accounts are locked (no withdraw, no ad rewards) until you review them.\n\n` +
    `IP: <code>${ip}</code>\nLatest account: <code>${newTgId}</code>`,
    { reply_markup: { inline_keyboard: [[
      { text: '🔎 Review latest', callback_data: `lookup_${newTgId}` },
      { text: '🔓 Unlock latest', callback_data: `unlock_${newTgId}` },
    ]] } }
  ).catch(() => {});
}
