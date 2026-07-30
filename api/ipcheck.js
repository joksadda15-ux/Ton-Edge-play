// FILE PATH: api/ipcheck.js

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

// One Telegram account per IP address, mirrors the "Mining Buddies" style
// anti-multi-accounting screen. First account seen on an IP "owns" it.
// A different account opening from that same IP is blocked and shown who
// owns it, with the option to force-claim the IP for themselves — capped
// at MAX_SWITCHES per account, and every switch zeroes that account's
// Gold/EG balance as the stated penalty.
const MAX_SWITCHES = 2;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query?.telegramId || req.body?.telegramId;
  const initData   = req.query?.initData   || req.body?.initData || '';
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  const tgId = String(telegramId);
  const ip = getClientIp(req);
  // Unknown/local IPs (dev environments, some proxies) skip enforcement
  // entirely rather than falsely locking everyone to one bucket.
  if (!ip || ip === 'unknown') return res.status(200).json({ success: true, conflict: false });

  try {
    const db = await getDb();
    const users = db.collection('users');
    const ipRegistry = db.collection('ipRegistry');

    const user = await users.findOne({ telegramId: tgId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (req.method === 'GET') {
      const existing = await ipRegistry.findOne({ ip });
      if (!existing) {
        await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: tgId, updatedAt: new Date() } }, { upsert: true });
        return res.status(200).json({ success: true, conflict: false });
      }
      if (existing.telegramId === tgId) {
        await ipRegistry.updateOne({ ip }, { $set: { updatedAt: new Date() } });
        return res.status(200).json({ success: true, conflict: false });
      }
      // IP belongs to a different account.
      const owner = await users.findOne(
        { telegramId: existing.telegramId },
        { projection: { firstName: 1, username: 1, telegramId: 1 } }
      );
      return res.status(200).json({
        success: true,
        conflict: true,
        owner: owner ? { firstName: owner.firstName, username: owner.username, telegramId: owner.telegramId } : null,
        switchesLeft: Math.max(0, MAX_SWITCHES - (user.ipSwitchCount || 0)),
      });
    }

    if (req.method === 'POST') {
      const { action } = req.body;
      if (action !== 'switch') return res.status(400).json({ error: 'Invalid action' });

      const switchesUsed = user.ipSwitchCount || 0;
      if (switchesUsed >= MAX_SWITCHES) {
        return res.status(403).json({ error: 'No account switches remaining for this account.' });
      }

      const existing = await ipRegistry.findOne({ ip });
      if (existing && existing.telegramId === tgId) {
        return res.status(200).json({ success: true, alreadyOwner: true });
      }

      // Penalty: zeroing balance + claiming the IP happen together so a
      // retry after a partial failure can't skip the penalty.
      const updated = await users.findOneAndUpdate(
        { telegramId: tgId, ipSwitchCount: { $lt: MAX_SWITCHES } },
        { $set: { goldBalance: 0, egBalance: 0 }, $inc: { ipSwitchCount: 1 } },
        { returnDocument: 'after' }
      );
      if (!updated?.value && !updated) {
        return res.status(403).json({ error: 'No account switches remaining for this account.' });
      }

      await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: tgId, updatedAt: new Date() } }, { upsert: true });

      return res.status(200).json({ success: true, switchesLeft: Math.max(0, MAX_SWITCHES - (switchesUsed + 1)) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('ipcheck.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
