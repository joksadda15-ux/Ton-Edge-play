// FILE PATH: api/convert.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

// 1,000,000 Gold = 50,000 EG  →  20 Gold = 1 EG
const GOLD_PER_EG = 20;
const MIN_CONVERT_GOLD = 20000; // = 1,000 EG

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId, initData, goldAmount } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const amount = Number(goldAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid goldAmount.' });
  }
  if (amount < MIN_CONVERT_GOLD) {
    return res.status(400).json({ error: `Minimum conversion is ${MIN_CONVERT_GOLD.toLocaleString()} Gold.` });
  }

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);
  const egAmount = amount / GOLD_PER_EG;

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    // Atomic: only succeeds if goldBalance is still >= amount at the moment
    // of the update — prevents double-spending Gold across concurrent requests.
    const result = await users.findOneAndUpdate(
      { telegramId: tgId, goldBalance: { $gte: amount } },
      { $inc: { goldBalance: -amount, egBalance: egAmount } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) return res.status(400).json({ error: 'Insufficient Gold balance.' });

    return res.status(200).json({ success: true, goldSpent: amount, egReceived: egAmount, newGold: updated.goldBalance, newEg: updated.egBalance });
  } catch (err) {
    console.error('convert.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
