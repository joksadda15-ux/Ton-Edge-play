// FILE PATH: lib/publicUser.js
// What the APP is allowed to see of a user. /api/user used to send the WHOLE database document
// (fraud flags, signupIp, click history, trapLog ...): 3-5 KB per call, and internal data on the phone.
// Now only the fields the app really draws are sent (~0.4 KB). Smaller answers = less Render bandwidth.
// If you add a new field to the app UI that reads userData.xxx, add it here too.
export function publicUser(u) {
  if (!u) return u;
  return {
    telegramId: u.telegramId,
    username: u.username || '',
    firstName: u.firstName || '',
    egBalance: u.egBalance || 0,
    referCode: u.referCode,
    totalReferred: u.totalReferred || 0,
    totalRefEarnedEG: u.totalRefEarnedEG || 0,
    loginBonus: u.loginBonus || null,
    farmClaims: u.farmClaims || 0,
    // the profile page needs only the NUMBER of finished tasks, not the whole completedTasks list
    tasksDone: u.tasksDoneTotal ?? (u.completedTasks || []).length,
    withdrawalsApproved: u.withdrawalsApproved || 0,
    createdAt: u.createdAt,
  };
}
