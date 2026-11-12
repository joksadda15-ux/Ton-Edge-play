// FILE PATH: lib/wdBurst.js
// (GitHub repo te ei path e file ta rakhbe: lib/wdBurst.js)
//
// 🌊 WITHDRAW BURST detector.
// api/withdraw.js calls `await checkWithdrawBurst(db)` right after a new withdraw request is saved.
//
// Rule: BURST_MIN (5) withdraw requests back-to-back, where every request came within
// GAP_MS (2 minutes) of the previous one = a burst.
// On a burst:  1) one alert to the admin   2) 🚩 multiAccountFlag on every account in it
//
// SAFETY: this function NEVER throws (a failure here must not break a user's withdraw request),
// and the same burst is alerted only once (dedupe in the `adminAlerts` collection).
import crypto from 'crypto';
import { tgSend } from './tg.js';

export const CFG = {
  BURST_MIN: 5,              // how many requests in one chain make a burst
  GAP_MS: 2 * 60 * 1000,     // each request must be within 2 min of the previous one
  LOOKBACK_MS: 30 * 60 * 1000, // only the last 30 min of requests are looked at
  SCAN_LIMIT: 200,
  ALERT_TTL_DAYS: 7,         // dedupe records are removed after this
};

const hx = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DHAKA_MS = 6 * 60 * 60 * 1000;
const dhakaHms = (ms) => new Date(ms + DHAKA_MS).toISOString().slice(11, 19);

let alertIndexReady = false;

export async function checkWithdrawBurst(db) {
  try {
    const since = new Date(Date.now() - CFG.LOOKBACK_MS);
    const rows = await db.collection('withdrawals')
      .find({ createdAt: { $gte: since } }, { projection: { telegramId: 1, createdAt: 1, egAmount: 1, address: 1 } })
      .sort({ createdAt: -1 })
      .limit(CFG.SCAN_LIMIT)
      .toArray();
    if (rows.length < CFG.BURST_MIN) return null;

    // newest → oldest: walk back while each gap is within GAP_MS
    const chain = [rows[0]];
    for (let i = 1; i < rows.length; i++) {
      const gap = new Date(chain[chain.length - 1].createdAt).getTime() - new Date(rows[i].createdAt).getTime();
      if (gap > CFG.GAP_MS) break;
      chain.push(rows[i]);
    }
    if (chain.length < CFG.BURST_MIN) return null;

    // the burst is identified by the OLDEST request in the chain, so it is alerted only once while it grows
    const oldest = chain[chain.length - 1];
    const burstKey = crypto.createHash('sha1').update(String(oldest._id)).digest('hex').slice(0, 16);

    const alerts = db.collection('adminAlerts');
    if (!alertIndexReady) {
      alertIndexReady = true;
      alerts.createIndex({ createdAt: 1 }, { expireAfterSeconds: CFG.ALERT_TTL_DAYS * 86400 }).catch(() => {});
    }
    const first = await alerts.updateOne(
      { _id: `wdburst_${burstKey}` },
      { $setOnInsert: { createdAt: new Date(), kind: 'withdraw_burst' } },
      { upsert: true }
    );
    const isNew = first.upsertedCount > 0;

    const ids = [...new Set(chain.map((r) => String(r.telegramId)))];
    // 🚩 flag everyone in the burst (every time the chain grows, so late joiners are flagged too)
    await db.collection('users').updateMany(
      { telegramId: { $in: ids }, multiAccountFlag: { $ne: true } },
      { $set: { multiAccountFlag: true, wdBurstFlag: true, wdBurstFlaggedAt: new Date() } }
    );

    if (!isNew) return { burst: true, size: chain.length, alerted: false };

    const adminId = process.env.ADMIN_ID;
    if (adminId) {
      const newest = new Date(chain[0].createdAt).getTime();
      const oldestT = new Date(oldest.createdAt).getTime();
      const addrs = new Set(chain.map((r) => r.address).filter(Boolean));
      const total = chain.reduce((s, r) => s + (r.egAmount || 0), 0);
      await tgSend(adminId,
        `🌊 <b>Withdraw Burst</b>\n\n` +
        `<b>${chain.length}</b> withdraw requests back-to-back (each within ${Math.round(CFG.GAP_MS / 60000)} min of the previous one)\n` +
        `🕒 ${dhakaHms(oldestT)} → ${dhakaHms(newest)} (BD time)\n` +
        `👥 ${ids.length} account(s) · 📍 ${addrs.size} different wallet(s)\n` +
        `💰 Total: <b>${total.toLocaleString()} MM$</b>\n\n` +
        `🚩 These accounts were flagged.\n` +
        ids.slice(0, 10).map((x) => `• <code>${hx(x)}</code>`).join('\n') +
        (ids.length > 10 ? `\n… and ${ids.length - 10} more` : '')
      ).catch(() => {});
    }
    return { burst: true, size: chain.length, alerted: true };
  } catch (e) {
    console.error('checkWithdrawBurst failed:', e);
    return null;
  }
}
