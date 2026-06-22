import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

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

    const plan = user.activePlan;
    if (!plan || plan.status !== 'mining') {
      return res.status(400).json({ error: 'No active mining found.' });
    }

    const now = new Date();
    const finishTime = new Date(user.miningFinishTime);

    if (now < finishTime) {
      const remaining = Math.ceil((finishTime - now) / 1000 / 60);
      return res.status(400).json({ error: `Mining not finished yet. ${remaining} minutes remaining.` });
    }

    const reward = plan.yield;

    await users.updateOne(
      { telegramId: String(telegramId) },
      {
        $inc: { egBalance: reward },
        $set: { activePlan: null, miningFinishTime: null },
      }
    );

    return res.status(200).json({ success: true, reward, message: `+${reward} EG added to your balance!` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
