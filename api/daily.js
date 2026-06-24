import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const DAILY_REWARD = 25;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, action, code } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  if (initData) {
    const tgUser = verifyTelegramInit(initData);
    if (!tgUser || String(tgUser.id) !== String(telegramId)) {
      return res.status(403).json({ error: 'Invalid Telegram session' });
    }
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
      const last = user.dailyClaimLast ? new Date(user.dailyClaimLast) : null;
      if (last && now - last < 24 * 60 * 60 * 1000) {
        const hours = Math.ceil(24 - (now - last) / 3600000);
        return res.status(400).json({ error: `Already claimed. Come back in ${hours} hours.` });
      }
      await users.updateOne(
        { telegramId: String(telegramId) },
        { $inc: { egBalance: DAILY_REWARD }, $set: { dailyClaimLast: now } }
      );
      return res.status(200).json({ success: true, reward: DAILY_REWARD });
    }

    // ── action: promo ─────────────────────────────────────────────
    if (action === 'promo') {
      if (!code) return res.status(400).json({ error: 'code required' });
      const promos = db.collection('promos');
      const promo = await promos.findOne({ code: code.toUpperCase().trim() });

      if (!promo) return res.status(404).json({ error: 'Invalid promo code.' });
      if (promo.expiresAt && new Date(promo.expiresAt) < new Date())
        return res.status(400).json({ error: 'Promo code expired.' });
      if (promo.maxUses && promo.usedCount >= promo.maxUses)
        return res.status(400).json({ error: 'Promo code limit reached.' });
      if ((user.promosUsed || []).includes(code.toUpperCase().trim()))
        return res.status(400).json({ error: 'Already used this promo code.' });

      await users.updateOne(
        { telegramId: String(telegramId) },
        { $inc: { egBalance: promo.reward }, $push: { promosUsed: code.toUpperCase().trim() } }
      );
      await promos.updateOne({ code: code.toUpperCase().trim() }, { $inc: { usedCount: 1 } });

      return res.status(200).json({ success: true, reward: promo.reward });
    }

    return res.status(400).json({ error: 'Invalid action. Use: daily | promo' });
  } catch (err) {
    console.error('daily.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
