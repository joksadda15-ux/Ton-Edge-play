// FILE PATH: lib/botGuard.js
// (GitHub repo te ei path e file ta rakhbe: lib/botGuard.js)
// Anti-script guard for ad claims (ported from NEWTUBE lib/botGuard.js).
// samples = [{ s: adStartMs, c: claimMs, w: tap->claim seconds, v: on-screen seconds }]
import { tgSend } from './tg.js';

const SAMPLE = 5, MAX_IDLE = 1.5, METRO_SAMPLES = 8, CYCLE_SPREAD = 1, CYCLE_MAX = 40, WATCH_SPREAD = 0.3, GAP_SPREAD = 0.3, GAP_MAX = 20;
export const AD_CLAIM_HISTORY_KEEP = 8;
const REVIEW_THROTTLE_MS = 24 * 3600 * 1000;

export function detectBotPattern(samples) {
  const n = samples.length;
  if (n >= SAMPLE) {
    const last = samples.slice(-SAMPLE);
    if (last.every((x, i) => i === 0 || (x.s - last[i - 1].c) / 1000 <= MAX_IDLE))
      return { rule: 'A', detail: `${SAMPLE} ads in a row, each started ≤${MAX_IDLE}s after the previous claim` };
    const ws = last.map(x => x.w);
    if (Math.max(...ws) - Math.min(...ws) <= WATCH_SPREAD)
      return { rule: 'C', detail: `${SAMPLE} ads with near-identical watch time (${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}s)` };
    const gaps = last.slice(1).map((x, i) => (x.s - last[i].c) / 1000);
    if (Math.max(...gaps) <= GAP_MAX && Math.max(...gaps) - Math.min(...gaps) <= GAP_SPREAD)
      return { rule: 'E', detail: `${SAMPLE} ads with metronome-like pauses (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}s)` };
  }
  if (n >= METRO_SAMPLES) {
    const last = samples.slice(-METRO_SAMPLES);
    const cycles = last.slice(1).map((x, i) => (x.c - last[i].c) / 1000);
    if (Math.max(...cycles) <= CYCLE_MAX && Math.max(...cycles) - Math.min(...cycles) <= CYCLE_SPREAD)
      return { rule: 'B', detail: `${METRO_SAMPLES} ads with a metronome-like cycle (${Math.min(...cycles).toFixed(1)}–${Math.max(...cycles).toFixed(1)}s apart)` };
  }
  return null;
}

// Returns true if the account is now locked (caller must reject the claim).
export async function lockForBotPattern(db, tgId, hit, extra = '', samples = []) {
  const users = db.collection('users');
  const adminId = process.env.ADMIN_ID;
  const u = await users.findOne({ telegramId: tgId });
  if (!u) return false;
  if (u.accountLocked || u.isBanned) return true;
  await users.updateOne({ telegramId: tgId }, { $inc: { botSuspectCount: 1 }, $set: { botSuspectAt: new Date() } }).catch(() => {});

  const ageDays = u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : 0;
  const wCount = u.withdrawalCount || 0;
  let script = 0, real = 0;
  if (hit.rule === 'A') script += 3;
  if (ageDays < 2) script += 1;
  if (wCount === 0 && (u.totalAdsWatched || 0) > 80 && ageDays < 3) script += 1;
  if (ageDays >= 7) real += 1;
  if (wCount > 0) real += 1;
  if ((u.totalReferred || 0) > 0) real += 1;
  if (hit.rule === 'B') real += 1;
  const likelyScript = script >= 3 && script > real;
  const hint = likelyScript ? '🔴 Likely script' : (real >= 3 && real > script ? '🟢 Likely real user' : '🟡 Unclear — check profile');
  const evidence = `\n<b>Evidence</b>\nName: ${u.firstName || '—'} (@${u.username || 'none'})\nAge: ${ageDays}d · Balance: ${u.egBalance || 0} MM$\nWithdrawals: ${wCount} · Referred: ${u.totalReferred || 0} · Ads lifetime: ${u.totalAdsWatched || 0}\nMulti-account flag: ${u.multiAccountFlag ? 'YES 🚩' : 'No'}\nHint: <b>${hint}</b> (script ${script} / real ${real})\n`;

  if (likelyScript) {
    const r = await users.findOneAndUpdate(
      { telegramId: tgId, accountLocked: { $ne: true } },
      { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'bot_pattern' } }
    );
    if (r && adminId) {
      tgSend(adminId, `🤖 <b>Bot / script pattern detected (ads)</b>\n\nUser: <code>${tgId}</code>\nRule ${hit.rule}: ${hit.detail}\n${extra}\n${evidence}\nThe account is now 🔒 locked (no withdraw, no ad rewards).`,
        { reply_markup: { inline_keyboard: [[{ text: '🔓 Unlock', callback_data: `unlock_${tgId}` }, { text: '🚫 Ban User', callback_data: `ban_${tgId}` }]] } }).catch(() => {});
    }
    return !!r;
  }
  const mark = await users.updateOne(
    { telegramId: tgId, $or: [{ botReviewAt: { $exists: false } }, { botReviewAt: { $lt: new Date(Date.now() - REVIEW_THROTTLE_MS) } }] },
    { $set: { botReviewAt: new Date() } }
  );
  if (mark.modifiedCount > 0 && adminId) {
    tgSend(adminId, `⚠️ <b>Suspicious ad pattern — NOT locked</b>\n\nUser: <code>${tgId}</code>\nRule ${hit.rule}: ${hit.detail}\n${extra}\n${evidence}\nNothing was blocked.`,
      { reply_markup: { inline_keyboard: [[{ text: '🔒 Lock', callback_data: `lock_${tgId}` }, { text: '🚫 Ban User', callback_data: `ban_${tgId}` }]] } }).catch(() => {});
  }
  return false;
}
