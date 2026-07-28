// FILE PATH: api/miniapp.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const COOLDOWN_MS = 2 * 3600000; // 1 play every 2h, per game — ad required every time

const GAMES = {
  spin: {
    label: 'Lucky Spin',
    // Fixed 6 Gold values. Must stay in sync with SPIN_SEGMENTS in index.html
    // (client draws the wheel from its own copy of these numbers and looks up
    // index by value — the SET of 6 numbers must match, order doesn't matter).
    values: [50, 80, 120, 160, 220, 300],
    weights: [130, 130, 120, 100, 80, 40], // sums to 600
  },
  chest: {
    label: 'Mystery Chest',
    // [tierName, min, max, weight] — weights sum to 100 — Gold reward range 50-300
    tiers: [
      ['Silver', 50, 100, 40],
      ['Gold', 101, 180, 42],
      ['Epic', 181, 250, 15],
      ['Legendary', 251, 300, 3],
    ],
  },
};

function rollSpin() {
  const { values, weights } = GAMES.spin;
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < values.length; i++) {
    if (roll < weights[i]) return { reward: values[i] };
    roll -= weights[i];
  }
  return { reward: values[values.length - 1] };
}

function rollChest() {
  const tiers = GAMES.chest.tiers;
  const total = tiers.reduce((s, t) => s + t[3], 0);
  let roll = Math.random() * total;
  for (const [name, min, max, weight] of tiers) {
    if (roll < weight) return { tier: name, reward: min + Math.floor(Math.random() * (max - min + 1)) };
    roll -= weight;
  }
  const last = tiers[tiers.length - 1];
  return { tier: last[0], reward: last[1] };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';
  const action      = req.query?.action    || req.body?.action || 'status';
  const gameKey     = req.query?.game      || req.body?.game;

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
  if (!gameKey || !GAMES[gameKey]) return res.status(400).json({ error: 'Invalid or missing game (use: spin | chest)' });

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid session' });
  }

  const tgId = String(telegramId);
  const now = new Date();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const mg = (user.gameData?.miniGames?.[gameKey]) || {};
    const lastPlayed = mg.lastPlayed ? new Date(mg.lastPlayed) : null;
    const canPlay = !lastPlayed || (now - lastPlayed) >= COOLDOWN_MS;
    const nextPlayMs = canPlay ? 0 : Math.max(0, lastPlayed.getTime() + COOLDOWN_MS - now.getTime());

    // ═══════════════════════════════════════
    if (req.method === 'GET' || action === 'status') {
      return res.status(200).json({
        success: true,
        game: gameKey,
        label: GAMES[gameKey].label,
        canPlay,
        nextPlayMs,
        requiresAd: true, // an ad is always required before every play
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ═══════════════════════════════════════
    // play — atomic: only succeeds if the 2h cooldown slot is free.
    // Reward is rolled server-side, never trusts the client for a score.
    // ═══════════════════════════════════════
    if (action === 'play') {
      const path = `gameData.miniGames.${gameKey}`;
      const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);

      const result = await users.findOneAndUpdate(
        {
          telegramId: tgId,
          $or: [
            { [`${path}.lastPlayed`]: { $exists: false } },
            { [`${path}.lastPlayed`]: null },
            { [`${path}.lastPlayed`]: { $lte: cooldownCutoff } },
          ],
        },
        { $set: { [`${path}.lastPlayed`]: now } },
        { returnDocument: 'after' }
      );
      const granted = result?.value || result;
      if (!granted) {
        return res.status(400).json({ error: 'No play available yet. Wait for the 2h timer.' });
      }

      const roll = gameKey === 'spin' ? rollSpin() : rollChest();
      const reward = roll.reward;
      const tier = roll.tier || null;
      await users.updateOne({ telegramId: tgId }, {
        $inc: { goldBalance: reward, [`${path}.totalEarned`]: reward, [`${path}.totalPlays`]: 1 },
      });

      return res.status(200).json({ success: true, reward, tier, game: gameKey });
    }

    return res.status(400).json({ error: 'Invalid action. Use: status | play' });
  } catch (err) {
    console.error('miniapp.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
        }
