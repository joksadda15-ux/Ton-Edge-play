import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId } = req.query;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const referLink = `http://t.me/TonEdge_play_bot/startapp?startapp=${user.referCode}`;

    // Get referred users list
    const referredUsers = await users
      .find({ referredBy: String(telegramId) })
      .project({ firstName: 1, username: 1, createdAt: 1 })
      .toArray();

    return res.status(200).json({
      success: true,
      referCode: user.referCode,
      referLink,
      totalReferred: user.totalReferred || 0,
      totalRefEarned: user.totalRefEarned || 0,
      referredUsers,
      rewards: {
        onJoin: 40,
        onPlanBuy: 80,
        on20Ads: 120,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
