import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

// 6 egg plans definition
const PLANS = {
  chicken:   { name: 'Chicken Egg',   price: 20,  adsRequired: 5,  egPerAd: 10, yield: 150,  miningHours: 4  },
  duck:      { name: 'Duck Egg',      price: 50,  adsRequired: 8,  egPerAd: 10, yield: 400,  miningHours: 6  },
  goose:     { name: 'Goose Egg',     price: 100, adsRequired: 10, egPerAd: 10, yield: 900,  miningHours: 8  },
  eagle:     { name: 'Eagle Egg',     price: 200, adsRequired: 15, egPerAd: 10, yield: 2000, miningHours: 12 },
  dragon:    { name: 'Dragon Egg',    price: 500, adsRequired: 20, egPerAd: 10, yield: 6000, miningHours: 18 },
  legendary: { name: 'Legendary Egg', price: 1000,adsRequired: 25, egPerAd: 10, yield: 15000,miningHours: 24 },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, planId } = req.body;
  if (!telegramId || !planId) return res.status(400).json({ error: 'telegramId and planId required' });

  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if already has active plan
    if (user.activePlan && user.miningFinishTime && new Date(user.miningFinishTime) > new Date()) {
      return res.status(400).json({ error: 'You already have an active mining plan.' });
    }

    // Set plan as pending (ads not watched yet)
    await users.updateOne(
      { telegramId: String(telegramId) },
      {
        $set: {
          activePlan: { planId, ...plan, adsWatched: 0, status: 'pending' },
          miningFinishTime: null,
        }
      }
    );

    return res.status(200).json({ success: true, plan, message: `Watch ${plan.adsRequired} ads to start mining.` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
