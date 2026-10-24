// FILE PATH: lib/fingerprintCheck.js
// (GitHub repo te ei path e file ta rakhbe: lib/fingerprintCheck.js)
// Soft multi-account flag (ported from NEWTUBE): same device fingerprint seen on another account
// -> mark multiAccountFlag for admin review. Never bans by itself.
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
    return { flagged: true, siblings };
  }
  return { flagged: false };
}
