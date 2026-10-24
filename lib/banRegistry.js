// FILE PATH: lib/banRegistry.js
// (GitHub repo te ei path e file ta rakhbe: lib/banRegistry.js)
// Permanent ban list (ported from NEWTUBE). A tiny `bannedTelegramIds` collection that is
// checked before a NEW account is created, so a banned Telegram ID can never re-register.
export async function markBanned(db, ids) {
  const list = ids.filter(Boolean).map(String);
  if (!list.length) return;
  const now = new Date();
  await db.collection('bannedTelegramIds').bulkWrite(
    list.map(id => ({ updateOne: { filter: { _id: id }, update: { $set: { bannedAt: now } }, upsert: true } }))
  );
}
export async function markUnbanned(db, ids) {
  const list = ids.filter(Boolean).map(String);
  if (!list.length) return;
  await db.collection('bannedTelegramIds').deleteMany({ _id: { $in: list } });
}
export async function isRegistryBanned(db, id) {
  return !!(await db.collection('bannedTelegramIds').findOne({ _id: String(id) }));
}
