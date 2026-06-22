import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const PLANS = {
  chicken:   { name: 'Chicken Egg',   price: 20,   adsRequired: 5,  egPerAd: 10, yield: 150,   miningHours: 4  },
  duck:      { name: 'Duck Egg',      price: 50,   adsRequired: 8,  egPerAd: 10, yield: 400,   miningHours: 6  },
  goose:     { name: 'Goose Egg',     price: 100,  adsRequired: 10, egPerAd: 10, yield: 900,   miningHours: 8  },
  eagle:     { name: 'Eagle Egg',     price: 200,  adsRequired: 15, egPerAd: 10, yield: 2000,  miningHours: 12 },
  dragon:    { name: 'Dragon Egg',    price: 500,  adsRequired: 20, egPerAd: 10, yield: 6000,  miningHours: 18 },
  legendary: { name: 'Legendary Egg', price: 1000, adsRequired: 25, egPerAd: 10, yield: 15000, miningHours: 24 },
};

function verify(req) {
  const { telegramId, initData } = req.body || {};
  if (!telegramId) return { error: 'telegramId required' };
  if (initData) {
    const tgUser = verifyTelegramInit(initData);
    if (!tgUser || String(tgUser.id) !== String(telegramId)) {
      return { error: 'Invalid Telegram session' };
    }
  }
  return { tgId: String(telegramId) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge.vercel.app');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;
  const auth = verify(req);
  if (auth.error) return res.status(400).json({ error: auth.error });
  const { tgId } = auth;

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    // ── action: buy ───────────────────────────────────────────────
    if (action === 'buy') {
      const { planId } = req.body;
      const plan = PLANS[planId];
      if (!plan) return res.status(400).json({ error: 'Invalid plan' });

      if (user.activePlan && user.activePlan.status !== 'done') {
        return res.status(400).json({ error: 'You already have an active plan.' });
      }

      // Give referrer 80 EG for plan purchase
      if (user.referredBy) {
        await users.updateOne(
          { telegramId: user.referredBy },
          { $inc: { egBalance: 80, totalRefEarned: 80 } }
        );
      }

      await users.updateOne(
        { telegramId: tgId },
        {
          $set: {
            activePlan: { planId, ...plan, adsWatched: 0, status: 'pending' },
            miningFinishTime: null,
          },
        }
      );
      return res.status(200).json({
        success: true,
        plan,
        message: `Watch ${plan.adsRequired} ads to start mining.`,
      });
    }

    // ── action: ad ────────────────────────────────────────────────
    if (action === 'ad') {
      const { adToken } = req.body;
      // adToken should be provided by AdsGram/Monetag callback — skip check in dev
      const plan = user.activePlan;
      if (!plan || plan.status !== 'pending') {
        return res.status(400).json({ error: 'No pending plan.' });
      }

      const newAdsWatched = (plan.adsWatched || 0) + 1;
      const allDone = newAdsWatched >= plan.adsRequired;
      const newTotalAds = (user.totalAdsWatched || 0) + 1;

      if (allDone) {
        const miningFinishTime = new Date(Date.now() + plan.miningHours * 60 * 60 * 1000);
        await users.updateOne(
          { telegramId: tgId },
          {
            $set: {
              'activePlan.adsWatched': newAdsWatched,
              'activePlan.status': 'mining',
              miningFinishTime,
            },
            $inc: { totalAdsWatched: 1 },
          }
        );

        // Give referrer 120 EG when referred user hits 20 total ads
        if (newTotalAds === 20 && user.referredBy) {
          await users.updateOne(
            { telegramId: user.referredBy },
            { $inc: { egBalance: 120, totalRefEarned: 120 } }
          );
        }

        return res.status(200).json({
          success: true,
          miningStarted: true,
          miningFinishTime,
          message: `Mining started! Come back in ${plan.miningHours} hours.`,
        });
      } else {
        await users.updateOne(
          { telegramId: tgId },
          {
            $set: { 'activePlan.adsWatched': newAdsWatched },
            $inc: { totalAdsWatched: 1 },
          }
        );
        return res.status(200).json({
          success: true,
          miningStarted: false,
          adsWatched: newAdsWatched,
          remaining: plan.adsRequired - newAdsWatched,
        });
      }
    }

    // ── action: claim ─────────────────────────────────────────────
    if (action === 'claim') {
      const plan = user.activePlan;
      if (!plan || plan.status !== 'mining') {
        return res.status(400).json({ error: 'No active mining.' });
      }
      if (new Date() < new Date(user.miningFinishTime)) {
        const remaining = Math.ceil((new Date(user.miningFinishTime) - Date.now()) / 60000);
        return res.status(400).json({ error: `Mining not done. ${remaining} minutes left.` });
      }

      await users.updateOne(
        { telegramId: tgId },
        {
          $inc: { egBalance: plan.yield },
          $set: { activePlan: { ...plan, status: 'done' }, miningFinishTime: null },
        }
      );
      return res.status(200).json({ success: true, reward: plan.yield });
    }

    return res.status(400).json({ error: 'Invalid action. Use: buy | ad | claim' });
  } catch (err) {
    console.error('mining.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
        }
