// FILE PATH: api/farm.js
// (GitHub repo te ei path e file ta rakhbe: api/farm.js)
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

// ===== EDIT HERE: farm settings (50,000 MM$ = $1) =====
const SLOT_PRICES = [0, 500, 1500, 4000, 10000, 25000]; // MM$ to unlock plot 1..6 (plot 1 is free)
const CROPS = { carrot: { name: 'Carrot', emoji: '🥕', growSec: 4 * 3600, reward: 8 } };
const DEFAULT_CROP = 'carrot';
// ======================================================

const SLOTS = SLOT_PRICES.length;
const freshSlots = () => Array.from({ length: SLOTS }, (_, i) => ({ unlocked: i === 0, crop: null, plantedAt: null }));

const view = (farm) => ({
  now: Date.now(),
  prices: SLOT_PRICES,
  crops: CROPS,
  defaultCrop: DEFAULT_CROP,
  slots: farm.slots.map((s) => {
    const c = s.crop && CROPS[s.crop];
    const planted = s.plantedAt ? new Date(s.plantedAt).getTime() : null;
    return { unlocked: !!s.unlocked, crop: s.crop || null, readyAt: c && planted ? planted + c.growSec * 1000 : null };
  }),
});

export default async function handler(req, res) {
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

  if (!user.farm?.slots || user.farm.slots.length !== SLOTS) {
    await users.updateOne({ telegramId: tgId, 'farm.slots': { $exists: false } }, { $set: { farm: { slots: freshSlots() } } });
    user = await users.findOne({ telegramId: tgId });
  }
  if (req.method === 'GET') return res.status(200).json({ success: true, farm: view(user.farm) });

  const { action } = req.body || {};
  const i = parseInt(req.body?.slot, 10);
  if (!(i >= 0 && i < SLOTS)) return res.status(400).json({ error: 'Invalid plot' });
  const p = `farm.slots.${i}`;
  let reward = 0;

  if (action === 'unlock') {
    const price = SLOT_PRICES[i];
    if (i === 0 || !user.farm.slots[i - 1].unlocked) return res.status(400).json({ error: 'Unlock the previous plot first' });
    const r = await users.updateOne(
      { telegramId: tgId, [`${p}.unlocked`]: { $ne: true }, egBalance: { $gte: price } },
      { $inc: { egBalance: -price }, $set: { [`${p}.unlocked`]: true } }
    );
    if (!r.modifiedCount) return res.status(400).json({ error: 'Not enough MM$ (or already unlocked)' });
  } else if (action === 'plant') {
    const crop = req.body?.crop || DEFAULT_CROP;
    if (!CROPS[crop]) return res.status(400).json({ error: 'Unknown crop' });
    const r = await users.updateOne(
      { telegramId: tgId, [`${p}.unlocked`]: true, [`${p}.crop`]: null },
      { $set: { [`${p}.crop`]: crop, [`${p}.plantedAt`]: new Date() } }
    );
    if (!r.modifiedCount) return res.status(400).json({ error: 'Plot is not free' });
  } else if (action === 'harvest') {
    const s = user.farm.slots[i];
    const c = s.crop && CROPS[s.crop];
    if (!c) return res.status(400).json({ error: 'Nothing planted' });
    if (Date.now() < new Date(s.plantedAt).getTime() + c.growSec * 1000) return res.status(400).json({ error: 'Not ready yet' });
    const r = await users.updateOne(
      { telegramId: tgId, [`${p}.crop`]: s.crop, [`${p}.plantedAt`]: s.plantedAt },
      { $set: { [`${p}.crop`]: null, [`${p}.plantedAt`]: null }, $inc: { egBalance: c.reward, farmHarvests: 1 } }
    );
    if (!r.modifiedCount) return res.status(400).json({ error: 'Already harvested' });
    reward = c.reward;
  } else return res.status(400).json({ error: 'Unknown action' });

  user = await users.findOne({ telegramId: tgId });
  return res.status(200).json({ success: true, reward, farm: view(user.farm) });
}
