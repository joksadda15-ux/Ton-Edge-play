// api/game_claim.js
// POST /api/game_claim
// Called when the player taps "NEXT LEVEL", "2X REWARD (Watch Ad)", or
// "Skip Stage" at the end of a level. This endpoint DID NOT EXIST before —
// index.html was calling a URL with no matching backend file, so every one
// of those buttons was silently failing (this is very likely the cause of
// the "❌ Error Saving Data! Network Error" toast seen in testing).
//
// Body: { isAdWatched: boolean, skip: boolean }
//   isAdWatched -> double the level reward (2X button)
//   skip        -> stage-skip flow, no gold, no token re-check
//
// SECURITY NOTE: the client also sends a `reward` number (left over from
// the old dead call) — we deliberately IGNORE it. The gold amount is
// always computed here, server-side, in the same 40–120 range the
// frontend uses for display, so a devtools/termux user editing the
// request body can never claim more gold than a real playthrough allows.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');

const REWARD_MIN = 40;
const REWARD_MAX = 120; // inclusive, matches index.html's `40 + rand(0..80)`

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, error: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const { isAdWatched, skip } = req.body || {};

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended' });

    // Skip-stage: no gold, just bookkeeping (games-played counter still
    // ticks so referral "valid refer" progress etc. stay meaningful).
    let reward = 0;
    if (!skip) {
      reward = REWARD_MIN + Math.floor(Math.random() * (REWARD_MAX - REWARD_MIN + 1));
      if (isAdWatched === true) reward *= 2;
    }

    const updated = await usersCol.findOneAndUpdate(
      { _id: user._id },
      { $inc: { gold: reward, totalGamesPlayed: 1 }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );

    if (reward > 0) {
      const txCol = await getCollection('transactions');
      await txCol.insertOne({
        telegramId: user.telegramId,
        type: TRANSACTION_TYPES.GAME_REWARD,
        amount: reward,
        balanceAfter: updated.gold,
        meta: { isAdWatched: !!isAdWatched, skip: !!skip },
        createdAt: new Date(),
      });
    }

    return res.status(200).json({
      success: true,
      reward,
      user: {
        gold: updated.gold,
        fruitCoin: updated.fruitCoin,
      },
    });
  } catch (err) {
    console.error('game_claim error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
