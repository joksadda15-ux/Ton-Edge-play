import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const PLANS = {
  1: { name:'Bird Spirit',    cost:300,   yield:800,   miningHours:4,  ads:{ adsgram:{limit:1,reward:20}, monetag:{limit:1,reward:20}, gigapub:{limit:1,reward:20} } },
  2: { name:'Chick Spirit',   cost:700,   yield:2000,  miningHours:6,  ads:{ adsgram:{limit:1,reward:30}, monetag:{limit:2,reward:20}, gigapub:{limit:2,reward:20} } },
  3: { name:'Duck Spirit',    cost:1200,  yield:4500,  miningHours:8,  ads:{ adsgram:{limit:2,reward:35}, monetag:{limit:3,reward:20}, gigapub:{limit:3,reward:20} } },
  4: { name:'Turtle Spirit',  cost:2000,  yield:10000, miningHours:12, ads:{ adsgram:{limit:3,reward:40}, monetag:{limit:4,reward:25}, gigapub:{limit:4,reward:25} } },
  5: { name:'Serpent Spirit', cost:5000,  yield:28000, miningHours:18, ads:{ adsgram:{limit:4,reward:50}, monetag:{limit:5,reward:30}, gigapub:{limit:5,reward:30} } },
  6: { name:'Dragon Spirit',  cost:7000,  yield:70000, miningHours:24, ads:{ adsgram:{limit:5,reward:60}, monetag:{limit:6,reward:35}, gigapub:{limit:6,reward:35} } },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-06-23"
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge.vercel.app');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, action, planId, network } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  if (initData) {
    const tgUser = verifyTelegramInit(initData);
    if (!tgUser || String(tgUser.id) !== String(telegramId))
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
      if (user.egBalance < plan.cost) return res.status(400).json({ error: 'Insufficient balance' });

      await users.updateOne(
        { telegramId: tgId },
        {
          $inc: { egBalance: -plan.cost, [`ownedSpirits.${planId}`]: 1 },
        }
      );

      // Give referrer 120 EG for spirit purchase
      if (user.referredBy) {
        await users.updateOne(
          { telegramId: user.referredBy },
          { $inc: { egBalance: 120, totalRefEarned: 120 } }
        );
      }

      return res.status(200).json({ success: true, plan });
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

      const today = todayKey();
      const todayAds = user.todayAds?.[today]?.[planId]?.[network] || 0;

      if (todayAds >= networkCfg.limit) {
        return res.status(400).json({ error: `Daily limit reached for ${network}` });
      }

      const reward = networkCfg.reward;
      const newCount = todayAds + 1;

      await users.updateOne(
        { telegramId: tgId },
        {
          $inc: {
            egBalance: reward,
            totalAdsWatched: 1,
            [`todayAds.${today}.${planId}.${network}`]: 1,
          },
        }
      );

      // Refer reward: referrer gets 80 EG when referred user completes 10 tasks
      // (tracked separately in tasks.js)

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
      await users.updateOne(
        { telegramId: tgId },
        { $inc: { egBalance: plan.yield }, $set: { activePlan: null, miningFinishTime: null } }
      );
      return res.status(200).json({ success: true, reward: plan.yield });
    }

    return res.status(400).json({ error: 'Invalid action. Use: buy | ad | claim' });
  } catch (err) {
    console.error('mining.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
  }
