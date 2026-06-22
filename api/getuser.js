import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId } = req.query;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  try {
    await client.connect();
    const db = client.db('tonedge');
    const user = await db.collection('users').findOne({ telegramId: String(telegramId) });

    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.status(200).json({ success: true, user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
