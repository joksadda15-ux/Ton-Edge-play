// FILE PATH: lib/indexes.js
// All database indexes in one place, including the TTL (auto-delete) ones. Ported from NEWTUBE's setup-indexes.
// Runs by itself in the background the first time the server connects (see lib/mongodb.js).
// createIndex is safe to run again and again: if the index already exists, MongoDB does nothing.
//
// TTL = MongoDB deletes the document by itself after the time. Keeps the free database small.
const DAY = 86400;
const MIN_WITHDRAW_EG = 2500; // same as api/withdraw.js

export async function ensureAllIndexes(db) {
  const c = (name) => db.collection(name);
  const steps = [
    // ── users ──
    ['users.telegramId (unique)',        () => c('users').createIndex({ telegramId: 1 }, { unique: true })],
    ['users.referCode',                  () => c('users').createIndex({ referCode: 1 })],
    ['users.createdAt',                  () => c('users').createIndex({ createdAt: -1 })],
    // referral list (Invite tab): find by referrer, newest first, page by page. Without this index every open scans ALL users.
    ['users.referredBy+createdAt',       () => c('users').createIndex({ referredBy: 1, createdAt: -1, _id: -1 })],
    ['users.accountLocked (partial)',    () => c('users').createIndex({ accountLocked: 1 }, { partialFilterExpression: { accountLocked: true } })],
    ['users.multiAccountFlag (partial)', () => c('users').createIndex({ multiAccountFlag: 1 }, { partialFilterExpression: { multiAccountFlag: true } })],
    // banned users are deleted 60 days after the ban (the permanent bannedTelegramIds list keeps them from re-joining)
    ['users.bannedAt (TTL 60d, banned only)', () => c('users').createIndex({ bannedAt: 1 }, { expireAfterSeconds: 60 * DAY, partialFilterExpression: { isBanned: true } })],
    // dead accounts: 90 days without opening the app → deleted. Only accounts that could not withdraw anyway (balance under the minimum).
    ['users.lastActive (TTL 90d, balance < min withdraw)', () => c('users').createIndex({ lastActive: 1 }, { expireAfterSeconds: 90 * DAY, partialFilterExpression: { egBalance: { $lt: MIN_WITHDRAW_EG } } })],

    // ── withdrawals ──
    ['withdrawals.telegramId+createdAt', () => c('withdrawals').createIndex({ telegramId: 1, createdAt: -1 })],
    ['withdrawals.address',              () => c('withdrawals').createIndex({ address: 1 })],
    ['withdrawals.status+createdAt',     () => c('withdrawals').createIndex({ status: 1, createdAt: 1 })],
    ['withdrawals.processedAt (TTL 90d, rejected only)', () => c('withdrawals').createIndex({ processedAt: 1 }, { expireAfterSeconds: 90 * DAY, partialFilterExpression: { status: 'rejected' } })],

    // ── security data ──
    ['fingerprints.lastSeenAt (TTL 180d)', () => c('fingerprints').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 180 * DAY })],
    ['ipRegistry.lastSeenAt (TTL 120d)',   () => c('ipRegistry').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 120 * DAY })],
    ['ipSignupVelocity.updatedAt (TTL 1d)', () => c('ipSignupVelocity').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 1 * DAY })],

    // Adsgram S2S credits (api/ads.js + api/farm.js look up by user+network+unused): without this every ad claim scanned the collection
    ['adsgramS2S.telegramId+network+used+at', () => c('adsgramS2S').createIndex({ telegramId: 1, network: 1, used: 1, at: 1 })],

    // ── promos / tasks / payments ──
    ['promos.code (unique)',             () => c('promos').createIndex({ code: 1 }, { unique: true })],
    ['promos.expiresAt (TTL)',           () => c('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })],
    ['tasks.id',                         () => c('tasks').createIndex({ id: 1 })],
    ['tasks.active+_id (task list pages)', () => c('tasks').createIndex({ active: 1, _id: -1 })],
    ['tasks.active+category+_id (task tabs)', () => c('tasks').createIndex({ active: 1, category: 1, _id: -1 })],
    ['tasks.completedAt (TTL 5d, user-created only)', () => c('tasks').createIndex({ completedAt: 1 }, { expireAfterSeconds: 5 * DAY, partialFilterExpression: { isUserCreated: true } })],
    ['tasks.createdBy+isUserCreated+createdAt', () => c('tasks').createIndex({ createdBy: 1, isUserCreated: 1, createdAt: -1 })],
    ['tasks.reviewStatus+createdAt',     () => c('tasks').createIndex({ reviewStatus: 1, createdAt: 1 })],
    ['taskCreateOrders.memo',            () => c('taskCreateOrders').createIndex({ memo: 1 })],
    ['taskCreateOrders.userId+status',   () => c('taskCreateOrders').createIndex({ userId: 1, status: 1 })],
    // expired orders can still be paid late for 7 days (api/payments.js), so they are deleted only after 30 days
    ['taskCreateOrders.expiredAt (TTL 30d, expired only)', () => c('taskCreateOrders').createIndex({ expiredAt: 1 }, { expireAfterSeconds: 30 * DAY, partialFilterExpression: { status: 'expired' } })],
  ];

  const results = [];
  for (const [name, fn] of steps) {
    try { await fn(); results.push({ index: name, ok: true }); }
    catch (e) { results.push({ index: name, ok: false, error: e.message }); }
  }
  // old ipSignupVelocity rows have no updatedAt, so the TTL above would never delete them: remove them once (they only hold 3-minute counters)
  try { await c('ipSignupVelocity').deleteMany({ updatedAt: { $exists: false } }); } catch (e) { /* not important */ }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.error('ensureAllIndexes: some indexes failed:', failed);
  return results;
                                                                              }
