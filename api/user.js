import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const db = await getDb();
    const users = db.collection('users');

    // ── GET /api/user?telegramId=xxx ──────────────────────────────
    if (req.method === 'GET') {
      const { telegramId, initData } = req.query;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      // Verify real Telegram user
      if (initData) {
        const tgUser = verifyTelegramInit(initData);
        if (!tgUser || String(tgUser.id) !== String(telegramId)) {
          return res.status(403).json({ error: 'Invalid Telegram session' });
        }
      }

      const user = await users.findOne(
        { telegramId: String(telegramId) },
        { projection: { _id: 0 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ success: true, user });
    }

    // ── POST /api/user  (register) ────────────────────────────────
    if (req.method === 'POST') {
      const { telegramId, username, firstName, referCode, initData } = req.body;

      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      // Verify real Telegram user
      if (initData) {
        const tgUser = verifyTelegramInit(initData);
        if (!tgUser || String(tgUser.id) !== String(telegramId)) {
          return res.status(403).json({ error: 'Invalid Telegram session' });
        }
      }

      const tgId = String(telegramId);
      const existing = await users.findOne({ telegramId: tgId });
      if (existing) {
        // Update last active
        await users.updateOne({ telegramId: tgId }, { $set: { lastActive: new Date() } });
        return res.status(200).json({ success: true, user: existing, isNew: false });
      }

      const myReferCode =
        'TEP' + tgId.slice(-5) + Math.random().toString(36).slice(2, 5).toUpperCase();

      const newUser = {
        telegramId: tgId,
        username: username || '',
        firstName: firstName || 'User',
        egBalance: 0,
        referCode: myReferCode,
        referredBy: null,
        totalReferred: 0,
        totalRefEarned: 0,
        dailyClaimLast: null,
        activePlan: null,
        miningFinishTime: null,
        totalAdsWatched: 0,
        completedTasks: [],
        promosUsed: [],
        isBanned: false,
        createdAt: new Date(),
        lastActive: new Date(),
      };

      // Handle referral — give referrer 40 EG on join
      if (referCode) {
        const referrer = await users.findOne({ referCode });
        if (referrer && referrer.telegramId !== tgId) {
          newUser.referredBy = referrer.telegramId;
          await users.updateOne(
            { telegramId: referrer.telegramId },
            { $inc: { egBalance: 40, totalRefEarned: 40, totalReferred: 1 } }
          );
        }
      }

      await users.insertOne(newUser);
      return res.status(200).json({ success: true, user: newUser, isNew: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('user.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
          }
