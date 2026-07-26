import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';

const PLANS = {
  1: { name:'Bird Spirit',    cost:0,     free:true,  yield:800,   miningHours:4,  ads:{ adsgram:{limit:1,reward:20}, monetag:{limit:1,reward:20}, gigapub:{limit:1,reward:20} } },
  2: { name:'Chick Spirit',   cost:300,   yield:2000,  miningHours:6,  ads:{ adsgram:{limit:1,reward:30}, monetag:{limit:2,reward:20}, gigapub:{limit:2,reward:20} } },
  3: { name:'Duck Spirit',    cost:800,  yield:4500,  miningHours:8,  ads:{ adsgram:{limit:2,reward:35}, monetag:{limit:3,reward:20}, gigapub:{limit:3,reward:20} } },
  4: { name:'Turtle Spirit',  cost:1500,  yield:10000, miningHours:12, ads:{ adsgram:{limit:3,reward:40}, monetag:{limit:4,reward:25}, gigapub:{limit:4,reward:25} } },
  5: { name:'Serpent Spirit', cost:3000,  yield:28000, miningHours:18, ads:{ adsgram:{limit:4,reward:50}, monetag:{limit:5,reward:30}, gigapub:{limit:5,reward:30} } },
  6: { name:'Dragon Spirit',  cost:5000,  yield:70000, miningHours:24, ads:{ adsgram:{limit:5,reward:60}, monetag:{limit:6,reward:35}, gigapub:{limit:6,reward:35} } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, action, planId, network } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  // initData is now REQUIRED — previously optional (`if (initData) {...}`),
  // which let anyone buy/claim spirits, ad rewards, or mining payouts for
  // ANY telegramId with no proof of identity.
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    // ── action: buy ───────────────────────────────────────────────
    if (action === 'buy') {
      const plan = PLANS[planId];
      if (!plan) return res.status(400).json({ error: 'Invalid plan' });

      if (plan.free) {
        // Atomic claim: only succeeds if this spirit isn't already owned.
        // Previously a plain read-then-write — two simultaneous claims
        // could both pass the "not owned" check before either wrote.
        const result = await users.findOneAndUpdate(
          {
            telegramId: tgId,
            $or: [
              { [`ownedSpirits.${planId}`]: { $exists: false } },
              { [`ownedSpirits.${planId}`]: { $lte: 0 } },
            ],
          },
          { $set: { [`ownedSpirits.${planId}`]: 1 } },
          { returnDocument: 'after' }
        );
        const updated = result?.value || result;
        if (!updated) return res.status(400).json({ error: 'Already claimed free spirit' });
        return res.status(200).json({ success: true, plan, free: true });
      }

      // Atomic purchase: only succeeds if balance is still >= cost at the
      // moment of the update. Previously a separate balance check then a
      // separate $inc — two buy requests fired together could both pass
      // the balance check before either deduction landed, letting a user
      // buy more spirits than their balance allowed.
      const result = await users.findOneAndUpdate(
        { telegramId: tgId, egBalance: { $gte: plan.cost } },
        { $inc: { egBalance: -plan.cost, [`ownedSpirits.${planId}`]: 1 } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(400).json({ error: 'Insufficient balance' });

      // Give referrer 120 EG for spirit purchase
      if (user.referredBy) {
        await users.updateOne(
          { telegramId: user.referredBy },
          { $inc: { egBalance: 120, totalRefEarned: 120 } }
        );
      }

      return res.status(200).json({ success: true, plan, permanent: true });
    }

    // ── action: ad ────────────────────────────────────────────────
    if (action === 'ad') {
      if (!planId || !network) return res.status(400).json({ error: 'planId and network required' });

      const plan = PLANS[planId];
      if (!plan) return res.status(400).json({ error: 'Invalid plan' });

      const owned = user.ownedSpirits?.[planId] || 0;
      if (!owned) return res.status(400).json({ error: 'Buy this spirit first' });

      const networkCfg = plan.ads[network];
      if (!networkCfg) return res.status(400).json({ error: 'Invalid network' });

      const today = bdTodayKey();
      const path = `todayAds.${today}.${planId}.${network}`;
      const reward = networkCfg.reward;

      // Atomic: only succeeds if today's count for this plan+network is
      // still under the limit at the moment of the update. Previously a
      // separate read-then-write, so several requests fired together could
      // all pass the limit check before any of them wrote, letting a user
      // exceed the daily ad-reward limit.
      const result = await users.findOneAndUpdate(
        {
          telegramId: tgId,
          $or: [
            { [path]: { $exists: false } },
            { [path]: { $lt: networkCfg.limit } },
          ],
        },
        {
          $inc: {
            egBalance: reward,
            totalAdsWatched: 1,
            [path]: 1,
          },
        },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: `Daily limit reached for ${network}` });
      }
      const newCount = updated.todayAds?.[today]?.[planId]?.[network] || 0;

      return res.status(200).json({
        success: true,
        reward,
        watched: newCount,
        limit: networkCfg.limit,
      });
    }

    // ── action: claim (mining complete) ──────────────────────────
    if (action === 'claim') {
      const plan = user.activePlan;
      if (!plan || plan.status !== 'mining') return res.status(400).json({ error: 'No active mining' });
      if (new Date() < new Date(user.miningFinishTime)) {
        const remaining = Math.ceil((new Date(user.miningFinishTime) - Date.now()) / 60000);
        return res.status(400).json({ error: `Mining not done. ${remaining} minutes left.` });
      }

      // Atomic: only succeeds if activePlan is still 'mining' at the moment
      // of the update. Previously a separate check-then-write, so two
      // simultaneous claim calls could both pass the status check before
      // either cleared it, double-crediting the mining reward.
      const result = await users.findOneAndUpdate(
        { telegramId: tgId, 'activePlan.status': 'mining' },
        { $inc: { egBalance: plan.yield }, $set: { activePlan: null, miningFinishTime: null } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) return res.status(400).json({ error: 'No active mining' });

      return res.status(200).json({ success: true, reward: plan.yield });
    }

    return res.status(400).json({ error: 'Invalid action. Use: buy | ad | claim' });
  } catch (err) {
    console.error('mining.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
    }
