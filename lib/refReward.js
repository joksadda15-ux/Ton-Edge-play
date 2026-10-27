// FILE PATH: lib/refReward.js
// NEW REFERRAL SYSTEM (replaces the old signup / first-claim / 15% rules)
//
//  1st generation (the people YOU invited) -> milestone rewards paid to you, each ONCE per friend:
//     join                      +50 MM$   (paid at signup in api/user.js)
//     10 tasks completed        +200
//     3 farm claims in one day  +200
//     10 Adsgram tasks          +250
//     5 farms unlocked          +500      (Farm 1 is free and counts)
//  2nd generation (friends of your friends) -> 5% of every APPROVED withdrawal, nothing else (paid in api/bot.js)
//
// CPU / DB safety: refCheck() works only on the user document the caller ALREADY has (the result of its own update),
// so a normal event costs 0 extra DB calls. DB is touched only when a milestone is newly reached:
// 1 write on the friend (flags) + 1 write on the referrer (MM$). Once all 5 are done, refProg.done stops every check.

export const REF = { join: 50, tasks: 200, farm3: 200, ads: 250, unlock: 500 };
export const GEN2_PCT = 0.05;

// REFERRAL MILESTONES (bonus for the referrer): n = ACTIVE friends needed, reward = MM$. A friend is "active" after their first farm claim.
// Total if all 10 are reached: 14,500 MM$. To change, edit this list only (keep n rising).
export const MILESTONES = [
  { n: 1, reward: 100 }, { n: 3, reward: 150 }, { n: 5, reward: 250 }, { n: 10, reward: 400 }, { n: 20, reward: 600 },
  { n: 35, reward: 900 }, { n: 50, reward: 1400 }, { n: 75, reward: 2200 }, { n: 100, reward: 3500 }, { n: 150, reward: 5000 },
];

// A friend just became ACTIVE (first farm claim): count it once on the referrer, pay the milestone if one is reached.
// DB cost: once per friend in a lifetime = 1 flag write (friend) + 1 counter write (referrer) + 1 payout write only on a milestone.
async function refActive(db, u) {
  const users = db.collection('users');
  const flag = await users.findOneAndUpdate(
    { telegramId: u.telegramId, 'refProg.active': { $ne: true } },
    { $set: { 'refProg.active': true } }
  );
  if (!(flag?.value || (flag && flag._id))) return;
  const r = await users.findOneAndUpdate(
    { telegramId: u.referredBy, isBanned: { $ne: true }, accountLocked: { $ne: true } },
    { $inc: { activeReferrals: 1 } },
    { returnDocument: 'after' }
  );
  const ref = r?.value || r;
  if (!ref || !ref._id) return;
  const paid = ref.refMsPaid || 0;
  let idx = 0;
  while (idx < MILESTONES.length && (ref.activeReferrals || 0) >= MILESTONES[idx].n) idx++;
  if (idx <= paid) return;
  const reward = MILESTONES.slice(paid, idx).reduce((s, m) => s + m.reward, 0);
  // refMsPaid in the filter makes the payout atomic: a double event can never pay the same milestone twice
  await users.updateOne(
    { telegramId: ref.telegramId, refMsPaid: paid === 0 ? { $in: [0, null] } : paid },
    { $inc: { egBalance: reward, totalRefEarnedEG: reward }, $set: { refMsPaid: idx } }
  );
}
const NEED = { tasks: 10, farm3: 3, ads: 10, unlock: 5 };

const BD_MS = 6 * 3600 * 1000; // Bangladesh day (UTC+6), same as lib/dateUtils.js
const farmClaimsToday = (u) => {
  const day = Math.floor((Date.now() + BD_MS) / 86400000);
  let n = 0;
  for (const t of u.farmClaimTimes || []) if (Math.floor((Number(t) + BD_MS) / 86400000) === day) n++;
  return n;
};
const unlockedFarms = (u) => (u.farm2?.slots || []).reduce((n, s) => n + (s?.unlocked ? 1 : 0), 0);

// u = the friend's user document AFTER the event (tasks / ads / farm claim / farm unlock)
export async function refCheck(db, u) {
  try {
    const p = u?.refProg;                       // only friends who joined under the new system have refProg
    if (!p || !u.referredBy) return;
    if (!p.active && (u.farmClaims || 0) >= 1) await refActive(db, u);   // milestone system: friend became active
    if (p.done) return;
    const hit = [];
    if (!p.tasks && (u.tasksDoneTotal || 0) >= NEED.tasks) hit.push('tasks');
    if (!p.farm3 && farmClaimsToday(u) >= NEED.farm3) hit.push('farm3');
    if (!p.ads && (u.adsgramTaskTotal || 0) >= NEED.ads) hit.push('ads');
    if (!p.unlock && unlockedFarms(u) >= NEED.unlock) hit.push('unlock');
    if (!hit.length) return;                    // nothing new: zero DB calls

    const users = db.collection('users');
    const total = hit.reduce((s, m) => s + REF[m], 0);
    const set = {};
    for (const m of hit) set[`refProg.${m}`] = true;
    const allDone = ['tasks', 'farm3', 'ads', 'unlock'].every((m) => p[m] || hit.includes(m));
    if (allDone) set['refProg.done'] = true;

    // flip the flags first (atomic, so a double event can never pay twice), then pay
    const flag = await users.findOneAndUpdate(
      { telegramId: u.telegramId, $and: hit.map((m) => ({ [`refProg.${m}`]: { $ne: true } })) },
      { $set: set, $inc: { refBonusGenerated: total } }
    );
    if (!(flag?.value || (flag && flag._id))) return;
    await users.updateOne(
      { telegramId: u.referredBy, isBanned: { $ne: true }, accountLocked: { $ne: true } },
      { $inc: { egBalance: total, totalRefEarnedEG: total } }
    );
  } catch (e) { console.error('refCheck failed:', e); }
}
