// FILE PATH: api/human.js
// 🧑 Human check endpoint (see lib/humanCheck.js).
//   GET  /api/human?telegramId=..&initData=..                         -> { ok, challenge:{ token, question, options } }
//   POST /api/human { telegramId, initData, action:'verify', token, answer } -> { ok:true } or { ok:false, error, challenge }
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { makeChallenge, checkAnswer, lockForHumanFail, HUMAN } from '../lib/humanCheck.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const telegramId = src.telegramId;
  const tg = verifyTelegramInit(src.initData || '');
  if (!telegramId || !tg || String(tg.id) !== String(telegramId)) return res.status(403).json({ ok: false, error: 'Invalid Telegram session' });
  const tgId = String(telegramId);

  const db = await getDb();
  const users = db.collection('users');
  const user = await users.findOne({ telegramId: tgId }, { projection: { telegramId: 1, username: 1, egBalance: 1, isBanned: 1, accountLocked: 1, humanFails: 1 } });
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  if (user.isBanned) return res.status(403).json({ ok: false, error: 'Account banned' });
  if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked' });

  if (req.method === 'GET') return res.status(200).json({ ok: true, challenge: makeChallenge(tgId) });
  if (req.method !== 'POST' || src.action !== 'verify') return res.status(400).json({ ok: false, error: 'bad_request' });

  const r = checkAnswer(tgId, src.token, src.answer);
  if (r.ok) {
    // each question can be used only once (replay protection): the nonce must differ from the last one used
    const u = await users.updateOne(
      { telegramId: tgId, humanLastNonce: { $ne: r.nonce } },
      { $set: { humanOkAt: new Date(), humanLastNonce: r.nonce, humanFails: 0 }, $unset: { humanRequired: '', humanRequiredAt: '' } }
    );
    if (u.modifiedCount > 0) return res.status(200).json({ ok: true });
    r.ok = false; r.reason = 'wrong';
  }
  // an expired / broken question is not the user's fault: just give a new one
  if (r.reason === 'expired' || r.reason === 'bad_token') return res.status(200).json({ ok: false, error: r.reason, challenge: makeChallenge(tgId) });

  const upd = await users.findOneAndUpdate({ telegramId: tgId }, { $inc: { humanFails: 1 } }, { returnDocument: 'after' });
  const after = upd?.value !== undefined ? upd.value : upd;
  if ((after?.humanFails || 0) >= HUMAN.LOCK_AFTER_FAILS) {
    await lockForHumanFail(db, after);
    return res.status(403).json({ ok: false, error: 'account_locked' });
  }
  return res.status(200).json({ ok: false, error: r.reason, challenge: makeChallenge(tgId) });
}
