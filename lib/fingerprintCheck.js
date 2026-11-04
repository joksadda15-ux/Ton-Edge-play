// FILE PATH: lib/fingerprintCheck.js
// (GitHub repo te ei path e file ta rakhbe: lib/fingerprintCheck.js)
// Multi-account guard (ported from NEWTUBE, now AUTO-LOCKING):
// same device fingerprint seen on more than one account -> the ORIGINAL account (the oldest one, by createdAt)
// stays untouched, every other account on that device is locked automatically (accountLockedReason: 'multi_account').
// A locked account can not withdraw, claim farm/daily/ad/task rewards, and never pays its referrer (see accountLocked checks).
// Admin can still unlock a wrongly locked account from the user lookup (🔓 Unlock Account).
// Accounts the admin unlocked / cleared (multiAccountCleared) are never auto-locked again.
// Accounts that used the official "Switch account" (ipSwitchCount > 0) are not locked: that flow already wipes their balance.

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
