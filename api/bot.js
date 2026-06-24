import { getDb } from '../lib/mongodb.js';

const ADMIN_ID = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'http://t.me/TonEdge_play_bot/playearn';
const APP_URL = 'https://ton-edge-play.vercel.app';
const CHANNEL = '@coinly_task';
const COMMUNITY = '@ton_edge_community';
const START_PHOTO = 'https://i.postimg.cc/7Yvq0Mvk/file-000000003a68720caa1783ce4ae59cb7.png';

// Temp state for multi-step task creation
const taskState = {};

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

async function sendPhoto(chatId, photo, caption, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra }),
  });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra }),
  });
}

async function answerCallback(id, text = '') {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

async function checkMembership(userId, chatUsername) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatUsername}&user_id=${userId}`);
    const data = await res.json();
    return ['member', 'administrator', 'creator'].includes(data.result?.status);
  } catch { return false; }
}

// Admin main menu keyboard
const adminMenu = {
  inline_keyboard: [
    [{ text: '📊 Dashboard', callback_data: 'admin_stats' }, { text: '💸 Withdrawals', callback_data: 'admin_pending' }],
    [{ text: '👤 User Lookup', callback_data: 'admin_user' }, { text: '🏆 Top Referrers', callback_data: 'admin_toprefer' }],
    [{ text: '📅 Weekly Refer', callback_data: 'admin_weeklyrefer' }, { text: '📋 Add Task', callback_data: 'admin_addtask' }],
    [{ text: '🎟 Add Promo', callback_data: 'admin_addpromo' }, { text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
    [{ text: '💰 Send EG', callback_data: 'admin_sendeg' }],
  ]
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const db = await getDb();

  // ── CALLBACK QUERY ────────────────────────────────────────────
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = String(cb.from.id);
    const data = cb.data;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;

    // ── Channel join check (regular users) ──────────────────────
    if (data.startsWith('check_join_')) {
      const userId = data.replace('check_join_', '');
      if (fromId !== userId) { await answerCallback(cb.id, '⛔ Not your button'); return res.status(200).json({ ok: true }); }

      const joinedCh = await checkMembership(userId, CHANNEL);
      const joinedCom = await checkMembership(userId, COMMUNITY);
      if (!joinedCh || !joinedCom) { await answerCallback(cb.id, '❌ Please join both channels first!'); return res.status(200).json({ ok: true }); }

      await answerCallback(cb.id, '✅ Verified!');
      const users = db.collection('users');
      const user = await users.findOne({ telegramId: userId });
      const referCode = user?.referCode || '';
      await sendMessage(chatId,
        `✅ <b>Verified! Welcome to Ton Edge Play!</b>\n\n🥚 Mine eggs, earn EG, withdraw crypto!`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🚀 Open Ton Edge Play', web_app: { url: APP_URL } }],
          [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + referCode)}&text=${encodeURIComponent('🥚 Join Ton Edge Play! Earn EG coins!')}` }],
        ]}}
      );
      return res.status(200).json({ ok: true });
    }

    // ── Withdraw approve/reject (admin) ──────────────────────────
    if (data.startsWith('approve_') || data.startsWith('reject_')) {
      if (fromId !== String(ADMIN_ID)) { await answerCallback(cb.id, '⛔ Unauthorized'); return res.status(200).json({ ok: true }); }
      const action = data.startsWith('approve_') ? 'approve' : 'reject';
      const withdrawalId = data.replace('approve_', '').replace('reject_', '');
      const { ObjectId } = await import('mongodb');
      const withdrawals = db.collection('withdrawals');
      const users = db.collection('users');
      const w = await withdrawals.findOne({ _id: new ObjectId(withdrawalId) });
      if (!w || w.status !== 'pending') { await answerCallback(cb.id, 'Already processed'); return res.status(200).json({ ok: true }); }
      if (action === 'reject') await users.updateOne({ telegramId: w.telegramId }, { $inc: { egBalance: w.egAmount } });
      await withdrawals.updateOne({ _id: new ObjectId(withdrawalId) }, { $set: { status: action === 'approve' ? 'approved' : 'rejected', processedAt: new Date() } });
      await answerCallback(cb.id, action === 'approve' ? '✅ Approved' : '❌ Rejected');
      const notif = action === 'approve'
        ? `✅ Withdrawal approved!\n\n💰 ${w.egAmount} EG → ${w.usdtAmount} USDT\n📤 ${w.method}\n📍 <code>${w.address}</code>`
        : `❌ Withdrawal rejected. Balance refunded.`;
      await sendMessage(w.telegramId, notif);
      return res.status(200).json({ ok: true });
    }

    // ── Admin menu callbacks ─────────────────────────────────────
    if (fromId !== String(ADMIN_ID)) { await answerCallback(cb.id, '⛔ Unauthorized'); return res.status(200).json({ ok: true }); }
    await answerCallback(cb.id);

    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');
    const tasks = db.collection('tasks');
    const promos = db.collection('promos');

    if (data === 'admin_menu') {
      await editMessage(chatId, msgId, '👑 <b>Ton Edge Admin Panel</b>\n\nSelect an option:', { reply_markup: adminMenu });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_stats') {
      const totalUsers = await users.countDocuments();
      const today = new Date(); today.setHours(0,0,0,0);
      const dailyNew = await users.countDocuments({ createdAt: { $gte: today } });
      const totalTasks = await tasks.countDocuments({ active: true });
      const pendingW = await withdrawals.countDocuments({ status: 'pending' });
      const activeMiners = await users.countDocuments({ 'activePlan.status': 'mining' });
      const egAgg = await users.aggregate([{ $group: { _id: null, total: { $sum: '$egBalance' } } }]).toArray();
      await editMessage(chatId, msgId,
        `📊 <b>Dashboard</b>\n\n👥 Total Users: <b>${totalUsers}</b>\n🆕 Today: <b>${dailyNew}</b>\n📋 Tasks: <b>${totalTasks}</b>\n⏳ Pending Withdrawals: <b>${pendingW}</b>\n⛏ Active Miners: <b>${activeMiners}</b>\n💰 Total EG: <b>${egAgg[0]?.total || 0}</b>`,
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_menu' }]] } }
      );
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_pending') {
      const list = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
      if (!list.length) {
        await editMessage(chatId, msgId, '✅ No pending withdrawals.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_menu' }]] } });
        return res.status(200).json({ ok: true });
      }
      await editMessage(chatId, msgId, `💸 <b>${list.length} pending withdrawal(s)</b>\nSending details...`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_menu' }]] } });
      for (const w of list) {
        const wid = w._id.toString();
        await sendMessage(chatId,
          `💸 <b>Withdrawal</b>\n👤 <code>${w.telegramId}</code> (@${w.username || '?'})\n💰 ${w.egAmount} EG → ${w.usdtAmount} USDT\n📤 ${w.method}\n📍 <code>${w.address}</code>\n📅 ${new Date(w.createdAt).toLocaleString()}`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${wid}` }, { text: '❌ Reject', callback_data: `reject_${wid}` }]] } }
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_user') {
      taskState[fromId] = { step: 'user_lookup' };
      await editMessage(chatId, msgId, '👤 Send the <b>Telegram ID</b> of the user:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_sendeg') {
      taskState[fromId] = { step: 'sendeg_id' };
      await editMessage(chatId, msgId, '💰 Send the <b>Telegram ID</b> to send EG to:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_broadcast') {
      taskState[fromId] = { step: 'broadcast_msg' };
      await editMessage(chatId, msgId, '📢 Type your <b>broadcast message</b>:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_addpromo') {
      taskState[fromId] = { step: 'promo_code' };
      await editMessage(chatId, msgId, '🎟 Enter <b>promo code</b> (e.g. LAUNCH2026):', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_addtask') {
      taskState[fromId] = { step: 'task_title' };
      await editMessage(chatId, msgId, '📋 <b>Step 1/5</b>\n\nEnter the <b>task title</b>:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_toprefer') {
      const top = await users.find().sort({ totalReferred: -1 }).limit(20).toArray();
      let out = '🏆 <b>All-time Top 20 Referrers</b>\n\n';
      top.forEach((u, i) => { out += `${i+1}. @${u.username || u.firstName} — <b>${u.totalReferred}</b>\n`; });
      await editMessage(chatId, msgId, out || 'No data yet.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'admin_weeklyrefer') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const pipeline = [
        { $match: { createdAt: { $gte: weekAgo }, referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 20 },
      ];
      const weekly = await users.aggregate(pipeline).toArray();
      let out = '📅 <b>Weekly Top 20 Referrers</b>\n\n';
      for (let i = 0; i < weekly.length; i++) {
        const u = await users.findOne({ telegramId: weekly[i]._id });
        out += `${i+1}. @${u?.username || u?.firstName || weekly[i]._id} — <b>${weekly[i].count}</b>\n`;
      }
      await editMessage(chatId, msgId, out || 'No data this week.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    // Task type selection
    if (data === 'task_type_api' || data === 'task_type_none') {
      const state = taskState[fromId];
      if (!state || state.step !== 'task_type') return res.status(200).json({ ok: true });
      state.type = data === 'task_type_api' ? 'api' : 'none';

      if (state.type === 'api') {
        await editMessage(chatId, msgId,
          `📋 <b>Step 5/5 — API Task</b>\n\n⚠️ Make sure <b>@TonEdge_play_bot</b> is admin in the channel/group!\n\nType <b>CONFIRM</b> to save task:`,
          { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } }
        );
        state.step = 'task_confirm_api';
      } else {
        await editMessage(chatId, msgId,
          `📋 <b>Step 5/5</b>\n\nType <b>CONFIRM</b> to save task:`,
          { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'admin_menu' }]] } }
        );
        state.step = 'task_confirm';
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  // ── TEXT MESSAGES ─────────────────────────────────────────────
  const msg = update.message;
  if (!msg || !msg.text) return res.status(200).json({ ok: true });

  const fromId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const users = db.collection('users');
  const withdrawals = db.collection('withdrawals');
  const tasks = db.collection('tasks');
  const promos = db.collection('promos');

  // ── /start ALL USERS ─────────────────────────────────────────
  if (text.startsWith('/start')) {
    const isAdmin = fromId === String(ADMIN_ID);

    if (isAdmin) {
      await sendPhoto(chatId, START_PHOTO,
        `👑 <b>Ton Edge Admin Panel</b>\n\nWelcome back, Admin!`,
        { reply_markup: adminMenu }
      );
      return res.status(200).json({ ok: true });
    }

    // Regular user
    const joinedCh = await checkMembership(fromId, CHANNEL);
    const joinedCom = await checkMembership(fromId, COMMUNITY);

    if (!joinedCh || !joinedCom) {
      await sendPhoto(chatId, START_PHOTO,
        `👋 <b>Welcome to Ton Edge Play!</b>\n\n⚠️ Join our official channels to continue.`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📢 Official Channel', url: 'https://t.me/coinly_task' }, { text: '💬 Community', url: 'https://t.me/ton_edge_community' }],
          [{ text: '✅ Check & Open App', callback_data: `check_join_${fromId}` }],
        ]}}
      );
      return res.status(200).json({ ok: true });
    }

    const user = await users.findOne({ telegramId: fromId });
    const referCode = user?.referCode || '';
    await sendPhoto(chatId, START_PHOTO,
      `🥚 <b>Welcome to Ton Edge Play!</b>\n\nMine eggs · Earn EG · Withdraw crypto!\n\n💰 TON & USDT withdrawals\n👥 Refer friends for bonus EG`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🚀 Open Ton Edge Play', web_app: { url: APP_URL } }],
        [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + referCode)}&text=${encodeURIComponent('🥚 Join Ton Edge Play! Earn EG coins, watch ads & withdraw crypto!')}` }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // ── ADMIN MULTI-STEP FLOWS ────────────────────────────────────
  if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

  const state = taskState[fromId];

  if (state) {
    // User lookup
    if (state.step === 'user_lookup') {
      const u = await users.findOne({ telegramId: text });
      if (!u) { await sendMessage(chatId, '❌ User not found.', { reply_markup: adminMenu }); }
      else {
        const totalW = await withdrawals.countDocuments({ telegramId: text });
        await sendMessage(chatId,
          `👤 <b>User Info</b>\n\nID: <code>${u.telegramId}</code>\nName: ${u.firstName} (@${u.username || 'none'})\n💰 Balance: <b>${u.egBalance} EG</b>\n👥 Refs: <b>${u.totalReferred}</b>\n📤 Withdrawals: <b>${totalW}</b>\n📺 Ads: <b>${u.totalAdsWatched}</b>\n🚫 Banned: <b>${u.isBanned ? 'YES' : 'No'}</b>\n📅 Joined: ${new Date(u.createdAt).toLocaleDateString()}`,
          { reply_markup: { inline_keyboard: [
            [{ text: u.isBanned ? '✅ Unban' : '🚫 Ban', callback_data: u.isBanned ? `unban_${u.telegramId}` : `ban_${u.telegramId}` }],
            [{ text: '◀️ Back to Menu', callback_data: 'admin_menu' }]
          ]}}
        );
      }
      delete taskState[fromId];
      return res.status(200).json({ ok: true });
    }

    // Send EG flow
    if (state.step === 'sendeg_id') {
      state.targetId = text;
      state.step = 'sendeg_amount';
      await sendMessage(chatId, `💰 How many EG to send to <code>${text}</code>?`);
      return res.status(200).json({ ok: true });
    }
    if (state.step === 'sendeg_amount') {
      const amount = parseInt(text);
      if (!amount || isNaN(amount)) { await sendMessage(chatId, '❌ Invalid amount'); return res.status(200).json({ ok: true }); }
      const u = await users.findOne({ telegramId: state.targetId });
      if (!u) { await sendMessage(chatId, '❌ User not found.', { reply_markup: adminMenu }); delete taskState[fromId]; return res.status(200).json({ ok: true }); }
      await users.updateOne({ telegramId: state.targetId }, { $inc: { egBalance: amount } });
      await sendMessage(chatId, `✅ Sent <b>${amount} EG</b> to <code>${state.targetId}</code>`, { reply_markup: adminMenu });
      await sendMessage(state.targetId, `🎁 You received <b>${amount} EG</b> from admin!`);
      delete taskState[fromId];
      return res.status(200).json({ ok: true });
    }

    // Broadcast flow
    if (state.step === 'broadcast_msg') {
      const allUsers = await users.find({}, { projection: { telegramId: 1 } }).toArray();
      let sent = 0, failed = 0;
      await sendMessage(chatId, `📢 Broadcasting to ${allUsers.length} users...`);
      for (const u of allUsers) {
        try { await sendMessage(u.telegramId, `📢 <b>Ton Edge Update</b>\n\n${text}`); sent++; } catch { failed++; }
        await new Promise(r => setTimeout(r, 50));
      }
      await sendMessage(chatId, `✅ Done! Sent: ${sent} | Failed: ${failed}`, { reply_markup: adminMenu });
      delete taskState[fromId];
      return res.status(200).json({ ok: true });
    }

    // Promo flow
    if (state.step === 'promo_code') {
      state.code = text.toUpperCase().trim();
      state.step = 'promo_reward';
      await sendMessage(chatId, `🎟 Code: <b>${state.code}</b>\n\nEnter <b>EG reward</b> amount:`);
      return res.status(200).json({ ok: true });
    }
    if (state.step === 'promo_reward') {
      state.reward = parseInt(text);
      state.step = 'promo_maxuses';
      await sendMessage(chatId, `🎟 Reward: <b>${state.reward} EG</b>\n\nEnter <b>max uses</b> (or type 0 for unlimited):`);
      return res.status(200).json({ ok: true });
    }
    if (state.step === 'promo_maxuses') {
      const maxUses = parseInt(text) || 9999;
      await promos.updateOne(
        { code: state.code },
        { $set: { code: state.code, reward: state.reward, maxUses, usedCount: 0, createdAt: new Date() } },
        { upsert: true }
      );
      await sendMessage(chatId, `✅ Promo <b>${state.code}</b> created!\nReward: ${state.reward} EG | Max uses: ${maxUses}`, { reply_markup: adminMenu });
      delete taskState[fromId];
      return res.status(200).json({ ok: true });
    }

    // Task creation flow — 5 steps
    if (state.step === 'task_title') {
      state.title = text;
      state.step = 'task_link';
      await sendMessage(chatId, `📋 <b>Step 2/5</b>\n\nTitle: <b>${state.title}</b>\n\nEnter the <b>task link</b> (URL):\n(or type <code>none</code> if no link)`);
      return res.status(200).json({ ok: true });
    }
    if (state.step === 'task_link') {
      state.link = text === 'none' ? '' : text;
      state.step = 'task_reward';
      await sendMessage(chatId, `📋 <b>Step 3/5</b>\n\nEnter <b>EG reward</b> amount:`);
      return res.status(200).json({ ok: true });
    }
    if (state.step === 'task_reward') {
      state.reward = parseInt(text);
      if (!state.reward || isNaN(state.reward)) { await sendMessage(
