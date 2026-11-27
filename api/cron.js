// FILE PATH: api/cron.js
// (GitHub repo te ei path e file ta rakhbe: api/cron.js)
// "Open the mini app" notification, sent every 12 hours.  Called TWICE a day by cron-job.org (e.g. 09:00 and 21:00 Bangladesh time):
//   GET https://178-83-121-23.sslip.io/api/cron?job=dailyNotify&secret=CRON_SECRET
// - answers the cron instantly, then sends in the background (so cron-job.org's 30s timeout is never a problem)
// - max 1 message per user per 12-hour slot (lastNotifiedDay holds the slot key), safe to call twice
// - skips banned users, users who blocked the bot, and users who were active in the last 2 hours
import { getDb } from '../lib/mongodb.js';
import { ensureAllIndexes } from '../lib/indexes.js';
import { isCronAuthorized } from '../lib/cronAuth.js';
import { tgSend } from '../lib/tg.js';
import { bdTodayKey } from '../lib/dateUtils.js';

// 12-hour slot key in Bangladesh time: "2026-11-27-A" = 00:00-11:59, "2026-11-27-B" = 12:00-23:59
const bdSlotKey = () => `${bdTodayKey()}-${new Date(Date.now() + 6 * 3600000).getUTCHours() < 12 ? 'A' : 'B'}`;

// ===== EDIT HERE =====
const APP_URL = 'https://ton-edge-play.vercel.app';
const SKIP_IF_ACTIVE_WITHIN_HOURS = 2;
const MESSAGES = [   // one is picked every 12 hours (rotates), so users don't see the same text every time
  '🌾 <b>Your farm is waiting!</b>\n\nClaim your farm rewards, collect your login bonus and earn MM$.',
  '🎁 <b>Daily reward is ready!</b>\n\nOpen Gram Edge Farm, collect your login bonus and claim your farms.',
  '🥕 <b>Your farms may be ready to claim!</b>\n\nCome back, claim and earn MM$ before you forget.',
  '💰 <b>Earn MM$ today!</b>\n\nComplete tasks and claim your farms. Every day counts!',
];
// =====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  if (!isCronAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.query?.job === 'setupIndexes') return res.status(200).json({ ok: true, results: await ensureAllIndexes(await getDb()) }); // open in a browser to see which indexes are OK
  if (req.query?.job !== 'dailyNotify') return res.status(400).json({ ok: false, error: 'unknown_job' });

  const db = await getDb();
  const today = bdSlotKey();   // name kept: it is now the 12-hour slot key
  const settings = db.collection('botSettings');
  await settings.updateOne({ _id: 'dailyNotify' }, { $setOnInsert: { day: null, status: 'idle' } }, { upsert: true });

  // one run per 12-hour slot (a crashed run — "running" for 30+ min — may be restarted; per-user flags prevent double sends)
  const claimed = await settings.findOneAndUpdate(
    { _id: 'dailyNotify', $or: [{ day: { $ne: today } }, { status: 'running', startedAt: { $lt: new Date(Date.now() - 30 * 60000) } }] },
    { $set: { day: today, status: 'running', startedAt: new Date(), sent: 0, failed: 0 } },
    { returnDocument: 'after' }
  );
  if (!(claimed?.value !== undefined ? claimed.value : claimed)) return res.status(200).json({ ok: true, skipped: 'already_started_this_slot' });

  res.status(200).json({ ok: true, started: true });          // answer the cron right away …
  runNotify(db, today).catch(e => console.error('dailyNotify failed:', e)); // … and keep working in the background
}

async function runNotify(db, today) {
  const users = db.collection('users');
  const settings = db.collection('botSettings');
  const text = MESSAGES[Math.floor(Date.now() / 43200000) % MESSAGES.length];
  const markup = { inline_keyboard: [[{ text: '🌾 Open Gram Edge Farm', web_app: { url: APP_URL } }]] };
  const cutoff = new Date(Date.now() - SKIP_IF_ACTIVE_WITHIN_HOURS * 3600000);
  const query = {
    isBanned: { $ne: true }, botBlocked: { $ne: true }, lastNotifiedDay: { $ne: today },
    $or: [{ lastActive: { $exists: false } }, { lastActive: { $lt: cutoff } }],
  };
  let sent = 0, failed = 0;
  for (;;) {
    const batch = await users.find(query, { projection: { telegramId: 1 } }).limit(200).toArray();
    if (!batch.length) break;
    for (const u of batch) {
      let r = await tgSend(u.telegramId, text, { reply_markup: markup }).catch(() => ({ ok: false }));
      if (!r.ok && r.error_code === 429) { await sleep(((r.parameters?.retry_after || 3) + 1) * 1000); r = await tgSend(u.telegramId, text, { reply_markup: markup }).catch(() => ({ ok: false })); }
      const set = { lastNotifiedDay: today };           // mark everyone we tried, so the loop always moves forward
      if (r.ok) sent++; else { failed++; if (r.error_code === 403) set.botBlocked = true; }
      await users.updateOne({ telegramId: u.telegramId }, { $set: set });
      await sleep(50);                                  // ≈20 messages/second (Telegram limit is ~30)
    }
  }
  await settings.updateOne({ _id: 'dailyNotify' }, { $set: { status: 'done', finishedAt: new Date(), sent, failed } });
  if (process.env.ADMIN_ID) tgSend(process.env.ADMIN_ID, `🔔 <b>Notification done (12h)</b>\n\n✅ Sent: <b>${sent}</b>\n❌ Failed: <b>${failed}</b>`).catch(() => {});
}
