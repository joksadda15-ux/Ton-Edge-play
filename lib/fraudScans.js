// FILE PATH: lib/fraudScans.js
// Two more admin scanners in the same style as "Signup Bursts" (alert + buttons, nothing is blocked automatically):
//   💳 Shared Wallets  - one withdrawal wallet used by 2+ different accounts (the classic multi-account cash-out)
//   🧬 Referral Rings  - a referrer whose recent friends are mostly "dead" (never did anything) or share one signup IP
// The Lock / Ban / Members / Unlock buttons are the SAME ones as Signup Bursts (sb_* in lib/signupBursts.js) because
// every result is saved as a "cluster" of account IDs. Admin only; each scan = 1 aggregation, so it costs nothing until you tap it.
import { saveCluster } from './signupBursts.js';

const hx = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const FS = { WALLET_DAYS: 30, RING_DAYS: 7, RING_MIN: 5, SHOW: 6 };

// "alive" = did anything at all in the app (ads, tasks, farm claims, login bonus)
const ALIVE = { $or: [
  { $gt: [{ $ifNull: ['$totalAdsWatched', 0] }, 0] },
  { $gt: [{ $ifNull: ['$farmClaims', 0] }, 0] },
  { $gt: [{ $ifNull: ['$tasksDoneTotal', 0] }, 0] },
  { $gt: [{ $size: { $ifNull: ['$completedTasks', []] } }, 0] },
  { $ne: [{ $ifNull: ['$loginBonus.lastDay', null] }, null] },
] };

// ── 💳 Shared wallets ─────────────────────────────────────────
export async function scanSharedWallets(db, days = FS.WALLET_DAYS) {
  const since = new Date(Date.now() - days * 86400000);
  return db.collection('withdrawals').aggregate([
    { $match: { createdAt: { $gte: since }, status: { $in: ['pending', 'approved'] } } },
    { $group: { _id: '$address', ids: { $addToSet: '$telegramId' }, n: { $sum: 1 }, usd: { $sum: '$usdtAmount' } } },
    { $match: { 'ids.1': { $exists: true } } },       // 2 or more DIFFERENT accounts
    { $sort: { n: -1 } },
    { $limit: FS.SHOW },
  ]).toArray();
}

// ── 🧬 Referral rings ─────────────────────────────────────────
export async function scanReferralRings(db, days = FS.RING_DAYS) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await db.collection('users').aggregate([
    { $match: { createdAt: { $gte: since }, referredBy: { $nin: [null, ''] } } },
    { $group: { _id: '$referredBy', n: { $sum: 1 }, dead: { $sum: { $cond: [ALIVE, 0, 1] } }, ips: { $push: '$signupIp' }, ids: { $push: '$telegramId' } } },
    { $match: { n: { $gte: FS.RING_MIN } } },
  ]).toArray();
  const out = [];
  for (const r of rows) {
    const cnt = new Map();
    for (const ip of r.ips) if (ip) cnt.set(ip, (cnt.get(ip) || 0) + 1);
    let topIp = null, ipN = 0;
    for (const [ip, c] of cnt) if (c > ipN) { topIp = ip; ipN = c; }
    const deadPct = r.dead / r.n, ipPct = ipN / r.n;
    if (deadPct < 0.5 && ipPct < 0.4) continue;              // looks healthy: do not bother the admin
    out.push({ referrer: String(r._id), n: r.n, dead: r.dead, topIp, ipN, ids: r.ids.map(String).slice(0, 1500),
      verdict: deadPct >= 0.8 || ipPct >= 0.6 ? '🔴 Looks like a referral farm' : '🟡 Suspicious: check the members first' });
  }
  out.sort((a, b) => b.n - a.n);
  return out.slice(0, FS.SHOW);
}

// ── screens ──────────────────────────────────────────────────
const clusterKb = (cid, n) => ({ inline_keyboard: [
  [{ text: '👁 Members (IDs + data)', callback_data: `sb_view_${cid}` }],
  [{ text: `🔒 Lock all ${n}`, callback_data: `sb_lock_${cid}` }, { text: `🚫 Ban all ${n}`, callback_data: `sb_banask_${cid}` }],
  [{ text: '✅ Real users — unlock', callback_data: `sb_clear_${cid}` }],
] });

// ctx: { db, chatId, msgId, send, edit, backKb }  → true = handled
export async function handleFraudCallback(data, ctx) {
  const { db, chatId, msgId, send, edit, backKb } = ctx;
  const menu = { inline_keyboard: [
    [{ text: '💳 Shared Wallets', callback_data: 'fs_wallet' }, { text: '🧬 Referral Rings', callback_data: 'fs_ring' }],
    [{ text: '🆕 Signup Bursts', callback_data: 'a_signups' }],
    [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
  ] };
  if (data === 'a_fraud') {
    await edit(chatId, msgId, '🕵️ <b>Fraud Scans</b>\n\n💳 <b>Shared Wallets</b>: one wallet cashing out for several accounts.\n🧬 <b>Referral Rings</b>: a referrer whose friends are fake or from one IP.\n🆕 <b>Signup Bursts</b>: many accounts created at once.\n\n<i>Nothing is blocked automatically. You decide with the buttons.</i>', { reply_markup: menu });
    return true;
  }
  if (data === 'fs_wallet') {
    await edit(chatId, msgId, '💳 Scanning withdrawal wallets of the last 30 days...');
    const rows = await scanSharedWallets(db);
    await edit(chatId, msgId, `💳 <b>Shared Wallets</b> (last ${FS.WALLET_DAYS} days)\n\n${rows.length ? `Found <b>${rows.length}</b> wallet(s) used by 2+ accounts ↓` : '🟢 No wallet is used by more than one account.'}`, { reply_markup: menu });
    for (const r of rows) {
      const ids = r.ids.map(String);
      const cid = await saveCluster(db, ids, 'wallet');
      await send(chatId, `💳 <b>One wallet, ${ids.length} accounts</b>\n📍 <code>${hx(r._id)}</code>\n💸 ${r.n} withdrawals · $${(r.usd || 0).toFixed(2)} total\n👤 ${ids.map((i) => `<code>${i}</code>`).join(', ')}\n\n<b>${ids.length >= 3 ? '🔴 Very likely one person with many accounts.' : '🟡 Could be family or friends: open Members and check.'}</b>`, { reply_markup: clusterKb(cid, ids.length) });
    }
    return true;
  }
  if (data === 'fs_ring') {
    await edit(chatId, msgId, '🧬 Scanning referrals of the last 7 days...');
    const rows = await scanReferralRings(db);
    await edit(chatId, msgId, `🧬 <b>Referral Rings</b> (last ${FS.RING_DAYS} days, ${FS.RING_MIN}+ friends)\n\n${rows.length ? `Found <b>${rows.length}</b> suspicious referrer(s) ↓` : '🟢 No suspicious referrer found.'}`, { reply_markup: menu });
    for (const r of rows) {
      const cid = await saveCluster(db, [r.referrer, ...r.ids], 'ring');
      await send(chatId, `🧬 <b>Referrer</b> <code>${hx(r.referrer)}</code> · <b>${r.n}</b> friends\n💀 Never did anything: <b>${r.dead}/${r.n}</b> (${Math.round((100 * r.dead) / r.n)}%)\n🌐 Same signup IP: <b>${r.ipN}/${r.n}</b>${r.topIp ? ` (<code>${hx(r.topIp)}</code>)` : ''}\n\n<b>${r.verdict}</b>\n<i>Lock/Ban below affects the referrer AND all ${r.n} friends.</i>`, { reply_markup: clusterKb(cid, r.ids.length + 1) });
    }
    return true;
  }
  return false;
}
