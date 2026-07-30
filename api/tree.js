// FILE PATH: api/tree.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

// Fruit Tree — collect fruit every 4 hours, watch an ad to collect,
// reward is a random amount of Gold between MIN and MAX.
const COOLDOWN_MS = 4 * 3600000; // 4 hours
const MIN_REWARD = 100;
const MAX_REWARD = 500;

function rollFruitReward() {
  return MIN_REWARD + Math.floor(Math.random() * (MAX_REWARD - MIN_REWARD + 1));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);
  const now = new Date();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const lastHarvest = user.tree?.lastHarvest ? new Date(user.tree.lastHarvest) : null;
    const readyAt = lastHarvest ? lastHarvest.getTime() + COOLDOWN_MS : 0;
    const canHarvest = !lastHarvest || now.getTime() >= readyAt;
    const nextMs = canHarvest ? 0 : Math.max(0, readyAt - now.getTime());

    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        canHarvest,
        nextMs,
        totalHarvests: user.tree?.totalHarvests || 0,
        totalGoldFromTree: user.tree?.totalGold || 0,
        minReward: MIN_REWARD,
        maxReward: MAX_REWARD,
        cooldownHours: COOLDOWN_MS / 3600000,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body;
    if (action !== 'harvest') return res.status(400).json({ error: 'Invalid action. Use: harvest' });

    // Atomic: only succeeds if the cooldown has genuinely elapsed at the
    // moment of the update — prevents double-harvest from concurrent taps.
    const cutoff = new Date(now.getTime() - COOLDOWN_MS);
    const reward = rollFruitReward();
    const result = await users.findOneAndUpdate(
      {
        telegramId: tgId,
        $or: [
          { 'tree.lastHarvest': { $exists: false } },
          { 'tree.lastHarvest': null },
          { 'tree.lastHarvest': { $lte: cutoff } },
        ],
      },
      {
        $set: { 'tree.lastHarvest': now },
        $inc: { goldBalance: reward, 'tree.totalHarvests': 1, 'tree.totalGold': reward },
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) {
      const remaining = Math.ceil((readyAt - now.getTime()) / 60000);
      return res.status(400).json({ error: `Tree not ready yet. ${Math.max(remaining, 1)} minutes left.` });
    }

    // Referral milestone (mirror of the check in tasks.js) — either a task
    // completion or a tree harvest can be the action that completes the
    // "5 tasks + 3 tree harvests" pair, so both files check the same two
    // fields on the just-updated document.
    if (
      (updated.tree?.totalHarvests || 0) >= 3 &&
      (updated.completedTasks?.length || 0) >= 5 &&
      updated.referredBy &&
      !updated.referralValidPaid
    ) {
      const flagged = await users.findOneAndUpdate(
        { telegramId: tgId, referralValidPaid: { $ne: true } },
        { $set: { referralValidPaid: true } },
        { returnDocument: 'after' }
      );
      if (flagged?.value || flagged) {
        await users.updateOne(
          { telegramId: updated.referredBy },
          { $inc: { egBalance: 100, totalRefEarnedEG: 100 } }
        );
      }
    }

    return res.status(200).json({ success: true, reward });
  } catch (err) {
    console.error('tree.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
                      }
