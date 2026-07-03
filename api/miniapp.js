import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const FREE_WINDOW_MS = 24 * 3600000;   // 1 free play per rolling 24h, per game
const COOLDOWN_MS = 2 * 3600000;       // otherwise 1 play per rolling 2h, per game

const GAMES = {
  spin: {
    label: 'Lucky Spin',
    // weighted reward table — [min, max, weight]
    table: [[1, 2, 40], [3, 4, 30], [5, 7, 18], [8, 10, 9], [11, 15, 3]],
  },
  chest: {
    label: 'Mystery Chest',
    table: [[1, 3, 60], [4, 8, 30], [10, 20, 10]], // common / rare / epic
  },
};

function rollReward(table) {
  const totalWeight = table.reduce((s, r) => s + r[2], 0);
  let roll = Math.random() * totalWeight;
  for (const [min, max, weight] of table) {
    if (roll < weight) return min + Math.floor(Math.random() * (max - min + 1));
    roll -= weight;
  }
  const last = table[table.length - 1];
  return last[0];
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
    const freeLastUsed = mg.freeLastUsed ? new Date(mg.freeLastUsed) : null;
    const lastPlayed    = mg.lastPlayed    ? new Date(mg.lastPlayed)    : null;

    const freeAvailable = !freeLastUsed || (now - freeLastUsed) >= FREE_WINDOW_MS;
    const cooldownDone  = !lastPlayed || (now - lastPlayed) >= COOLDOWN_MS;
    const canPlay = freeAvailable || cooldownDone;
    const nextFreeMs = freeAvailable ? 0 : Math.max(0, freeLastUsed.getTime() + FREE_WINDOW_MS - now.getTime());
    const nextPlayMs = cooldownDone ? 0 : Math.max(0, lastPlayed.getTime() + COOLDOWN_MS - now.getTime());

    // ═══════════════════════════════════════
    if (req.method === 'GET' || action === 'status') {
      return res.status(200).json({
        success: true,
        game: gameKey,
        label: GAMES[gameKey].label,
        freeAvailable,
        nextFreeMs,
        canPlay,
        nextPlayMs,
        requiresAd: !freeAvailable, // client shows "watch ad" flow when this is true
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ═══════════════════════════════════════
    // play — atomic: either consumes today's free play, or the 2h cooldown slot.
    // Reward is rolled server-side, never trusts the client for a score.
    // ═══════════════════════════════════════
    if (action === 'play') {
      const freeCutoff = new Date(now.getTime() - FREE_WINDOW_MS);
      const path = `gameData.miniGames.${gameKey}`;

      // Try free play first
      let result = await users.findOneAndUpdate(
        {
          telegramId: tgId,
          $or: [
            { [`${path}.freeLastUsed`]: { $exists: false } },
            { [`${path}.freeLastUsed`]: null },
            { [`${path}.freeLastUsed`]: { $lte: freeCutoff } },
          ],
        },
        { $set: { [`${path}.freeLastUsed`]: now, [`${path}.lastPlayed`]: now } },
        { returnDocument: 'after' }
      );
      let granted = result?.value || result;
      let source = 'free';

      if (!granted) {
        // Fall back to the 2h cooldown slot
        const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);
        result = await users.findOneAndUpdate(
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
        granted = result?.value || result;
        source = 'cooldown';
        if (!granted) {
          return res.status(400).json({ error: 'No play available yet. Wait for the timer or your free daily play.' });
        }
      }

      const reward = rollReward(GAMES[gameKey].table);
      await users.updateOne({ telegramId: tgId }, {
        $inc: { egBalance: reward, [`${path}.totalEarned`]: reward, [`${path}.totalPlays`]: 1 },
      });

      return res.status(200).json({ success: true, source, reward, game: gameKey });
    }

    return res.status(400).json({ error: 'Invalid action. Use: status | play' });
  } catch (err) {
    console.error('minigame.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
