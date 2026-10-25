// FILE PATH: api/farm.js
// Farming: 6 farms, each pays a fixed MM$ reward once per cycle.
// Farm 1 is free, farms 2-6 are bought with MM$. Every claim needs one ad (GigaPub / AdsGram).
import crypto from 'crypto';
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { bdTodayKey } from '../lib/dateUtils.js';
import { detectBotPattern, lockForBotPattern, AD_CLAIM_HISTORY_KEEP } from '../lib/botGuard.js';

// ===== EDIT HERE: farm settings (50,000 MM$ = $1) =====
// hours = how often you can claim, reward = MM$ per claim, price = MM$ to buy (0 = free)
const FARMS = [
  { name: 'Farm 1', hours: 1,  reward: 30,  price: 0 },
  { name: 'Farm 2', hours: 2,  reward: 50,  price: 250 },
  { name: 'Farm 3', hours: 4,  reward: 100, price: 750 },
  { name: 'Farm 4', hours: 6,  reward: 200, price: 2000 },
  { name: 'Farm 5', hours: 8,  reward: 300, price: 5000 },
  { name: 'Farm 6', hours: 12, reward: 500, price: 12500 },
];
const AD_NETWORKS = ['gigapub', 'adsgram_init'];
// ======================================================

// Ad anti-cheat (same rules as api/ads.js)
const MIN_WATCH_SECONDS = 10;
const VIEW_TOLERANCE_SECONDS = 1.5;
const COOLDOWN_SECONDS = 10;
const TOKEN_MAX_AGE_SECONDS = 300;
const signStart = (tgId, key, t) =>
  crypto.createHmac('sha256', crypto.createHash('sha256').update('adtoken:' + process.env.BOT_TOKEN).digest()).update(`${tgId}:${key}:${t}`).digest('hex');

const N = FARMS.length;

const freshSlots = (old) =>
  FARMS.map((f, i) => ({
    // users who bought a plot in the old plot system keep the matching farm unlocked
    unlocked: f.price === 0 || !!old?.[i]?.unlocked,
    nextClaimAt: null, // null = ready to claim now
  }));

const view = (farm) => ({
  now: Date.now(),
  farms: FARMS.map((f, i) => {
    const s = farm.slots[i] || {};
    return {
      id: i,
      name: f.name,
      hours: f.hours,
      reward: f.reward,
      price: f.price,
      unlocked: !!s.unlocked,
      readyAt: s.nextClaimAt ? new Date(s.nextClaimAt).getTime() : 0,
    };
  }),
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData = req.query?.initData || req.body?.initData || '';
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) return res.status(403).json({ error: 'Invalid Telegram session' });

  const tgId = String(telegramId);
  const db = await getDb();
  const users = db.collection('users');
  let user = await users.findOne({ telegramId: tgId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

  if (!user.farm2?.slots || user.farm2.slots.length !== N) {
    await users.updateOne(
      { telegramId: tgId, $or: [{ 'farm2.slots': { $exists: false } }, { 'farm2.slots': { $size: 0 } }] },
      { $set: { farm2: { slots: freshSlots(user.farm?.slots) } } }
    );
    user = await users.findOne({ telegramId: tgId });
  }
  if (req.method === 'GET') return res.status(200).json({ success: true, farm: view(user.farm2) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  const i = parseInt(req.body?.slot, 10);
  if (!(i >= 0 && i < N)) return res.status(400).json({ error: 'Invalid farm' });
  const cfg = FARMS[i];
  const p = `farm2.slots.${i}`;

  // ── buy a farm ──────────────────────────────────────────────
  if (action === 'unlock') {
    if (cfg.price <= 0) return res.status(400).json({ error: 'This farm is already free' });
    const r = await users.updateOne(
      { telegramId: tgId, [`${p}.unlocked`]: { $ne: true }, egBalance: { $gte: cfg.price } },
      { $inc: { egBalance: -cfg.price }, $set: { [`${p}.unlocked`]: true, [`${p}.nextClaimAt`]: null } }
    );
    if (!r.modifiedCount) return res.status(400).json({ error: 'Not enough MM$ (or already bought)' });
    user = await users.findOne({ telegramId: tgId });
    return res.status(200).json({ success: true, balance: user.egBalance, farm: view(user.farm2) });
  }

  // ── claim step 1: tap → server checks the farm is ready and signs a start token ──
  if (action === 'start' || action === 'claim') {
    if (user.accountLocked) return res.status(403).json({ error: 'account_locked' });
    const slot = user.farm2.slots[i];
    if (!slot?.unlocked) return res.status(400).json({ error: 'Buy this farm first' });
    const readyAt = slot.nextClaimAt ? new Date(slot.nextClaimAt).getTime() : 0;
    if (Date.now() < readyAt) return res.status(400).json({ error: 'Not ready yet' });

    const network = req.body?.network;
    if (!AD_NETWORKS.includes(network)) return res.status(400).json({ error: 'Invalid network' });
    const tokenKey = `farm${i}:${network}`;

    if (action === 'start') {
      const t = Date.now();
      return res.status(200).json({ success: true, startTime: t, signature: signStart(tgId, tokenKey, t) });
    }

    // ── claim step 2: verify the ad token + timing, then pay ──
    const { startTime, signature, viewMs } = req.body;
    if (!startTime || !signature) return res.status(400).json({ error: 'missing_ad_token' });
    const startNum = Number(startTime);
    if (signStart(tgId, tokenKey, startNum) !== signature) return res.status(400).json({ error: 'invalid_ad_token' });
    const elapsed = (Date.now() - startNum) / 1000;
    if (!(elapsed >= 0)) return res.status(400).json({ error: 'invalid_ad_token' });
    if (elapsed > TOKEN_MAX_AGE_SECONDS) return res.status(400).json({ error: 'ad_token_expired' });
    if (elapsed < MIN_WATCH_SECONDS) return res.status(400).json({ error: 'watch_time_too_short' });
    const viewSec = Number(viewMs) / 1000;
    if (!Number.isFinite(viewSec) || viewSec < MIN_WATCH_SECONDS) return res.status(400).json({ error: 'watch_time_too_short' });
    if (viewSec > elapsed + VIEW_TOLERANCE_SECONDS) return res.status(400).json({ error: 'invalid_view_time' });
    if (user.lastAdClaimAt && Date.now() - new Date(user.lastAdClaimAt).getTime() < COOLDOWN_SECONDS * 1000)
      return res.status(400).json({ error: 'ad_cooldown' });

    const sample = { s: startNum, c: Date.now(), w: Math.round(elapsed * 10) / 10, v: Math.round(viewSec * 10) / 10 };
    const hit = detectBotPattern([...(user.recentAdClaims || []), sample]);
    if (hit && (await lockForBotPattern(db, tgId, hit, `Farm ${i + 1} · ${network}`, [...(user.recentAdClaims || []), sample])))
      return res.status(403).json({ error: 'account_locked' });

    const now = new Date();
    const today = bdTodayKey();
    // Atomic: pays only if the farm is still unlocked + ready, and the ad token was never used before.
    const result = await users.findOneAndUpdate(
      {
        telegramId: tgId,
        [`${p}.unlocked`]: true,
        $and: [
          { $or: [{ [`${p}.nextClaimAt`]: null }, { [`${p}.nextClaimAt`]: { $lte: now } }] },
          { $or: [{ lastAdStartUsed: { $exists: false } }, { lastAdStartUsed: { $lt: startNum } }] },
        ],
      },
      {
        // adTasks counter keeps the "ads watched today" number used by the withdraw requirement
        $inc: { egBalance: cfg.reward, farmClaims: 1, totalAdsWatched: 1, [`adTasks.${today}.${network}`]: 1 },
        $set: { [`${p}.nextClaimAt`]: new Date(now.getTime() + cfg.hours * 3600 * 1000), lastAdClaimAt: now, lastAdStartUsed: startNum },
        // farmClaimTimes = exact time of each farm claim; api/withdraw.js needs 3 of them inside the last 3 hours
        $push: { recentAdClaims: { $each: [sample], $slice: -AD_CLAIM_HISTORY_KEEP }, farmClaimTimes: { $each: [Date.now()], $slice: -20 } },
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;
    if (!updated) return res.status(400).json({ error: 'Already claimed or not ready' });

    // drop day-counters older than 30 days so the object does not grow forever
    const cutoffKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const stale = Object.keys(updated.adTasks || {}).filter((k) => k < cutoffKey);
    if (stale.length) {
      const unset = {};
      for (const k of stale) unset[`adTasks.${k}`] = '';
      await users.updateOne({ telegramId: tgId }, { $unset: unset });
    }
    return res.status(200).json({ success: true, reward: cfg.reward, balance: updated.egBalance, farm: view(updated.farm2) });
  }

  return res.status(400).json({ error: 'Unknown action' });
  }
