import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
const DAILY_REWARD = 25;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    const last = user.dailyClaimLast ? new Date(user.dailyClaimLast) : null;

    if (last) {
      const diff = now - last;
      const hours = diff / (1000 * 60 * 60);
      if (hours < 24) {
        const remaining = Math.ceil(24 - hours);
        return res.status(400).json({ error: `Already claimed. Come back in ${remaining} hours.` });
      }
    }

    await users.updateOne(
      { telegramId: String(telegramId) },
      { $inc: { egBalance: DAILY_REWARD }, $set: { dailyClaimLast: now } }
    );

    return res.status(200).json({ success: true, reward: DAILY_REWARD });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
