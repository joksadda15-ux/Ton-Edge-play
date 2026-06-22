import { MongoClient, ObjectId } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);
const ADMIN_ID = process.env.ADMIN_ID;

export default async function handler(req, res) {
  const { adminId, action } = req.body || req.query;

  if (String(adminId) !== String(ADMIN_ID)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    await client.connect();
    const db = client.db('tonedge');

    // GET — list pending withdrawals
    if (req.method === 'GET') {
      const withdrawals = await db.collection('withdrawals')
        .find({ status: 'pending' })
        .sort({ createdAt: 1 })
        .toArray();

      const stats = await db.collection('users').countDocuments();

      return res.status(200).json({ success: true, withdrawals, totalUsers: stats });
    }

    // POST — approve or reject
    if (req.method === 'POST') {
      const { withdrawalId, action } = req.body;

      if (!withdrawalId || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'withdrawalId and action (approve/reject) required' });
      }

      const withdrawal = await db.collection('withdrawals').findOne({ _id: new ObjectId(withdrawalId) });
      if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ error: 'Withdrawal already processed' });
      }

      if (action === 'reject') {
        // Refund balance
        await db.collection('users').updateOne(
          { telegramId: withdrawal.telegramId },
          { $inc: { egBalance: withdrawal.egAmount } }
        );
      }

      await db.collection('withdrawals').updateOne(
        { _id: new ObjectId(withdrawalId) },
        { $set: { status: action === 'approve' ? 'approved' : 'rejected', processedAt: new Date() } }
      );

      return res.status(200).json({ success: true, action });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
