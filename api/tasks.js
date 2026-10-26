// FILE PATH: api/tasks.js
// (GitHub repo te ei path e file ta rakhbe: api/tasks.js)

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { isMember } from '../lib/tg.js';
import { bdTodayKey } from '../lib/dateUtils.js';

// Pagination (cursor style): the app asks for ONE small page at a time and gets a `nextCursor` back.
//  - never skip(): "give me 20 after this one" uses the index and costs the same on page 1 or page 500
//  - we fetch PAGE+1 rows only to learn if there is a next page, so no countDocuments() is needed
//  - only the fields the screen needs are read (projection)
const PAGE = 20;
const REF_CURSOR = /^\d{10,14}_[a-f0-9]{24}$/;
const ID_CURSOR = /^[a-f0-9]{24}$/;
const TASK_MIN_WAIT_SECONDS = 7; // the app makes people wait 8s before Claim; the server enforces a little less to allow for lag
const signTask = (tgId, taskId, t) =>
  crypto.createHmac('sha256', crypto.createHash('sha256').update('taskstart:' + process.env.BOT_TOKEN).digest()).update(`${tgId}:${taskId}:${t}`).digest('hex');

const BOT_LINK = 'http://t.me/TonEdge_play_bot/playearn';
export default async function handler(req, res) {
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
        // newest first. cursor = "<createdAt ms>_<_id>" of the last row of the previous page
        const q = { referredBy: String(telegramId) };
        const after = String(req.query.after || '');
        if (REF_CURSOR.test(after)) {
          const [ms, oid] = after.split('_');
          const c = new Date(Number(ms)), id = new ObjectId(oid);
          q.$or = [{ createdAt: { $lt: c } }, { createdAt: c, _id: { $lt: id } }];
        }
        const rows = await users
          .find(q)
          .sort({ createdAt: -1, _id: -1 })
          .limit(PAGE + 1)
          .project({ firstName: 1, username: 1, createdAt: 1, refBonusGenerated: 1, tasksDone: { $size: { $ifNull: ['$completedTasks', []] } } })
          .toArray();
        const hasMore = rows.length > PAGE;
        const pageRows = hasMore ? rows.slice(0, PAGE) : rows;
        const last = pageRows[pageRows.length - 1];
        const nextCursor = hasMore && last ? `${new Date(last.createdAt).getTime()}_${last._id}` : null;

        const referredSummary = pageRows.map(r => ({
          firstName: r.firstName, username: r.username, createdAt: r.createdAt,
          tasksDone: r.tasksDone || 0,
          withdrawBonus: r.refBonusGenerated || 0,
        }));

        return res.status(200).json({
          success: true,
          referCode: user.referCode,
          referLink: `${BOT_LINK}?startapp=${user.referCode}`,
          totalReferred: user.totalReferred || 0,
          totalRefEarned: user.totalRefEarned || 0,
          totalRefEarnedEG: user.totalRefEarnedEG || 0,
          referredUsers: referredSummary,
          nextCursor,
          rewards: { perRefer: 250, withdrawBonusPct: 15 },
        });
      }

      // ── task list: one category at a time, newest first, one page at a time ──
      // cursor = the _id of the last task of the previous page
      const cat = String(req.query.cat || 'all');
      const tq = { active: true };
      if (cat === 'exclusive' || cat === 'daily') tq.category = cat;
      else if (cat === 'partner') tq.category = { $in: ['partner', null] }; // tasks made before categories existed count as partner
      const tAfter = String(req.query.after || '');
      if (ID_CURSOR.test(tAfter)) tq._id = { $lt: new ObjectId(tAfter) };
      const rows = await tasksCol.find(tq).sort({ _id: -1 }).limit(PAGE + 1)
        .project({ id: 1, title: 1, reward: 1, link: 1, category: 1, verifyType: 1, logoUrl: 1, logoFileId: 1 }).toArray();
      const hasMore = rows.length > PAGE;
      const pageRows = hasMore ? rows.slice(0, PAGE) : rows;
      const done = new Set(user.completedTasks || []);
      const dd = user.dailyDone || {};
      const today = bdTodayKey();
      const result = pageRows.map(t => {
        const category = t.category || 'partner';
        return {
          id: t.id, title: t.title, reward: t.reward, link: t.link || '',
          category, verifyType: t.verifyType || 'link',
          logo: t.logoUrl || null, hasLogo: !!t.logoFileId,
          completed: category === 'daily' ? dd[t.id] === today : done.has(t.id), // daily tasks come back every day
        };
      });
      return res.status(200).json({ success: true, tasks: result, nextCursor: hasMore ? String(pageRows[pageRows.length - 1]._id) : null });
    }

    if (req.method === 'POST') {
      const { taskId, action, startTime, signature } = req.body;
      if (!taskId) return res.status(400).json({ error: 'taskId required' });

      const task = await tasksCol.findOne({ id: taskId, active: true });
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (user.accountLocked) return res.status(403).json({ error: 'Account under review.' });

      const isApi = task.verifyType === 'api';        // Channel/Group join: Telegram itself is the proof
      const isDaily = task.category === 'daily';      // can be done once every day
      const today = bdTodayKey();
      const alreadyDone = isDaily ? user.dailyDone?.[taskId] === today : (user.completedTasks || []).includes(taskId);
      if (alreadyDone) return res.status(400).json({ error: isDaily ? 'Done for today. Come back tomorrow!' : 'Task already completed.' });

      // step 1 (link tasks): the app opens the task and gets a signed start token
      if (action === 'start') {
        if (isApi) return res.status(200).json({ success: true, api: true });
        const t = Date.now();
        return res.status(200).json({ success: true, startTime: t, signature: signTask(telegramId, taskId, t) });
      }

      // step 2: prove it
      let startNum = null;
      if (isApi) {
        if (!task.channelId) return res.status(500).json({ error: 'Task is not set up correctly.' });
        if (!(await isMember(telegramId, task.channelId))) return res.status(400).json({ error: 'not_member' });
      } else {
        if (!startTime || !signature) return res.status(400).json({ error: 'missing_task_token' });
        startNum = Number(startTime);
        if (signTask(telegramId, taskId, startNum) !== signature) return res.status(400).json({ error: 'invalid_task_token' });
        const elapsed = (Date.now() - startNum) / 1000;
        if (!(elapsed >= 0)) return res.status(400).json({ error: 'invalid_task_token' });
        if (elapsed < TASK_MIN_WAIT_SECONDS) return res.status(400).json({ error: 'claimed_too_fast' });
        if (elapsed > 600) return res.status(400).json({ error: 'task_token_expired' });
        if ((user.taskTok?.[taskId] || 0) >= startNum) return res.status(400).json({ error: 'task_token_already_used' });
      }

      // Reserve one of the task's limited slots first (user-created tasks are capped by what the creator paid for).
      const slotRes = task.maxCompletions
        ? await tasksCol.findOneAndUpdate(
            { id: taskId, active: true, $expr: { $lt: [{ $ifNull: ['$completedCount', 0] }, '$maxCompletions'] } },
            { $inc: { completedCount: 1 } }, { returnDocument: 'after' })
        : await tasksCol.findOneAndUpdate({ id: taskId, active: true }, { $inc: { completedCount: 1 } }, { returnDocument: 'after' });
      const slot = slotRes?.value !== undefined ? slotRes.value : slotRes;
      if (!slot) return res.status(400).json({ error: 'Task is full or no longer available.' });
      if (slot.maxCompletions && slot.completedCount >= slot.maxCompletions)
        await tasksCol.updateOne({ id: taskId }, { $set: { active: false, completedAt: new Date() } });

      // Atomic claim: only succeeds if this task is not already done (today, for daily tasks) and the start token was never used.
      const tokOk = startNum ? { [`taskTok.${taskId}`]: { $not: { $gte: startNum } } } : {};
      const tokSet = startNum ? { [`taskTok.${taskId}`]: startNum } : {};
      const result = await users.findOneAndUpdate(
        isDaily
          ? { telegramId: String(telegramId), [`dailyDone.${taskId}`]: { $ne: today }, ...tokOk }
          : { telegramId: String(telegramId), completedTasks: { $ne: taskId }, ...tokOk },
        isDaily
          ? { $inc: { egBalance: task.reward }, $set: { [`dailyDone.${taskId}`]: today, ...tokSet } }
          : { $inc: { egBalance: task.reward }, $set: tokSet, $push: { completedTasks: taskId } },
        { returnDocument: 'after' }
      );
      const updated = result?.value || result;
      if (!updated) {
        await tasksCol.updateOne({ id: taskId }, { $inc: { completedCount: -1 }, $set: { active: true }, $unset: { completedAt: '' } }); // give the slot back
        return res.status(400).json({ error: 'Task already completed.' });
      }

      return res.status(200).json({ success: true, reward: task.reward, balance: updated.egBalance });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('tasks.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
                  }
