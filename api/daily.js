import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const DAILY_REWARD = 300; // Gold, not EG

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

    // ── action: daily ─────────────────────────────────────────────
    if (action === 'daily') {
      const now = new Date();
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Atomic: only succeeds if dailyClaimLast is missing or older than the
      // cutoff. Previously this was read-then-write, so two claims fired
      // close together could both pass the time check before either wrote,
      // double-crediting the daily reward.
      const result = await users.findOneAndUpdate(
        {
          telegramId: String(telegramId),
          $or: [
            { dailyClaimLast: { $exists: false } },
            { dailyClaimLast: null },
            { dailyClaimLast: { $lte: cutoff } },
          ],
        },
        { $inc: { goldBalance: DAILY_REWARD }, $set: { dailyClaimLast: now } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        const last = new Date(user.dailyClaimLast);
        const hours = Math.ceil(24 - (now - last) / 3600000);
        return res.status(400).json({ error: `Already claimed. Come back in ${hours} hours.` });
      }
      return res.status(200).json({ success: true, reward: DAILY_REWARD });
    }

    // ── action: promo ─────────────────────────────────────────────
    if (action === 'promo') {
      if (!code) return res.status(400).json({ error: 'code required' });
      const cleanCode = code.toUpperCase().trim();
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
      if (checkOnly) return res.status(200).json({ valid: true, reward: promo.reward, currency: promo.currency === 'gold' ? 'gold' : 'eg' });

      // Old promo codes created before the Gold/EG choice existed have no
      // currency field — default those to 'eg' so they keep behaving exactly
      // as they always did.
      const field = promo.currency === 'gold' ? 'goldBalance' : 'egBalance';

      // Atomic redeem: only succeeds if this code isn't already in
      // promosUsed. Previously read-then-write, so two simultaneous redeems
      // of the same code by the same user could both succeed.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), promosUsed: { $ne: cleanCode } },
        { $inc: { [field]: promo.reward }, $push: { promosUsed: cleanCode } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        return res.status(200).json({ valid: false, error: 'Already used this promo code.' });
      }

      // Still not perfectly race-proof against maxUses across DIFFERENT
      // users hitting the last slot at the same instant (this $inc isn't
      // conditioned on usedCount < maxUses), but that only risks a handful
      // of extra redemptions on a capped code, not unlimited balance growth.
      await promos.updateOne({ code: cleanCode }, { $inc: { usedCount: 1 } });

      return res.status(200).json({ success: true, reward: promo.reward, currency: promo.currency === 'gold' ? 'gold' : 'eg' });
    }

    return res.status(400).json({ error: 'Invalid action. Use: daily | promo' });
  } catch (err) {
    console.error('daily.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
             }
