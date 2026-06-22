import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, code } = req.body;
  if (!telegramId || !code) return res.status(400).json({ error: 'telegramId and code required' });

  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');
    const promos = db.collection('promos');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const promo = await promos.findOne({ code: code.toUpperCase() });
    if (!promo) return res.status(404).json({ error: 'Invalid promo code.' });

    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'Promo code expired.' });
    }

    if (promo.maxUses && promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ error: 'Promo code usage limit reached.' });
    }

    const usedPromos = user.promosUsed || [];
    if (usedPromos.includes(code.toUpperCase())) {
      return res.status(400).json({ error: 'You already used this promo code.' });
    }

    await users.updateOne(
      { telegramId: String(telegramId) },
      {
        $inc: { egBalance: promo.reward },
        $push: { promosUsed: code.toUpperCase() },
      }
    );

    await promos.updateOne(
      { code: code.toUpperCase() },
      { $inc: { usedCount: 1 } }
    );

    return res.status(200).json({ success: true, reward: promo.reward, message: `+${promo.reward} EG added!` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
