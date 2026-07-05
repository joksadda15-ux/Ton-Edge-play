import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';

const BOT_LINK = 'http://t.me/TonEdge_play_bot/playearn';
const BOT_TOKEN = process.env.BOT_TOKEN;

async function isChannelMember(userId, channelLink) {
  // Only works for 'api' type tasks whose link points to a t.me channel.
  const m = String(channelLink || '').match(/t\.me\/([A-Za-z0-9_]+)/);
  if (!m) return null; // not a checkable channel link — caller decides what to do
  const chatId = '@' + m[1];
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`);
    const d = await r.json();
    return ['member', 'administrator', 'creator'].includes(d.result?.status);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const telegramId = req.query.telegramId || req.body?.telegramId;
  const initData = req.query.initData || req.body?.initData;

  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  // initData is now REQUIRED — previously optional, letting anyone read/claim
  // for any telegramId with no proof of identity.
  const tgUser = verifyTelegramInit(initData);
  if (!tgUser || String(tgUser.id) !== String(telegramId)) {
    return res.status(403).json({ error: 'Invalid Telegram session' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const tasksCol = db.collection('tasks');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });

    if (req.method === 'GET') {
      const { type } = req.query;

      if (type === 'refer') {
        const referredUsers = await users
          .find({ referredBy: String(telegramId) })
          .project({ firstName: 1, username: 1, createdAt: 1, _id: 0 })
          .toArray();

        return res.status(200).json({
          success: true,
          referCode: user.referCode,
          referLink: `${BOT_LINK}?startapp=${user.referCode}`,
          totalReferred: user.totalReferred || 0,
          totalRefEarned: user.totalRefEarned || 0,
          referredUsers,
          rewards: { onJoin: 40, onPlanBuy: 80, on20Ads: 120 },
        });
      }

      const allTasks = await tasksCol.find({ active: true }).toArray();
      const completedIds = user.completedTasks || [];
      const result = allTasks.map(t => ({
        id: t.id, title: t.title, reward: t.reward,
        link: t.link, type: t.type,
        completed: completedIds.includes(t.id),
      }));
      return res.status(200).json({ success: true, tasks: result });
    }

    if (req.method === 'POST') {
      const { taskId } = req.body;
      if (!taskId) return res.status(400).json({ error: 'taskId required' });

      const task = await tasksCol.findOne({ id: taskId, active: true });
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // 'api' tasks (e.g. "join our channel") must be verified against
      // Telegram itself before crediting — previously this was never
      // checked, so the reward could be claimed without joining anything.
      if (task.type === 'api') {
        const memberStatus = await isChannelMember(telegramId, task.link);
        if (memberStatus === false) {
          return res.status(400).json({ error: 'Join the channel first, then try again.' });
        }
        // memberStatus === null means the link isn't a checkable t.me channel —
        // falls through and is treated like a 'none' task (trust-based).
      }

      // Atomic claim: only succeeds if this task isn't already in
      // completedTasks. Previously this was a separate read-then-write,
      // so two simultaneous claims for the same task could both succeed
      // and double-credit the reward.
      const result = await users.findOneAndUpdate(
        { telegramId: String(telegramId), completedTasks: { $ne: taskId } },
        { $inc: { egBalance: task.reward }, $push: { completedTasks: taskId } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        return res.status(400).json({ error: 'Task already completed.' });
      }

      return res.status(200).json({ success: true, reward: task.reward });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('tasks.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
                 }
