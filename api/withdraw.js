import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

// EG to crypto conversion rates
// 20 EG = $0.001 USDT
// Minimum withdrawal: 10000 EG = $0.50 USDT
const EG_TO_USDT = 0.001 / 20;
const MIN_WITHDRAW_EG = 10000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, method, address, egAmount } = req.body;

  if (!telegramId || !method || !address || !egAmount) {
    return res.status(400).json({ error: 'telegramId, method, address and egAmount required' });
  }

  if (!['tonkeeper', 'binance'].includes(method)) {
    return res.status(400).json({ error: 'Invalid method. Use tonkeeper or binance.' });
  }

  if (egAmount < MIN_WITHDRAW_EG) {
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW_EG} EG.` });
  }

  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.egBalance < egAmount) {
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    // Check pending withdrawal (one at a time)
    const pending = await withdrawals.findOne({
      telegramId: String(telegramId),
      status: 'pending',
    });
    if (pending) {
      return res.status(400).json({ error: 'You already have a pending withdrawal.' });
    }

    const usdtAmount = egAmount * EG_TO_USDT;

    const withdrawDoc = {
      telegramId: String(telegramId),
      method,
      address,
      egAmount,
      usdtAmount: parseFloat(usdtAmount.toFixed(4)),
      status: 'pending',
      createdAt: new Date(),
    };

    await withdrawals.insertOne(withdrawDoc);

    // Deduct balance immediately
    await users.updateOne(
      { telegramId: String(telegramId) },
      { $inc: { egBalance: -egAmount } }
    );

    return res.status(200).json({
      success: true,
      message: 'Withdrawal request submitted. Admin will process within 24-48 hours.',
      usdtAmount: withdrawDoc.usdtAmount,
      method,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
