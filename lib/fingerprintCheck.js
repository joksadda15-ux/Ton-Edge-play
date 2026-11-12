// FILE PATH: lib/fingerprintCheck.js
// (GitHub repo te ei path e file ta rakhbe: lib/fingerprintCheck.js)
// Multi-account guard (ported from NEWTUBE, now AUTO-LOCKING):
// same device fingerprint seen on more than one account -> the ORIGINAL account (the oldest one, by createdAt)
// stays untouched, every other account on that device is locked automatically (accountLockedReason: 'multi_account').
// A locked account can not withdraw, claim farm/daily/ad/task rewards, and never pays its referrer (see accountLocked checks).
// Admin can still unlock a wrongly locked account from the user lookup (🔓 Unlock Account).
// Accounts the admin unlocked / cleared (multiAccountCleared) are never auto-locked again.
// Accounts that used the official "Switch account" (ipSwitchCount > 0) are not locked: that flow already wipes their balance.

import { tgSend } from './tg.js';

const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// What happens to a COPY account (everything is reversible by the admin: 🔓 Unlock gives the balance back):
//   1. pending withdrawals are rejected (no payout)
//   2. the balance is set to 0 and kept in multiAccountBalanceBackup (restored if the admin unlocks the account)
//   3. if the copy was invited by the original / another account of the same device (self-referral), the referral bonus is taken back
//   4. the copy gets a Telegram message that only the original account stays active
async function punishCopy(db, id, ids) {
  const users = db.collection('users'), wds = db.collection('withdrawals');
  let rejected = 0, pendingMm = 0;
  const pend = await wds.find({ telegramId: id, status: 'pending', payoutStatus: { $ne: 'sending' } }).toArray();
  for (const w of pend) {
    const c = await wds.updateOne({ _id: w._id, status: 'pending', payoutStatus: { $ne: 'sending' } }, { $set: { status: 'rejected', processedAt: new Date(), rejectReason: 'multi_account' } });
    if (c.modifiedCount) { rejected++; pendingMm += w.egAmount || 0; }
  }
  const r = await users.findOneAndUpdate({ telegramId: id }, [{ $set: {
    multiAccountBalanceBackup: { $add: [{ $ifNull: ['$multiAccountBalanceBackup', 0] }, { $ifNull: ['$egBalance', 0] }, pendingMm] },
    egBalance: 0, withdrawPending: false, multiAccountPunishedAt: new Date(),
  } }], { returnDocument: 'before' });
  const before = r?.value !== undefined ? r.value : r;
  const zeroed = (before?.egBalance || 0) + pendingMm;
  let clawed = 0;
  if (before?.referredBy && ids.includes(String(before.referredBy)) && (before.refBonusGenerated || 0) > 0) {
    const ref = await users.findOne({ telegramId: String(before.referredBy) }, { projection: { egBalance: 1 } });
    const take = Math.min(before.refBonusGenerated, ref?.egBalance || 0);
    if (take > 0) { const c = await users.updateOne({ telegramId: String(before.referredBy), egBalance: { $gte: take } }, { $inc: { egBalance: -take } }); if (c.modifiedCount) clawed = take; }
  }
  tgSend(id, '🚫 <b>Account suspended</b>\n\nWe found more than one account on your device. Only your first (original) account stays active. This account can not withdraw or earn.\n\nIf this is a mistake (for example a shared family phone), contact support.').catch(() => {});
  return { id, zeroed, rejected, clawed, username: before?.username || '' };
}

export async function lockDuplicateAccounts(db, ids, fingerprint) {
  const users = db.collection('users');
  const docs = await users.find(
    { telegramId: { $in: ids } },
    { projection: { telegramId: 1, createdAt: 1, ipSwitchCount: 1, accountLocked: 1, accountLockedReason: 1, isBanned: 1, multiAccountCleared: 1 } }
  ).toArray();
  if (docs.length < 2) return { original: docs[0]?.telegramId || null, locked: [] };
  const t = (u) => (u.createdAt ? new Date(u.createdAt).getTime() : Number.MAX_SAFE_INTEGER);
  // the original = oldest account; tie -> smaller Telegram ID
  docs.sort((a, b) => t(a) - t(b) || (BigInt(a.telegramId) < BigInt(b.telegramId) ? -1 : 1));
  const original = docs[0].telegramId;
  const toLock = docs.slice(1).filter(u => !u.accountLocked && !u.isBanned && !(u.ipSwitchCount > 0) && !u.multiAccountCleared).map(u => u.telegramId);
  if (toLock.length) {
    await users.updateMany(
      { telegramId: { $in: toLock }, accountLocked: { $ne: true } },
      { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'multi_account', multiAccountOriginal: original, multiAccountFingerprint: fingerprint, multiAccountFlag: true } }
    );
    // extra actions against the copies + one summary for the admin
    const done = [];
    for (const id of toLock) { try { done.push(await punishCopy(db, id, ids.map(String))); } catch (e) { console.error('punishCopy failed:', e.message); } }
    if (process.env.ADMIN_ID && done.length) {
      tgSend(process.env.ADMIN_ID,
        `🕵️ <b>MULTI-ACCOUNT: ${done.length} copy account(s) suspended</b>\n\n` +
        `✅ Original (stays active): <code>${esc(original)}</code>\n\n` +
        done.map((d) => `🚫 <code>${esc(d.id)}</code>${d.username ? ' @' + esc(d.username) : ''}: balance zeroed <b>${Math.round(d.zeroed).toLocaleString()} MM$</b>${d.rejected ? ` · ${d.rejected} withdrawal(s) rejected` : ''}${d.clawed ? ` · ${d.clawed} MM$ referral bonus taken back` : ''}`).join('\n') +
        `\n\n<i>Same device fingerprint on all of them. Wrong (shared family phone)? Tap Unlock: the balance is given back.</i>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '👤 Original', callback_data: `lookup_${original}` }],
          ...done.slice(0, 4).map((d) => [{ text: `🔓 Unlock + restore ${d.id}`, callback_data: `unlock_${d.id}` }, { text: '🚨 Scam+Ban', callback_data: `scam_${d.id}` }]),
        ] } }
      ).catch(() => {});
    }
  }
  // the original keeps working, but remember it has copies (shown in admin user lookup)
  await users.updateOne({ telegramId: original }, { $set: { multiAccountFlag: true, multiAccountSiblings: docs.slice(1).map(u => u.telegramId), multiAccountFingerprint: fingerprint } });
  return { original, locked: toLock };
}

export async function checkAndRecordFingerprint(db, tgId, fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'string' || fingerprint.length < 16) return { flagged: false };
  const col = db.collection('fingerprints');
  let doc;
  const run = () => col.findOneAndUpdate(
    { _id: fingerprint },
    { $addToSet: { userIds: tgId }, $set: { lastSeenAt: new Date() }, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true, returnDocument: 'before' }
  );
  try { doc = await run(); } catch (e) { if (e?.code === 11000) doc = await run(); else throw e; }
  const d = doc?.value !== undefined ? doc.value : doc;
  const siblings = (d?.userIds || []).filter(id => id !== tgId);
  if (siblings.length) {
    await db.collection('users').updateOne(
      { telegramId: tgId },
      { $set: { multiAccountFlag: true, multiAccountSiblings: siblings, multiAccountFingerprint: fingerprint } }
    );
    const r = await lockDuplicateAccounts(db, [tgId, ...siblings], fingerprint);
    return { flagged: true, siblings, original: r.original, locked: r.locked };
  }
  return { flagged: false };
       }
