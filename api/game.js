import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const TOKEN_REGEN_HOURS = 5;     // 1 token every 5 hours
const MAX_TOKENS = 5;             // max stored tokens
const ADS_TOKEN_LIMIT = 5;       // max tokens from ads per day
const NEW_USER_FREE_TOKEN = 1;    // free token on signup

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');

  const { telegramId, initData, action } = req.body || {};
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  if (initData) {
    const tgUser = verifyTelegramInit(initData);
    if (!tgUser || String(tgUser.id) !== String(telegramId))
      return res.status(403).json({ error: 'Invalid session' });
  }

  const tgId = String(telegramId);

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // ── GET status ────────────────────────────────────────────
    if (req.method === 'GET' || action === 'status') {
      const gameData = user.gameData || {};
      let tokens = gameData.tokens ?? NEW_USER_FREE_TOKEN;
      const lastRegen = gameData.lastTokenRegen ? new Date(gameData.lastTokenRegen) : null;

      // Calculate regenerated tokens since last check
      if (lastRegen && tokens < MAX_TOKENS) {
        const hoursPassed = (now - lastRegen) / 3600000;
        const regenTokens = Math.floor(hoursPassed / TOKEN_REGEN_HOURS);
        if (regenTokens > 0) {
          tokens = Math.min(MAX_TOKENS, tokens + regenTokens);
          const newLastRegen = new Date(lastRegen.getTime() + regenTokens * TOKEN_REGEN_HOURS * 3600000);
          await users.updateOne({ telegramId: tgId }, {
            $set: { 'gameData.tokens': tokens, 'gameData.lastTokenRegen': newLastRegen }
          });
        }
      }

      // Time until next token
      let nextTokenMs = null;
      if (tokens < MAX_TOKENS) {
        const base = lastRegen || now;
        const nextRegen = new Date(base.getTime() + TOKEN_REGEN_HOURS * 3600000);
        nextTokenMs = Math.max(0, nextRegen - now);
      }

      return res.status(200).json({
        success: true,
        tokens,
        maxTokens: MAX_TOKENS,
        nextTokenMs,
        adsTokensToday: gameData.adsTokensToday?.[today] || 0,
        adsTokensLimit: ADS_TOKEN_LIMIT,
        totalGamesPlayed: gameData.totalGamesPlayed || 0,
        bestScore: gameData.bestScore || 0,
      });
    }

    // ── USE token to play ─────────────────────────────────────
    if (action === 'play') {
      const gameData = user.gameData || {};
      let tokens = gameData.tokens ?? NEW_USER_FREE_TOKEN;

      // Recalc regen
      const lastRegen = gameData.lastTokenRegen ? new Date(gameData.lastTokenRegen) : null;
      if (lastRegen && tokens < MAX_TOKENS) {
        const regenTokens = Math.floor((now - lastRegen) / (TOKEN_REGEN_HOURS * 3600000));
        if (regenTokens > 0) tokens = Math.min(MAX_TOKENS, tokens + regenTokens);
      }

      if (tokens <= 0) return res.status(400).json({ error: 'No tokens. Watch ads or wait for regen.' });

      const newTokens = tokens - 1;
      const updateData = { 'gameData.tokens': newTokens, 'gameData.totalGamesPlayed': (gameData.totalGamesPlayed || 0) + 1 };
      // Set regen timer if tokens were full
      if (tokens === MAX_TOKENS || !lastRegen) {
        updateData['gameData.lastTokenRegen'] = now;
      }

      await users.updateOne({ telegramId: tgId }, { $set: updateData });
      return res.status(200).json({ success: true, tokens: newTokens, canPlay: true });
    }

    // ── CLAIM game EG reward ──────────────────────────────────
    if (action === 'claim') {
      const { egEarned, kills } = req.body;
      if (!egEarned || egEarned < 0) return res.status(400).json({ error: 'Invalid reward' });

      // Cap max reward per game to prevent abuse (max ~50 EG)
      const cappedEG = Math.min(Math.round(egEarned * 10), 50);
      if (cappedEG <= 0) return res.status(200).json({ success: true, reward: 0 });

      const gameData = user.gameData || {};
      const bestScore = Math.max(gameData.bestScore || 0, cappedEG);

      await users.updateOne(
        { telegramId: tgId },
        {
          $inc: { egBalance: cappedEG },
          $set: { 'gameData.bestScore': bestScore, 'gameData.lastPlayed': now }
        }
      );

      return res.status(200).json({ success: true, reward: cappedEG });
    }

    // ── Watch ad to earn token ────────────────────────────────
    if (action === 'adtoken') {
      const gameData = user.gameData || {};
      const todayAds = gameData.adsTokensToday?.[today] || 0;

      if (todayAds >= ADS_TOKEN_LIMIT)
        return res.status(400).json({ error: `Daily ad token limit (${ADS_TOKEN_LIMIT}) reached.` });

      let tokens = gameData.tokens ?? NEW_USER_FREE_TOKEN;
      if (tokens >= MAX_TOKENS)
        return res.status(400).json({ error: 'Token storage full. Play first.' });

      const newTokens = Math.min(MAX_TOKENS, tokens + 1);
      await users.updateOne(
        { telegramId: tgId },
        {
          $set: {
            'gameData.tokens': newTokens,
            [`gameData.adsTokensToday.${today}`]: todayAds + 1
          }
        }
      );

      return res.status(200).json({ success: true, tokens: newTokens, adsToday: todayAds + 1 });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('game.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
