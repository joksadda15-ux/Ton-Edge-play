import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const MIN_WITHDRAW_EG = 10000;
const EG_TO_USDT = 0.001 / 20;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge.vercel.app');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, method, address, egAmount } = req.body;

  if (!telegramId || !method || !address || !egAmount)
    return res.status(400).json({ error: 'telegramId, method, address, egAmount required' });

  if (!['tonkeeper', 'binance'].includes(method))
    return res.status(400).json({ error: 'method must be tonkeeper or binance' });

  if (Number(egAmount) < MIN_WITHDRAW_EG)
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW_EG} EG.` });

  if (method === 'binance') {
    if (!/^\d{6,12}$/.test(String(address)))
      return res.status(400).json({ error: 'Invalid Binance UID. Must be 6-12 digits.' });
  }
  if (method === 'tonkeeper') {
    if (!/^(UQ|EQ)[A-Za-z0-9_-]{46}$/.test(String(address)))
      return res.status(400).json({ error: 'Invalid TON address format.' });
  }

  if (initData) {
    const tgUser = verifyTelegramInit(initData);
    if (!tgUser || String(tgUser.id) !== String(telegramId))
      return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });
    if (user.egBalance < Number(egAmount))
      return res.status(400).json({ error: 'Insufficient balance.' });

    const pending = await withdrawals.findOne({ telegramId: String(telegramId), status: 'pending' });
    if (pending) return res.status(400).json({ error: 'You already have a pending withdrawal.' });

    const usdtAmount = parseFloat((Number(egAmount) * EG_TO_USDT).toFixed(4));

    const doc = {
      telegramId: String(telegramId),
      username: user.username || '',
      firstName: user.firstName || '',
      method,
      address: String(address),
      egAmount: Number(egAmount),
      usdtAmount,
      status: 'pending',
      createdAt: new Date(),
    };

    await withdrawals.insertOne(doc);
    await users.updateOne(
      { telegramId: String(telegramId) },
      { $inc: { egBalance: -Number(egAmount) } }
    );

    return res.status(200).json({
      success: true,
      usdtAmount,
      method,
      message: 'Withdrawal submitted. Admin will process within 24-48 hours.',
    });
  } catch (err) {
    console.error('withdraw.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
      }
