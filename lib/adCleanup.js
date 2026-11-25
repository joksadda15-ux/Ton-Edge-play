// FILE PATH: lib/adCleanup.js
// 🧹 15-DAY CLEAN SYSTEM for ads data.
//
// Where ads data lives:
//   1) users.adTasks.<YYYY-MM-DD>.<network> = how many ads a user watched that day (needed only for "today")
//   2) adsgramS2S credits  → real MongoDB TTL index, auto-deleted after 1 day (see api/ads.js + lib/indexes.js)
//   3) users.recentAdClaims / adsgramClaimTimes / farmClaimTimes → capped arrays ($slice), cannot grow
//
// (1) is a key INSIDE the user document, and a MongoDB TTL index can only delete WHOLE documents. So this job does the same
// thing in two safe steps, once a day (called from api/cron.js → job=maintenance):
//   A) ARCHIVE: add up the days that are about to expire into adStatsDaily  (1 tiny row per day+network, kept 400 days)
//   B) PRUNE:   remove adTasks day-keys older than AD_KEEP_DAYS (15) from every user
// If A fails, B does NOT run (nothing is deleted before it is archived). Safe to run twice.
import { bdTodayKey } from './dateUtils.js';

export const AD_KEEP_DAYS = 15;      // the daily job keeps this many days
export const AD_SAFETY_DAYS = 20;    // api/ads.js + api/farm.js prune at 20 days as a fallback if the daily job is not set up yet
const DAY_MS = 86400000;

export const adCutoffKey = (days = AD_KEEP_DAYS) => bdTodayKey(new Date(Date.now() - days * DAY_MS)); // keys < this are expired

export async function archiveAndPruneAds(db, days = AD_KEEP_DAYS) {
  const users = db.collection('users');
  const stats = db.collection('adStatsDaily');
  const cutoff = adCutoffKey(days);
  const hasStale = { $expr: { $gt: [{ $size: { $filter: { input: { $objectToArray: { $ifNull: ['$adTasks', {}] } }, cond: { $lt: ['$$this.k', cutoff] } } } }, 0] } };

  // A) ARCHIVE the expiring days (one row per day+network: how many ads, how many users)
  const rows = await users.aggregate([
    { $match: { adTasks: { $type: 'object' } } },
    { $project: { _id: 0, d: { $filter: { input: { $objectToArray: '$adTasks' }, cond: { $lt: ['$$this.k', cutoff] } } } } },
    { $unwind: '$d' },
    { $project: { day: '$d.k', nets: { $objectToArray: { $ifNull: ['$d.v', {}] } } } },
    { $unwind: '$nets' },
    { $group: { _id: { day: '$day', network: '$nets.k' }, ads: { $sum: '$nets.v' }, users: { $sum: 1 } } },
  ], { allowDiskUse: true }).toArray();

  if (rows.length) {
    await stats.bulkWrite(rows.map((r) => ({
      updateOne: {
        filter: { _id: `${r._id.day}|${r._id.network}` },
        // $max: running this twice (or after some users were already pruned) can never make an archived number smaller
        update: { $max: { ads: r.ads, users: r.users }, $set: { day: r._id.day, network: r._id.network, archivedAt: new Date() } },
        upsert: true,
      },
    })), { ordered: false });
  }

  // B) PRUNE: one pipeline update, only users that really have an old key (everyone else is not touched)
  const r = await users.updateMany(
    { adTasks: { $type: 'object' }, ...hasStale },
    [{ $set: { adTasks: { $arrayToObject: { $filter: { input: { $objectToArray: '$adTasks' }, cond: { $gte: ['$$this.k', cutoff] } } } } } }]
  );
  return { cutoff, archivedRows: rows.length, usersCleaned: r.modifiedCount };
}
