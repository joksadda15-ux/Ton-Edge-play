import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const TOKEN_REGEN_HOURS = 5;
const MAX_TOKENS = 5;
const ADS_TOKEN_LIMIT = 5;
const NEW_USER_FREE_TOKEN = 1;

function regenTokens(tokens, lastRegen, now) {
  if (!lastRegen || tokens >= MAX_TOKENS) return { tokens, newLastRegen: lastRegen };
  const hoursPassed = (now - new Date(lastRegen)) / 3600000;
  const regenCount = Math.floor(hoursPassed / TOKEN_REGEN_HOURS);
  if (regenCount <= 0) return { tokens, newLastRegen: lastRegen };
  const newTokens = Math.min(MAX_TOKENS, tokens + regenCount);
  const newLastRegen = new Date(new Date(lastRegen).getTime() + regenCount * TOKEN_REGEN_HOURS * 3600000);
  return { tokens: newTokens, newLastRegen };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Support both GET (query) and POST (body)
  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';
  const action     = req.query?.action     || req.body?.action || 'status';

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  if (initData) {
    const tgUser = verifyTelegramInit(initData);
    if (!tgUser || String(tgUser.id) !== String(telegramId))
      return res.status(403).json({ error: 'Invalid session' });
  }

  const tgId = String(telegramId);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ telegramId: tgId });

    // Auto-init gameData for new users
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    const gd = user.gameData || {};
    let tokens = gd.tokens ?? NEW_USER_FREE_TOKEN;

    // Recalculate regen
    const { tokens: regenedTokens, newLastRegen } = regenTokens(tokens, gd.lastTokenRegen, now);
    if (regenedTokens !== tokens) {
      tokens = regenedTokens;
      await users.updateOne({ telegramId: tgId }, {
        $set: { 'gameData.tokens': tokens, 'gameData.lastTokenRegen': newLastRegen }
      });
    }

    // Time until next token
    let nextTokenMs = null;
    if (tokens < MAX_TOKENS) {
      const base = newLastRegen || gd.lastTokenRegen || now;
      const nextRegen = new Date(new Date(base).getTime() + TOKEN_REGEN_HOURS * 3600000);
      nextTokenMs = Math.max(0, nextRegen - now);
    }

    // ── GET / status ──────────────────────────────────────────
    if (req.method === 'GET' || action === 'status') {
      return res.status(200).json({
        success: true,
        tokens,
        maxTokens: MAX_TOKENS,
        nextTokenMs,
        adsTokensToday: gd.adsTokensToday?.[today] || 0,
        adsTokensLimit: ADS_TOKEN_LIMIT,
        totalGamesPlayed: gd.totalGamesPlayed || 0,
        bestScore: gd.bestScore || 0,
        totalEGEarned: gd.totalEGEarned || 0,
      });
    }

    // ── POST actions ──────────────────────────────────────────
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // play — consume 1 token
    if (action === 'play') {
      if (tokens <= 0) return res.status(400).json({ error: 'No tokens. Watch ads or wait for regen.' });
      const newTokens = tokens - 1;
      const updateData = {
        'gameData.tokens': newTokens,
        'gameData.totalGamesPlayed': (gd.totalGamesPlayed || 0) + 1,
      };
      if (!gd.lastTokenRegen || tokens === MAX_TOKENS) updateData['gameData.lastTokenRegen'] = now;
      await users.updateOne({ telegramId: tgId }, { $set: updateData });
      return res.status(200).json({ success: true, tokens: newTokens });
    }

    // claim — give EG reward after game
    if (action === 'claim') {
      const egEarned = parseFloat(req.body?.egEarned) || 0;
      const kills = parseInt(req.body?.kills) || 0;
      if (egEarned < 0) return res.status(400).json({ error: 'Invalid reward' });
      const reward = Math.min(Math.max(Math.round(egEarned), 0), 50); // max 50 EG/game
      if (reward <= 0) return res.status(200).json({ success: true, reward: 0 });
      const bestScore = Math.max(gd.bestScore || 0, reward);
      await users.updateOne({ telegramId: tgId }, {
        $inc: { egBalance: reward, 'gameData.totalEGEarned': reward },
        $set: { 'gameData.bestScore': bestScore, 'gameData.lastPlayed': now }
      });
      return res.status(200).json({ success: true, reward });
    }

    // adtoken — give +1 token after ad
    if (action === 'adtoken') {
      const todayAds = gd.adsTokensToday?.[today] || 0;
      if (todayAds >= ADS_TOKEN_LIMIT)
        return res.status(400).json({ error: `Daily ad token limit (${ADS_TOKEN_LIMIT}) reached.` });
      if (tokens >= MAX_TOKENS)
        return res.status(400).json({ error: 'Token storage full. Play a game first.' });
      const newTokens = Math.min(MAX_TOKENS, tokens + 1);
      await users.updateOne({ telegramId: tgId }, {
        $set: {
          'gameData.tokens': newTokens,
          [`gameData.adsTokensToday.${today}`]: todayAds + 1,
        }
      });
      return res.status(200).json({ success: true, tokens: newTokens, adsToday: todayAds + 1 });
    }

    return res.status(400).json({ error: 'Invalid action. Use: status | play | claim | adtoken' });
  } catch (err) {
    console.error('game.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
