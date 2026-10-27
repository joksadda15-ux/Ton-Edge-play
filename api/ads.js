// FILE PATH: api/ads.js
// (GitHub repo te ei path e file ta rakhbe: api/ads.js)

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';
import crypto from 'crypto';
import { refCheck } from '../lib/refReward.js';
import { detectBotPattern, lockForBotPattern, AD_CLAIM_HISTORY_KEEP } from '../lib/botGuard.js';

// Anti-cheat (ported from NEWTUBE): the app must call action:'start' when an ad is tapped; the server signs
// the start time. A claim is only paid if the signed token is genuine, one-time, fresh, and the ad was on screen long enough.
const MIN_WATCH_SECONDS = 10;     // min ad on-screen time
const VIEW_TOLERANCE_SECONDS = 1.5;
const COOLDOWN_SECONDS = 10;      // min gap between two claims
const TOKEN_MAX_AGE_SECONDS = 300;
const signStart = (tgId, network, t) =>
  crypto.createHmac('sha256', crypto.createHash('sha256').update('adtoken:' + process.env.BOT_TOKEN).digest()).update(`${tgId}:${network}:${t}`).digest('hex');

// Play → Ad Tasks. Each network has its own daily watch limit and MM$
// reward per ad (50,000 MM$ = $1). Counters reset every day at Bangladesh midnight (bdTodayKey).
const AD_NETWORKS = {
  gigapub:       { label: 'GigaPub Ads',        limit: 5,  reward: 10 },
  adsgram_init:  { label: 'AdsGram Ads',        limit: 5,  reward: 10 },

  // ===== Tasks → Daily ads (EDIT HERE: limit = times per day, reward = MM$ per ad) =====
  // Adsgram Task block (task-56002): user completes an Adsgram task, no video view time needed.
  daily_adsgram_task: { label: 'Adsgram Task', limit: 10, reward: 40, minWatch: 3, noView: true, tokenMaxAge: 1800, s2s: true },
  // GigaPub rewarded ad
  daily_gigapub:      { label: 'GigaPub Ad',   limit: 10, reward: 20 },
  // Adsgram rewarded video (block id 37275)
  daily_adsgram:      { label: 'Adsgram Ad',   limit: 10, reward: 20, s2s: true },
  // =====================================================================================
};


// ===== ADSGRAM S2S (server-to-server reward confirmation) =====
// Adsgram calls  GET /api/ads?s2s=1&network=<network>&userid=[userId]&secret=<ADSGRAM_S2S_SECRET>  after a user finishes an ad.
// We store one "credit". The app can only be paid for an Adsgram ad when a fresh credit from Adsgram exists for that user.
// Env (Render):  ADSGRAM_S2S_SECRET = any long random text (also written inside the Reward URL in the Adsgram dashboard)
//                ADSGRAM_S2S_OFF    = optional, comma list of networks to NOT enforce, e.g. daily_adsgram_task
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const s2sEnforced = (network, cfg) =>
  !!(cfg.s2s && process.env.ADSGRAM_S2S_SECRET &&
     !String(process.env.ADSGRAM_S2S_OFF || '').split(',').map(v => v.trim()).includes(network));
let s2sIndexDone = false;
async function handleS2S(req, res) {
  const secret = process.env.ADSGRAM_S2S_SECRET;
  if (!secret) return res.status(503).json({ error: 's2s_not_configured' });
  if (!safeEq(req.query.secret || '', secret)) return res.status(403).json({ error: 'forbidden' });
  const network = String(req.query.network || '');
  const cfg = AD_NETWORKS[network];
  if (!cfg || !cfg.s2s) return res.status(400).json({ error: 'invalid_network' });
  const userid = String(req.query.userid || '');
  if (!/^\d{3,15}$/.test(userid)) return res.status(400).json({ error: 'invalid_userid' });
  const db = await getDb();
  const col = db.collection('adsgramS2S');
  if (!s2sIndexDone) { s2sIndexDone = true; col.createIndex({ at: 1 }, { expireAfterSeconds: 86400 }).catch(() => {}); } // credits auto-delete after 1 day
  const open = await col.countDocuments({ telegramId: userid, network, used: false });
  if (open >= 20) return res.status(200).json({ ok: true, ignored: true });
  await col.insertOne({ telegramId: userid, network, used: false, at: new Date() });
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query?.s2s) {
    try { return await handleS2S(req, res); }
    catch (err) { console.error('ads s2s error:', err); return res.status(500).json({ error: 'Server error' }); }
  }

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

    const { network, action, startTime, signature, viewMs } = req.body;
    const cfg = AD_NETWORKS[network];
    if (!cfg) return res.status(400).json({ error: 'Invalid network' });
    if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });

    // step 1: tap -> server issues a signed start token
    if (action === 'start') {
      const t = Date.now();
      return res.status(200).json({ success: true, startTime: t, signature: signStart(tgId, network, t) });
    }

    // step 2: claim -> verify token, timing, cooldown, bot pattern
    if (!startTime || !signature) return res.status(400).json({ error: 'missing_ad_token' });
    const startNum = Number(startTime);
    if (signStart(tgId, network, startNum) !== signature) return res.status(400).json({ error: 'invalid_ad_token' });
    const elapsed = (Date.now() - startNum) / 1000;
    if (!(elapsed >= 0)) return res.status(400).json({ error: 'invalid_ad_token' });
    const maxAge = cfg.tokenMaxAge || TOKEN_MAX_AGE_SECONDS;
    const minWatch = cfg.minWatch || MIN_WATCH_SECONDS;
    if (elapsed > maxAge) return res.status(400).json({ error: 'ad_token_expired' });
    if (elapsed < minWatch) return res.status(400).json({ error: 'watch_time_too_short' });
    const view = Number(viewMs) / 1000;
    if (!cfg.noView) {
      if (!Number.isFinite(view) || view < MIN_WATCH_SECONDS) return res.status(400).json({ error: 'watch_time_too_short' });
      if (view > elapsed + VIEW_TOLERANCE_SECONDS) return res.status(400).json({ error: 'invalid_view_time' });
    }
    if (user.lastAdClaimAt && Date.now() - new Date(user.lastAdClaimAt).getTime() < COOLDOWN_SECONDS * 1000)
      return res.status(400).json({ error: 'ad_cooldown' });

    const sample = { s: startNum, c: Date.now(), w: Math.round(elapsed * 10) / 10, v: Math.round((cfg.noView ? elapsed : view) * 10) / 10 };
    if (!cfg.noView) {
      const hit = detectBotPattern([...(user.recentAdClaims || []), sample]);
      if (hit && await lockForBotPattern(db, tgId, hit, `Network: ${network}`, [...(user.recentAdClaims || []), sample]))
        return res.status(403).json({ error: 'account_locked' });
    }

    // Adsgram S2S: only pay when Adsgram's own server confirmed this ad (credit created by handleS2S). Reserve it atomically.
    let credit = null;
    if (s2sEnforced(network, cfg)) {
      const r = await db.collection('adsgramS2S').findOneAndUpdate(
        { telegramId: tgId, network, used: false, at: { $gte: new Date(startNum - 3000) } },
        { $set: { used: true, usedAt: new Date() } },
        { sort: { at: 1 } }
      );
      credit = r?.value || r;
      if (!credit || !credit._id) return res.status(409).json({ error: 's2s_pending' }); // callback not here yet — app retries
    }
    const releaseCredit = () => credit ? db.collection('adsgramS2S').updateOne({ _id: credit._id }, { $set: { used: false } }).catch(() => {}) : null;

    const path = `adTasks.${today}.${network}`;

    // Atomic: only succeeds if today's count for this network is still
    // under the daily limit at the moment of the update.
    const result = await users.findOneAndUpdate(
      {
        telegramId: tgId,
        $and: [
          { $or: [{ [path]: { $exists: false } }, { [path]: { $lt: cfg.limit } }] },
          { $or: [{ lastAdStartUsed: { $exists: false } }, { lastAdStartUsed: { $lt: startNum } }] }, // token is one-time
        ],
      },
      {
        $inc: { egBalance: cfg.reward, [path]: 1, totalAdsWatched: 1, ...(network === 'daily_adsgram_task' ? { adsgramTaskTotal: 1 } : {}) },
        $set: { lastAdClaimAt: new Date(), lastAdStartUsed: startNum },
        ...(cfg.noView ? {} : { $push: { recentAdClaims: { $each: [sample], $slice: -AD_CLAIM_HISTORY_KEEP } } }),
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) {
      await releaseCredit();
      return res.status(400).json({ error: `Daily limit reached for ${cfg.label}` });
    }
    const watched = updated.adTasks?.[today]?.[network] || 0;

    // Prune adTasks day-keys older than 30 days — once a day's counters are
    // read here, nothing ever looks at them again, so left alone this
    // object grows by one key per day forever. Cheap: only writes when
    // there's actually something stale (string comparison works because
    // the keys are YYYY-MM-DD, which sorts lexically like a real date).
    const cutoffKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const staleKeys = Object.keys(updated.adTasks || {}).filter(k => k < cutoffKey);
    if (staleKeys.length) {
      const unset = {};
      for (const k of staleKeys) unset[`adTasks.${k}`] = '';
      await users.updateOne({ telegramId: tgId }, { $unset: unset });
    }

    if (network === 'daily_adsgram_task') await refCheck(db, updated); // referral milestone: friend finished 10 Adsgram tasks
    return res.status(200).json({ success: true, reward: cfg.reward, watched, limit: cfg.limit });
  } catch (err) {
    console.error('ads.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
      }
