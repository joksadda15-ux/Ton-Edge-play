import { cyInc, cyMin } from '../lib/cycleStats.js';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';
import { tgApi } from '../lib/tg.js';

// ===== EDIT HERE: login bonus (MM$ for day 1, 2, 3 ... then it starts again from day 1) =====
const LOGIN_BONUS = [20, 40, 80, 140, 200, 300, 600];
// The user must keep OUR bot's referral link (their own refer code) in their Telegram bio to claim the login bonus.
const BOT_USERNAME = 'TonEdge_play_bot';   // same bot as MINI_APP_URL in api/bot.js
const APP_SHORT_NAME = 'playearn';
// ===========================================================================================

const refLinkFor = (code) => `t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${code}`;
// bio must contain this bot + the user's OWN refer code (case-insensitive, code must end there)
const bioHasLink = (bio, code) => {
  const b = String(bio || '').toLowerCase();
  const c = String(code || '').toLowerCase();
  if (!c || !b.includes(BOT_USERNAME.toLowerCase())) return false;
  return new RegExp('startapp=' + c.replace(/[^a-z0-9]/g, '') + '(?![a-z0-9])').test(b);
};
// Telegram only shows a user's bio to the bot if they started the bot and their privacy allows it.
async function getUserBio(tgId) {
  try {
    const r = await tgApi('getChat', { chat_id: Number(tgId) });
    if (!r?.ok) return { ok: false };
    return { ok: true, bio: r.result?.bio || '' };
  } catch { return { ok: false }; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, action, code } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  // initData is now REQUIRED — was optional, meaning anyone could claim the
  // daily reward or redeem a promo code for any telegramId with no proof of
  // identity.
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    // ── action: login (daily login bonus, streak 20 → 600 MM$) ──────
    // One claim per Bangladesh calendar day. Miss a day and the streak starts again from day 1.
    if (action === 'login') {
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const today = bdTodayKey();
      const yesterday = bdTodayKey(new Date(Date.now() - 86400000));
      const lb = user.loginBonus || {};
      if (lb.lastDay === today) return res.status(400).json({ error: 'Already claimed today. Come back tomorrow.' });

      // Bio check: the user's Telegram bio must contain their own referral link of our bot.
      if (!user.referCode) return res.status(500).json({ error: 'Server error' });
      const bio = await getUserBio(String(telegramId));
      if (!bio.ok) return res.status(400).json({ error: 'bio_check_failed', link: refLinkFor(user.referCode) });
      if (!bioHasLink(bio.bio, user.referCode)) return res.status(400).json({ error: 'bio_link_missing', link: refLinkFor(user.referCode) });

      const day = lb.lastDay === yesterday ? ((lb.streak || 0) % LOGIN_BONUS.length) + 1 : 1;
      const reward = LOGIN_BONUS[day - 1];

      // Atomic: only one request per day can pass this filter, so a double tap cannot pay twice.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), 'loginBonus.lastDay': { $ne: today } },
        { $inc: { egBalance: reward, ...cyInc('login', reward) }, $min: cyMin(), $set: { loginBonus: { lastDay: today, streak: day } } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(400).json({ error: 'Already claimed today. Come back tomorrow.' });
      return res.status(200).json({ success: true, reward, day, loginBonus: { lastDay: today, streak: day }, balance: updated.egBalance });
    }

    // ── action: promo ─────────────────────────────────────────────
    if (action === 'promo') {
      if (!code) return res.status(400).json({ error: 'code required' });
      if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
      const cleanCode = String(code).toUpperCase().trim().slice(0, 40);
      const { checkOnly } = req.body;
      const promos = db.collection('promos');
      const promo = await promos.findOne({ code: cleanCode });

      // Validate
      if (!promo) return res.status(200).json({ valid: false, error: 'Invalid promo code.' });
      if (promo.expiresAt && new Date(promo.expiresAt) < new Date())
        return res.status(200).json({ valid: false, error: 'Promo code expired.' });
      if (promo.maxUses && promo.usedCount >= promo.maxUses)
        return res.status(200).json({ valid: false, error: 'Promo code limit reached.' });
      if ((user.promosUsed || []).includes(cleanCode))
        return res.status(200).json({ valid: false, error: 'Already used this promo code.' });

      // checkOnly = just validate, don't redeem yet (before showing an ad).
      // Note: nothing server-side actually enforces that an ad was shown
      // between checkOnly and the real redeem call below — a user can call
      // this endpoint directly with checkOnly:false and skip the ad
      // entirely. Low stakes (small, capped, one-time-per-user reward) but
      // flagging it: if the ad-watch is meant to be mandatory, it isn't.
      if (checkOnly) return res.status(200).json({ valid: true, reward: promo.reward, currency: 'mm' });

      // Every promo pays MM$ now (old Gold promos are converted by the migration script).
      const field = 'egBalance';

      // 1) reserve one use of the code ATOMICALLY (two people can never take the last slot together)
      const slot = await promos.findOneAndUpdate(
        { code: cleanCode, $or: [{ maxUses: { $in: [0, null] } }, { $expr: { $lt: [{ $ifNull: ['$usedCount', 0] }, '$maxUses'] } }] },
        { $inc: { usedCount: 1 } }
      );
      if (!(slot?.value !== undefined ? slot.value : slot)) return res.status(200).json({ valid: false, error: 'Promo code limit reached.' });

      // 2) pay the user, only if this code is not already in promosUsed (double tap safe)
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), promosUsed: { $ne: cleanCode } },
        { $inc: { [field]: promo.reward, ...cyInc('promo', promo.reward) }, $min: cyMin(), $push: { promosUsed: cleanCode } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        await promos.updateOne({ code: cleanCode }, { $inc: { usedCount: -1 } }); // give the reserved use back
        return res.status(200).json({ valid: false, error: 'Already used this promo code.' });
      }

      return res.status(200).json({ success: true, reward: promo.reward, currency: 'mm' });
    }

    return res.status(400).json({ error: 'Invalid action. Use: login | promo' });
  } catch (err) {
    console.error('daily.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
  }
