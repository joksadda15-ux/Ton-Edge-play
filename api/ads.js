// FILE PATH: api/ads.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';

// Play → Ad Tasks. Each network has its own daily watch limit and Gold
// reward per ad. Counters reset every day at Bangladesh midnight (bdTodayKey).
const AD_NETWORKS = {
  gigapub:       { label: 'GigaPub Ads',        limit: 10, reward: 200 },
  monetag:       { label: 'Monetag Ads',        limit: 10, reward: 200 },
  adsgram_init:  { label: 'AdsGram Ads',        limit: 5,  reward: 200 },
  adsgram_block: { label: 'AdsGram Block Ads',  limit: 5,  reward: 350 },
};

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
  const today = bdTodayKey();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    if (req.method === 'GET') {
      const watchedToday = user.adTasks?.[today] || {};
      const status = Object.entries(AD_NETWORKS).map(([key, cfg]) => ({
        network: key,
        label: cfg.label,
        reward: cfg.reward,
        limit: cfg.limit,
        watched: watchedToday[key] || 0,
      }));
      return res.status(200).json({ success: true, networks: status });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { network } = req.body;
    const cfg = AD_NETWORKS[network];
    if (!cfg) return res.status(400).json({ error: 'Invalid network' });

    const path = `adTasks.${today}.${network}`;

    // Atomic: only succeeds if today's count for this network is still
    // under the daily limit at the moment of the update.
    const result = await users.findOneAndUpdate(
      {
        telegramId: tgId,
        $or: [
          { [path]: { $exists: false } },
          { [path]: { $lt: cfg.limit } },
        ],
      },
      { $inc: { goldBalance: cfg.reward, [path]: 1 } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) {
      return res.status(400).json({ error: `Daily limit reached for ${cfg.label}` });
    }
    const watched = updated.adTasks?.[today]?.[network] || 0;

    return res.status(200).json({ success: true, reward: cfg.reward, watched, limit: cfg.limit });
  } catch (err) {
    console.error('ads.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
