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

      // initData is now REQUIRED — previously this block was skipped entirely
      // when initData was missing, letting anyone read any user's data by
      // guessing a telegramId.
      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const user = await users.findOne(
        { telegramId: String(telegramId) },
        { projection: { _id: 0 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ success: true, user });
    }

    // ── POST /api/user  (register / app-open heartbeat) ───────────
    if (req.method === 'POST') {
      const { telegramId, username, firstName, referCode, initData } = req.body;

      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      // initData is now REQUIRED. Previously, omitting it let anyone POST an
      // arbitrary telegramId + someone else's referCode to farm the 40 EG
      // referral bonus with fake/unverified telegramIds in a loop — no real
      // Telegram account needed. This closes that.
      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const tgId = String(telegramId);
      const existing = await users.findOne({ telegramId: tgId });

      if (existing) {
        // Existing user opening the app again — bump the open counter.
        // appOpens is used client-side to trigger the AdsGram interstitial
        // exactly once, on the 2nd open. No reward is tied to this value.
        const updated = await users.findOneAndUpdate(
          { telegramId: tgId },
          { $set: { lastActive: new Date() }, $inc: { appOpens: 1 } },
          { returnDocument: 'after' }
        );
        const userDoc = updated?.value || updated;
        return res.status(200).json({ success: true, user: userDoc, isNew: false });
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
        appOpens: 1,
        withdrawPending: false,
        createdAt: new Date(),
        lastActive: new Date(),
      };

      // Handle referral — give referrer 30 EG on join (matches the Refer
      // tab's advertised "+30 EG per referral")
      if (referCode) {
        const referrer = await users.findOne({ referCode });
        if (referrer && referrer.telegramId !== tgId) {
          newUser.referredBy = referrer.telegramId;
          await users.updateOne(
            { telegramId: referrer.telegramId },
            { $inc: { egBalance: 30, totalRefEarned: 30, totalReferred: 1 } }
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
