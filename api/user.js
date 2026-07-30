// FILE PATH: api/user.js
//
// Handles /api/user (register / fetch / heartbeat) plus two small
// action-routed extras that used to be their own files:
//   ?action=checkjoin  — GET,  was api/user/checkjoin.js
//   ?action=ipcheck    — GET,  was api/ipcheck.js
//   ?action=ipswitch   — POST, was the POST branch of api/ipcheck.js
// Merged in because Vercel's free (Hobby) plan caps a project at 12
// serverless functions total — every file under /api counts as one,
// so folding related small endpoints into the file they're closest to
// keeps headroom for future features instead of burning a slot each time.

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = '@ton_edge_play';
const COMMUNITY = '@ton_edge_community';
const MAX_IP_SWITCHES = 2;

async function checkMembership(userId, chatUsername) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatUsername)}&user_id=${userId}`
    );
    if (!r.ok) return false;
    const data = await r.json();
    if (!data.ok) return false;
    const status = data.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

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

  const action = req.query?.action || req.body?.action;

  try {
    const db = await getDb();
    const users = db.collection('users');

    // ── GET /api/user?action=checkjoin ─────────────────────────
    if (req.method === 'GET' && action === 'checkjoin') {
      const telegramId = req.query.telegramId;
      const initData = req.query.initData || '';
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      try {
        const [channel, community] = await Promise.all([
          checkMembership(telegramId, CHANNEL),
          checkMembership(telegramId, COMMUNITY),
        ]);
        return res.status(200).json({
          joined: channel && community,
          channel,
          community,
          telegramId: String(telegramId),
          checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error('checkjoin error:', err);
        return res.status(200).json({ joined: false, channel: false, community: false, error: 'Check failed' });
      }
    }

    // ── GET /api/user?action=ipcheck ───────────────────────────
    if (req.method === 'GET' && action === 'ipcheck') {
      const telegramId = req.query.telegramId;
      const initData = req.query.initData || '';
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const tgId = String(telegramId);
      const ip = getClientIp(req);
      if (!ip || ip === 'unknown') return res.status(200).json({ success: true, conflict: false });

      const user = await users.findOne({ telegramId: tgId });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const ipRegistry = db.collection('ipRegistry');
      const existing = await ipRegistry.findOne({ ip });
      if (!existing) {
        await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: tgId, updatedAt: new Date() } }, { upsert: true });
        return res.status(200).json({ success: true, conflict: false });
      }
      if (existing.telegramId === tgId) {
        await ipRegistry.updateOne({ ip }, { $set: { updatedAt: new Date() } });
        return res.status(200).json({ success: true, conflict: false });
      }
      const owner = await users.findOne(
        { telegramId: existing.telegramId },
        { projection: { firstName: 1, username: 1, telegramId: 1 } }
      );
      return res.status(200).json({
        success: true,
        conflict: true,
        owner: owner ? { firstName: owner.firstName, username: owner.username, telegramId: owner.telegramId } : null,
        switchesLeft: Math.max(0, MAX_IP_SWITCHES - (user.ipSwitchCount || 0)),
      });
    }

    // ── POST /api/user  {action:'ipswitch'} ────────────────────
    if (req.method === 'POST' && action === 'ipswitch') {
      const { telegramId, initData } = req.body;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }
      const tgId = String(telegramId);
      const ip = getClientIp(req);
      if (!ip || ip === 'unknown') return res.status(400).json({ error: 'Could not determine connection.' });

      const user = await users.findOne({ telegramId: tgId });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const switchesUsed = user.ipSwitchCount || 0;
      if (switchesUsed >= MAX_IP_SWITCHES) {
        return res.status(403).json({ error: 'No account switches remaining for this account.' });
      }

      const ipRegistry = db.collection('ipRegistry');
      const existing = await ipRegistry.findOne({ ip });
      if (existing && existing.telegramId === tgId) {
        return res.status(200).json({ success: true, alreadyOwner: true });
      }

      const updated = await users.findOneAndUpdate(
        { telegramId: tgId, ipSwitchCount: { $lt: MAX_IP_SWITCHES } },
        { $set: { goldBalance: 0, egBalance: 0 }, $inc: { ipSwitchCount: 1 } },
        { returnDocument: 'after' }
      );
      if (!updated?.value && !updated) {
        return res.status(403).json({ error: 'No account switches remaining for this account.' });
      }

      await ipRegistry.updateOne({ ip }, { $set: { ip, telegramId: tgId, updatedAt: new Date() } }, { upsert: true });
      return res.status(200).json({ success: true, switchesLeft: Math.max(0, MAX_IP_SWITCHES - (switchesUsed + 1)) });
    }

    // ── GET /api/user?telegramId=xxx ───────────────────────────
    if (req.method === 'GET') {
      const { telegramId, initData } = req.query;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const user = await users.findOne(
        { telegramId: String(telegramId) },
        { projection: { _id: 0 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ success: true, user });
    }

    // ── POST /api/user  (register / app-open heartbeat) ───────────
    if (req.method === 'POST') {
      const { telegramId, username, firstName, referCode, initData } = req.body;

      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const tgId = String(telegramId);
      const existing = await users.findOne({ telegramId: tgId });

      if (existing) {
        const updated = await users.findOneAndUpdate(
          { telegramId: tgId },
          { $set: { lastActive: new Date() }, $inc: { appOpens: 1 } },
          { returnDocument: 'after' }
        );
        const userDoc = updated?.value || updated;
        return res.status(200).json({ success: true, user: userDoc, isNew: false });
      }

      const myReferCode =
        'TEP' + tgId.slice(-5) + Math.random().toString(36).slice(2, 5).toUpperCase();

      const newUser = {
        telegramId: tgId,
        username: username || '',
        firstName: firstName || 'User',
        goldBalance: 0,
        egBalance: 0,
        referCode: myReferCode,
        referredBy: null,
        totalReferred: 0,
        totalRefEarned: 0,
        totalRefEarnedEG: 0,
        dailyClaimLast: null,
        tree: { lastHarvest: null, totalHarvests: 0, totalGold: 0 },
        adTasks: {},
        totalAdsWatched: 0,
        completedTasks: [],
        promosUsed: [],
        isBanned: false,
        appOpens: 1,
        withdrawPending: false,
        ipSwitchCount: 0,
        createdAt: new Date(),
        lastActive: new Date(),
      };

      if (referCode) {
        const referrer = await users.findOne({ referCode });
        if (referrer && referrer.telegramId !== tgId) {
          newUser.referredBy = referrer.telegramId;
          await users.updateOne(
            { telegramId: referrer.telegramId },
            { $inc: { goldBalance: 500, totalRefEarned: 500, totalReferred: 1 } }
          );
        }
      }

      await users.insertOne(newUser);
      return res.status(200).json({ success: true, user: newUser, isNew: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('user.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
                                    }
