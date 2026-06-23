import { getDb } from '../lib/mongodb.js';

const ADMIN_ID = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'http://t.me/TonEdge_play_bot/startapp';
const CHANNEL = '@coinly_task';
const COMMUNITY = '@ton_edge_community';

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

async function answerCallback(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function checkMembership(userId, chatUsername) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatUsername}&user_id=${userId}`
    );
    const data = await res.json();
    const status = data.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const db = await getDb();

  // ── Callback Query (inline buttons) ──────────────────────────────
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = String(cb.from.id);
    const data = cb.data;

    // Channel join check button
    if (data.startsWith('check_join_')) {
      const userId = data.replace('check_join_', '');
      if (fromId !== userId) {
        await answerCallback(cb.id, '⛔ Not your button');
        return res.status(200).json({ ok: true });
      }

      const joinedChannel = await checkMembership(userId, CHANNEL);
      const joinedCommunity = await checkMembership(userId, COMMUNITY);

      if (!joinedChannel || !joinedCommunity) {
        await answerCallback(cb.id, '❌ Please join both channels first!');
        return res.status(200).json({ ok: true });
      }

      await answerCallback(cb.id, '✅ Verified!');

      const users = db.collection('users');
      const user = await users.findOne({ telegramId: userId });
      const referCode = user?.referCode || '';

      await sendMessage(cb.message.chat.id,
        `✅ <b>Verified! Welcome to Ton Edge Play!</b>\n\n` +
        `🥚 Mine eggs, watch ads, complete tasks and earn <b>EG coins</b>!\n\n` +
        `💰 Withdraw via Tonkeeper or Binance\n` +
        `👥 Refer friends and earn bonus EG!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Open Ton Edge Play', web_app: { url: 'https://ton-edge.vercel.app' } }],
              [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(`${MINI_APP_URL}?startapp=${referCode}`)}&text=${encodeURIComponent('🥚 Join Ton Edge Play and earn EG coins! Mine eggs, watch ads & withdraw crypto!')}` }],
            ],
          },
        }
      );
      return res.status(200).json({ ok: true });
    }

    // Admin only — approve/reject withdrawal
    if (fromId !== String(ADMIN_ID)) {
      await answerCallback(cb.id, '⛔ Unauthorized');
      return res.status(200).json({ ok: true });
    }

    if (data.startsWith('approve_') || data.startsWith('reject_')) {
      const parts = data.split('_');
      const action = parts[0];
      const withdrawalId = parts[1];
      const { ObjectId } = await import('mongodb');
      const withdrawals = db.collection('withdrawals');
      const users = db.collection('users');

      const w = await withdrawals.findOne({ _id: new ObjectId(withdrawalId) });
      if (!w || w.status !== 'pending') {
        await answerCallback(cb.id, 'Already processed');
        return res.status(200).json({ ok: true });
      }

      if (action === 'reject') {
        await users.updateOne(
          { telegramId: w.telegramId },
          { $inc: { egBalance: w.egAmount } }
        );
      }

      await withdrawals.updateOne(
        { _id: new ObjectId(withdrawalId) },
        { $set: { status: action === 'approve' ? 'approved' : 'rejected', processedAt: new Date() } }
      );

      const statusText = action === 'approve' ? '✅ Approved' : '❌ Rejected';
      await answerCallback(cb.id, statusText);

      const msg = action === 'approve'
        ? `✅ Your withdrawal of <b>${w.egAmount} EG → ${w.usdtAmount} USDT</b> has been approved!\n\nMethod: ${w.method}\nAddress: <code>${w.address}</code>`
        : `❌ Your withdrawal of <b>${w.egAmount} EG</b> has been rejected. Balance refunded.`;
      await sendMessage(w.telegramId, msg);
    }

    return res.status(200).json({ ok: true });
  }

  // ── Text Commands ─────────────────────────────────────────────────
  const msg = update.message;
  if (!msg || !msg.text) return res.status(200).json({ ok: true });

  const fromId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const users = db.collection('users');
  const withdrawals = db.collection('withdrawals');
  const tasks = db.collection('tasks');
  const promos = db.collection('promos');

  // ── /start — ALL USERS ────────────────────────────────────────────
  if (text.startsWith('/start')) {
    const isAdmin = fromId === String(ADMIN_ID);

    if (isAdmin) {
      await sendMessage(chatId,
        `👑 <b>Ton Edge Admin Panel</b>\n\n` +
        `/stats — Dashboard\n` +
        `/pending — Pending withdrawals\n` +
        `/user [id] — User info\n` +
        `/ban [id] — Ban user\n` +
        `/unban [id] — Unban user\n` +
        `/send [id] [amount] — Send EG\n` +
        `/toprefer — Top 20 all-time referrers\n` +
        `/weeklyrefer — Weekly top 20\n` +
        `/addtask — Add task guide\n` +
        `/deltask [id] — Delete task\n` +
        `/addpromo [code] [reward] [maxUses] — Create promo\n` +
        `/broadcast [message] — Send to all users`
      );
      return res.status(200).json({ ok: true });
    }

    // Regular user — check channel membership
    const joinedChannel = await checkMembership(fromId, CHANNEL);
    const joinedCommunity = await checkMembership(fromId, COMMUNITY);

    if (!joinedChannel || !joinedCommunity) {
      await sendMessage(chatId,
        `👋 <b>Welcome to Ton Edge Play!</b>\n\n` +
        `⚠️ To use the app you must join our official channels first.\n\n` +
        `📢 Join both below, then tap ✅ <b>Check & Open App</b>`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📢 Official Channel', url: 'https://t.me/coinly_task' },
                { text: '💬 Community', url: 'https://t.me/ton_edge_community' },
              ],
              [{ text: '✅ Check & Open App', callback_data: `check_join_${fromId}` }],
            ],
          },
        }
      );
      return res.status(200).json({ ok: true });
    }

    // Already joined
    const user = await users.findOne({ telegramId: fromId });
    const referCode = user?.referCode || '';

    await sendMessage(chatId,
      `🥚 <b>Welcome to Ton Edge Play!</b>\n\n` +
      `Mine eggs, watch ads, complete tasks and earn <b>EG coins</b>!\n\n` +
      `💰 Withdraw via Tonkeeper or Binance\n` +
      `👥 Refer friends and earn bonus EG!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Open Ton Edge Play', web_app: { url: 'https://ton-edge.vercel.app' } }],
            [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(`${MINI_APP_URL}?startapp=${referCode}`)}&text=${encodeURIComponent('🥚 Join Ton Edge Play! Mine eggs, watch ads & withdraw crypto!')}` }],
          ],
        },
      }
    );
    return res.status(200).json({ ok: true });
  }

  // Admin only commands below
  if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

  // /stats
  if (text === '/stats') {
    const totalUsers = await users.countDocuments();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dailyNew = await users.countDocuments({ createdAt: { $gte: today } });
    const totalTasks = await tasks.countDocuments({ active: true });
    const pendingW = await withdrawals.countDocuments({ status: 'pending' });
    const activeMiners = await users.countDocuments({ 'activePlan.status': 'mining' });
    const egAgg = await users.aggregate([{ $group: { _id: null, total: { $sum: '$egBalance' } } }]).toArray();
    const totalEG = egAgg[0]?.total || 0;

    await sendMessage(chatId,
      `📊 <b>Dashboard</b>\n\n` +
      `👥 Total Users: <b>${totalUsers}</b>\n` +
      `🆕 Today Joined: <b>${dailyNew}</b>\n` +
      `📋 Active Tasks: <b>${totalTasks}</b>\n` +
      `⏳ Pending Withdrawals: <b>${pendingW}</b>\n` +
      `⛏ Active Miners: <b>${activeMiners}</b>\n` +
      `💰 Total EG in Wallets: <b>${totalEG}</b>`
    );
    return res.status(200).json({ ok: true });
  }

  // /pending
  if (text === '/pending') {
    const list = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
    if (!list.length) {
      await sendMessage(chatId, '✅ No pending withdrawals.');
      return res.status(200).json({ ok: true });
    }
    for (const w of list) {
      const wid = w._id.toString();
      await sendMessage(chatId,
        `💸 <b>Withdrawal Request</b>\n\n` +
        `👤 User: <code>${w.telegramId}</code> (@${w.username || 'unknown'})\n` +
        `💰 Amount: <b>${w.egAmount} EG → ${w.usdtAmount} USDT</b>\n` +
        `📤 Method: <b>${w.method}</b>\n` +
        `📍 Address: <code>${w.address}</code>\n` +
        `📅 Date: ${new Date(w.createdAt).toLocaleString()}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', callback_data: `approve_${wid}` },
              { text: '❌ Reject', callback_data: `reject_${wid}` },
            ]],
          },
        }
      );
    }
    return res.status(200).json({ ok: true });
  }

  // /user [id]
  if (text.startsWith('/user ')) {
    const targetId = text.split(' ')[1];
    const u = await users.findOne({ telegramId: targetId });
    if (!u) { await sendMessage(chatId, '❌ User not found.'); return res.status(200).json({ ok: true }); }
    const totalW = await withdrawals.countDocuments({ telegramId: targetId });
    await sendMessage(chatId,
      `👤 <b>User Info</b>\n\n` +
      `ID: <code>${u.telegramId}</code>\n` +
      `Name: ${u.firstName} (@${u.username || 'none'})\n` +
      `💰 Balance: <b>${u.egBalance} EG</b>\n` +
      `👥 Referrals: <b>${u.totalReferred}</b>\n` +
      `🎁 Ref Earned: <b>${u.totalRefEarned} EG</b>\n` +
      `📤 Total Withdrawals: <b>${totalW}</b>\n` +
      `📺 Ads Watched: <b>${u.totalAdsWatched}</b>\n` +
      `🚫 Banned: <b>${u.isBanned ? 'YES' : 'No'}</b>\n` +
      `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()}`
    );
    return res.status(200).json({ ok: true });
  }

  // /ban [id]
  if (text.startsWith('/ban ')) {
    const targetId = text.split(' ')[1];
    await users.updateOne({ telegramId: targetId }, { $set: { isBanned: true } });
    await sendMessage(chatId, `🚫 User <code>${targetId}</code> banned.`);
    return res.status(200).json({ ok: true });
  }

  // /unban [id]
  if (text.startsWith('/unban ')) {
    const targetId = text.split(' ')[1];
    await users.updateOne({ telegramId: targetId }, { $set: { isBanned: false } });
    await sendMessage(chatId, `✅ User <code>${targetId}</code> unbanned.`);
    return res.status(200).json({ ok: true });
  }

  // /send [id] [amount]
  if (text.startsWith('/send ')) {
    const parts = text.split(' ');
    const targetId = parts[1];
    const amount = parseInt(parts[2]);
    if (!targetId || !amount || isNaN(amount)) {
      await sendMessage(chatId, 'Usage: /send [telegramId] [amount]');
      return res.status(200).json({ ok: true });
    }
    const u = await users.findOne({ telegramId: targetId });
    if (!u) { await sendMessage(chatId, '❌ User not found.'); return res.status(200).json({ ok: true }); }
    await users.updateOne({ telegramId: targetId }, { $inc: { egBalance: amount } });
    await sendMessage(chatId, `✅ Sent <b>${amount} EG</b> to <code>${targetId}</code>`);
    await sendMessage(targetId, `🎁 You received <b>${amount} EG</b> from admin!`);
    return res.status(200).json({ ok: true });
  }

  // /toprefer
  if (text === '/toprefer') {
    const top = await users.find().sort({ totalReferred: -1 }).limit(20).toArray();
    let out = '🏆 <b>All-time Top 20 Referrers</b>\n\n';
    top.forEach((u, i) => { out += `${i + 1}. @${u.username || u.firstName} — <b>${u.totalReferred}</b> refs\n`; });
    await sendMessage(chatId, out);
    return res.status(200).json({ ok: true });
  }

  // /weeklyrefer
  if (text === '/weeklyrefer') {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pipeline = [
      { $match: { createdAt: { $gte: weekAgo }, referredBy: { $ne: null } } },
      { $group: { _id: '$referredBy', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ];
    const weeklyTop = await users.aggregate(pipeline).toArray();
    let out = '📅 <b>Weekly Top 20 Referrers</b>\n\n';
    for (let i = 0; i < weeklyTop.length; i++) {
      const u = await users.findOne({ telegramId: weeklyTop[i]._id });
      out += `${i + 1}. @${u?.username || u?.firstName || weeklyTop[i]._id} — <b>${weeklyTop[i].count}</b> refs\n`;
    }
    await sendMessage(chatId, out || 'No data this week.');
    return res.status(200).json({ ok: true });
  }

  // /addtask
  if (text === '/addtask') {
    await sendMessage(chatId,
      `📋 <b>Add Task Guide</b>\n\n` +
      `Format:\n<code>/newtask [id] [type] [reward] [title] | [link]</code>\n\n` +
      `Types:\n• <b>api</b> — Telegram (bot must be admin in channel)\n• <b>none</b> — YouTube, Facebook etc.\n\n` +
      `Example:\n<code>/newtask join_ch api 10 Join our channel | https://t.me/TonEdgePlay</code>`
    );
    return res.status(200).json({ ok: true });
  }

  // /newtask
  if (text.startsWith('/newtask ')) {
    const parts = text.replace('/newtask ', '').split(' ');
    const id = parts[0];
    const type = parts[1];
    const reward = parseInt(parts[2]);
    const rest = parts.slice(3).join(' ').split('|');
    const title = rest[0]?.trim();
    const link = rest[1]?.trim();
    if (!id || !type || !reward || !title) {
      await sendMessage(chatId, '❌ Invalid format. Use /addtask to see guide.');
      return res.status(200).json({ ok: true });
    }
    await tasks.updateOne(
      { id },
      { $set: { id, type, reward, title, link: link || '', active: true, createdAt: new Date() } },
      { upsert: true }
    );
    await sendMessage(chatId, `✅ Task <b>${title}</b> added! Reward: ${reward} EG`);
    return res.status(200).json({ ok: true });
  }

  // /deltask
  if (text.startsWith('/deltask ')) {
    const taskId = text.split(' ')[1];
    await tasks.updateOne({ id: taskId }, { $set: { active: false } });
    await sendMessage(chatId, `✅ Task <code>${taskId}</code> disabled.`);
    return res.status(200).json({ ok: true });
  }

  // /addpromo
  if (text.startsWith('/addpromo ')) {
    const parts = text.split(' ');
    const code = parts[1]?.toUpperCase();
    const reward = parseInt(parts[2]);
    const maxUses = parseInt(parts[3]) || 9999;
    if (!code || !reward) {
      await sendMessage(chatId, 'Usage: /addpromo [CODE] [reward] [maxUses]');
      return res.status(200).json({ ok: true });
    }
    await promos.updateOne(
      { code },
      { $set: { code, reward, maxUses, usedCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
    await sendMessage(chatId, `✅ Promo <b>${code}</b> created!\nReward: ${reward} EG | Max uses: ${maxUses}`);
    return res.status(200).json({ ok: true });
  }

  // /broadcast
  if (text.startsWith('/broadcast ')) {
    const broadcastMsg = text.replace('/broadcast ', '');
    const allUsers = await users.find({}, { projection: { telegramId: 1 } }).toArray();
    let sent = 0, failed = 0;
    await sendMessage(chatId, `📢 Broadcasting to ${allUsers.length} users...`);
    for (const u of allUsers) {
      try {
        await sendMessage(u.telegramId, `📢 <b>Ton Edge Update</b>\n\n${broadcastMsg}`);
        sent++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }
    await sendMessage(chatId, `✅ Broadcast done!\nSent: ${sent} | Failed: ${failed}`);
    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });
                                   }
