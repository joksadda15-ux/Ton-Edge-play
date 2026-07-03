import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import crypto from 'crypto';

const ADS_TOKEN_LIMIT = 5;        // max ad-tokens per rolling 24h
const FREE_PLAY_WINDOW_MS = 24 * 3600000;
const AD_WINDOW_MS = 24 * 3600000;
const CLAIM_MIN_MS = 20 * 1000;   // round is 45s — claim can't arrive faster than this
const CLAIM_MAX_MS = 5 * 60 * 1000; // session expires after 5 min if not claimed

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';
  const action     = req.query?.action     || req.body?.action || 'status';

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  // initData is now REQUIRED, not optional — closes the no-auth bypass
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

    const gd = user.gameData || {};

    // ── Free-play availability (rolling 24h) ──
    const freeLastUsed = gd.freeTokenLastUsed ? new Date(gd.freeTokenLastUsed) : null;
    const freeAvailable = !freeLastUsed || (now - freeLastUsed) >= FREE_PLAY_WINDOW_MS;
    const nextFreeMs = freeAvailable ? 0 : Math.max(0, (freeLastUsed.getTime() + FREE_PLAY_WINDOW_MS) - now.getTime());

    // ── Ad-token window (rolling 24h) ──
    const adWindowStart = gd.adWindowStart ? new Date(gd.adWindowStart) : null;
    const adWindowStale = !adWindowStart || (now - adWindowStart) >= AD_WINDOW_MS;
    const adTokensGrantedInWindow = adWindowStale ? 0 : (gd.adTokensGrantedInWindow || 0);
    const adTokensAvailable = gd.adTokens || 0; // banked ad tokens not yet spent
    const adTokensRemainingToday = Math.max(0, ADS_TOKEN_LIMIT - adTokensGrantedInWindow);

    // ═══════════════════════════════════════════════
    // GET / status
    // ═══════════════════════════════════════════════
    if (req.method === 'GET' || action === 'status') {
      return res.status(200).json({
        success: true,
        freeAvailable,
        nextFreeMs,
        adTokensAvailable,
        adTokensRemainingToday,
        adTokensLimit: ADS_TOKEN_LIMIT,
        totalGamesPlayed: gd.totalGamesPlayed || 0,
        bestScore: gd.bestScore || 0,
        totalEGEarned: gd.totalEGEarned || 0,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ═══════════════════════════════════════════════
    // play — consumes free play first, then a banked ad token.
    // Atomic: filter + update in one op so two simultaneous
    // requests can't both succeed off the same token.
    // Issues a one-time session id that claim must present back.
    // ═══════════════════════════════════════════════
    if (action === 'play') {
      const sessionId = crypto.randomUUID();
      const freeCutoff = new Date(now.getTime() - FREE_PLAY_WINDOW_MS);

      // Try free play
      let result = await users.findOneAndUpdate(
        {
          telegramId: tgId,
          $or: [
            { 'gameData.freeTokenLastUsed': { $exists: false } },
            { 'gameData.freeTokenLastUsed': null },
            { 'gameData.freeTokenLastUsed': { $lte: freeCutoff } },
          ],
        },
        {
          $set: { 'gameData.freeTokenLastUsed': now, 'gameData.activeSession': { id: sessionId, issuedAt: now } },
          $inc: { 'gameData.totalGamesPlayed': 1 },
        },
        { returnDocument: 'after' }
      );

      let source = 'free';

      // Fall back to a banked ad token
      const freeGranted = result?.value || result; // support both driver return shapes
      if (!freeGranted) {
        source = 'ad';
        const adResult = await users.findOneAndUpdate(
          { telegramId: tgId, 'gameData.adTokens': { $gt: 0 } },
          {
            $inc: { 'gameData.adTokens': -1, 'gameData.totalGamesPlayed': 1 },
            $set: { 'gameData.activeSession': { id: sessionId, issuedAt: now } },
          },
          { returnDocument: 'after' }
        );
        const adGranted = adResult?.value || adResult;
        if (!adGranted) {
          return res.status(400).json({ error: 'No plays left. Watch an ad or wait for your free daily play.' });
        }
      }

      return res.status(200).json({ success: true, source, sessionId });
    }

    // ═══════════════════════════════════════════════
    // claim — must present the sessionId issued by `play`.
    // Rejected if: no active session, wrong session id,
    // claimed too fast (< CLAIM_MIN_MS since play), or
    // session expired (> CLAIM_MAX_MS old).
    // Session is cleared atomically on successful claim so
    // it cannot be reused.
    // ═══════════════════════════════════════════════
    if (action === 'claim') {
      const sessionId = req.body?.sessionId;
      const egEarned = parseFloat(req.body?.egEarned) || 0;

      if (!sessionId) return res.status(400).json({ error: 'Missing session' });
      if (egEarned < 0) return res.status(400).json({ error: 'Invalid reward' });

      const session = gd.activeSession;
      if (!session || session.id !== sessionId) {
        return res.status(403).json({ error: 'No matching game session' });
      }
      const elapsed = now.getTime() - new Date(session.issuedAt).getTime();
      if (elapsed < CLAIM_MIN_MS) {
        return res.status(403).json({ error: 'Claim submitted too fast' });
      }
      if (elapsed > CLAIM_MAX_MS) {
        await users.updateOne({ telegramId: tgId }, { $set: { 'gameData.activeSession': null } });
        return res.status(403).json({ error: 'Session expired' });
      }

      const reward = Math.min(Math.max(Math.round(egEarned), 0), 50); // hard cap 50 EG/round
      const bestScore = Math.max(gd.bestScore || 0, reward);

      // Atomic: only succeeds if the session is still the one we just checked
      const claimResult = await users.findOneAndUpdate(
        { telegramId: tgId, 'gameData.activeSession.id': sessionId },
        {
          $inc: { egBalance: reward, 'gameData.totalEGEarned': reward },
          $set: { 'gameData.bestScore': bestScore, 'gameData.lastPlayed': now, 'gameData.activeSession': null },
        },
        { returnDocument: 'after' }
      );
      const claimed = claimResult?.value || claimResult;
      if (!claimed) return res.status(403).json({ error: 'Session already claimed' });

      return res.status(200).json({ success: true, reward });
    }

    // ═══════════════════════════════════════════════
    // adtoken — grants +1 banked ad token, capped per rolling 24h window
    // ═══════════════════════════════════════════════
    if (action === 'adtoken') {
      // Reset window if stale (atomic, only if still stale at write time)
      if (adWindowStale) {
        await users.updateOne(
          {
            telegramId: tgId,
            $or: [
              { 'gameData.adWindowStart': { $exists: false } },
              { 'gameData.adWindowStart': { $lte: new Date(now.getTime() - AD_WINDOW_MS) } },
            ],
          },
          { $set: { 'gameData.adWindowStart': now, 'gameData.adTokensGrantedInWindow': 0 } }
        );
      }

      const result = await users.findOneAndUpdate(
        { telegramId: tgId, 'gameData.adTokensGrantedInWindow': { $lt: ADS_TOKEN_LIMIT } },
        { $inc: { 'gameData.adTokens': 1, 'gameData.adTokensGrantedInWindow': 1 } },
        { returnDocument: 'after' }
      );
      const granted = result?.value || result;
      if (!granted) {
        return res.status(400).json({ error: `Daily ad token limit (${ADS_TOKEN_LIMIT}) reached.` });
      }
      return res.status(200).json({
        success: true,
        adTokensAvailable: granted.gameData.adTokens,
        adTokensGrantedInWindow: granted.gameData.adTokensGrantedInWindow,
      });
    }

    return res.status(400).json({ error: 'Invalid action. Use: status | play | claim | adtoken' });
  } catch (err) {
    console.error('game.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
          }
