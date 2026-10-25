// FILE PATH: api/bot.js
// (GitHub repo te ei path e file ta rakhbe: api/bot.js)

import { getDb } from '../lib/mongodb.js';
import { handleSignupCallback } from '../lib/signupBursts.js';
import { markBanned, markUnbanned } from '../lib/banRegistry.js';
import { ObjectId } from 'mongodb';
const escH = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const ADMIN_ID = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'http://t.me/TonEdge_play_bot/playearn';
const APP_URL = 'https://ton-edge-play.vercel.app';
// Referrer earns this share of every APPROVED withdrawal made by someone they referred.
const REF_WITHDRAW_BONUS_PCT = 0.15;
const START_PHOTO = 'https://i.postimg.cc/7Yvq0Mvk/file-000000003a68720caa1783ce4ae59cb7.png';

// Multi-step state storage
const state = {};

// ── Telegram helpers ────────────────────────────────────────────
async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const send = (chatId, text, extra = {}) =>
  tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

const sendPhoto = (chatId, photo, caption, extra = {}) =>
  tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });

const edit = (chatId, msgId, text, extra = {}) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });

const answer = (id, text = '') =>
  tgApi('answerCallbackQuery', { callback_query_id: id, text });

async function runBroadcast(chatId, usersCol, text, replyMarkup, opts = {}) {
  const all = await usersCol.find({ isBanned: { $ne: true }, botBlocked: { $ne: true } }, { projection: { telegramId: 1 } }).toArray();
  let sent = 0, failed = 0;
  await send(chatId, `📢 Broadcasting to <b>${all.length}</b> users...`);
  const extra = replyMarkup ? { reply_markup: replyMarkup } : {};
  const body = opts.raw ? text : `📢 <b>Gram Edge Farm Update</b>\n\n${text}`;
  for (const u of all) {
    let r = await send(u.telegramId, body, extra).catch(() => ({ ok: false }));
    if (!r.ok && r.error_code === 429) { await new Promise(x => setTimeout(x, ((r.parameters?.retry_after || 3) + 1) * 1000)); r = await send(u.telegramId, body, extra).catch(() => ({ ok: false })); }
    if (r.ok) sent++;
    else { failed++; if (r.error_code === 403) await usersCol.updateOne({ telegramId: u.telegramId }, { $set: { botBlocked: true } }); }
    await new Promise(x => setTimeout(x, 50));
  }
  await send(chatId, `✅ Done! Sent: <b>${sent}</b> | Failed: <b>${failed}</b>`, { reply_markup: adminKb });
}

// ── Admin keyboard ──────────────────────────────────────────────
const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard',     callback_data: 'a_stats'       }, { text: '💸 Withdrawals',   callback_data: 'a_pending'     }],
    [{ text: '👤 User Lookup',   callback_data: 'a_user'        }, { text: '🏆 Top Referrers', callback_data: 'a_toprefer'   }],
    [{ text: '📅 Weekly Refer',  callback_data: 'a_weekly'      }, { text: '📋 Add Task',      callback_data: 'a_addtask'    }],
    [{ text: '📝 Task List',     callback_data: 'a_tasklist'    }, { text: '🎟 Add Promo',     callback_data: 'a_addpromo'   }],
    [{ text: '📢 Broadcast',     callback_data: 'a_broadcast'   }, { text: '🕐 Pending Review', callback_data: 'a_review' }],
    [{ text: '🆕 Signup Bursts', callback_data: 'a_signups'     }, { text: '💳 Payout Wallet', callback_data: 'a_payout' }],
    [{ text: '💰 Send MM$',       callback_data: 'a_sendeg'      }],
  ]
};

const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const db = await getDb();
  const users      = db.collection('users');
  const withdrawals = db.collection('withdrawals');
  const tasks      = db.collection('tasks');
  const promos     = db.collection('promos');

  // ══════════════════════════════════════════════════════════════
  // CALLBACK QUERY
  // ══════════════════════════════════════════════════════════════
  if (update.callback_query) {
    const cb     = update.callback_query;
    const fromId = String(cb.from.id);
    const data   = cb.data;
    const chatId = cb.message.chat.id;
    const msgId  = cb.message.message_id;

    await answer(cb.id);

    // All callbacks below — admin only
    if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

    // 1) claim the payout (no double pay) 2) global lock (no seqno clash) 3) send USDT 4) only if confirmed -> approve.
    // Failure BEFORE anything was sent -> tap Retry. Unclear outcome -> NEVER retried automatically (double-payment risk).
    async function autoPay(w) {
      const wid = String(w._id);
      const kbFail = { inline_keyboard: [
        [{ text: '🔁 Retry Auto-Pay', callback_data: `wd_approve_${wid}` }],
        [{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }, { text: '❌ Reject', callback_data: `wd_reject_${wid}` }],
        [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${wid}` }] ] };
      const kbUnclear = { inline_keyboard: [[{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }, { text: '❌ Reject', callback_data: `wd_reject_${wid}` }]] };
      const dayMax = Number(process.env.TON_PAYOUT_DAILY_MAX_USD);
      if (dayMax > 0) {
        const agg = await withdrawals.aggregate([
          { $match: { payoutStatus: { $in: ['sent', 'unknown'] }, payoutStartedAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } } },
          { $group: { _id: null, total: { $sum: '$usdtAmount' } } } ]).toArray();
        const used = agg[0]?.total || 0;
        if (used + (w.usdtAmount || 0) > dayMax) {
          await edit(chatId, msgId, `🛡 <b>Daily payout limit reached.</b>\n\nLast 24h auto-paid: <b>$${used.toFixed(4)}</b> · this one: <b>$${(w.usdtAmount || 0).toFixed(4)}</b> · limit: <b>$${dayMax}</b>\n\nPay by hand and tap Approve Manually, or raise <code>TON_PAYOUT_DAILY_MAX_USD</code>.`, { reply_markup: kbFail });
          return null;
        }
      }
      const claim = await withdrawals.findOneAndUpdate(
        { _id: w._id, status: 'pending', payoutStatus: { $nin: ['sending', 'sent', 'unknown'] } },
        { $set: { payoutStatus: 'sending', payoutStartedAt: new Date() } }, { returnDocument: 'after' });
      if (!(claim?.value !== undefined ? claim.value : claim)) {
        await edit(chatId, msgId, `⚠️ Withdrawal <code>${wid}</code> is already being paid or its payment status is unclear (check the payout wallet).`, { reply_markup: { inline_keyboard: [[{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }]] } });
        return null;
      }
      const locks = db.collection('botSettings');
      await locks.updateOne({ _id: 'payoutLock' }, { $setOnInsert: { until: 0 } }, { upsert: true });
      const gotLock = await locks.findOneAndUpdate({ _id: 'payoutLock', until: { $lt: Date.now() } }, { $set: { until: Date.now() + 45000 } });
      if (!gotLock) {
        await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'failed', payoutError: 'another payout is in progress' } });
        await edit(chatId, msgId, '⏳ Another payout is being sent right now. Wait ~30 seconds and tap Approve again.', { reply_markup: { inline_keyboard: [[{ text: '✅ Approve (auto-pay)', callback_data: `wd_approve_${wid}` }]] } });
        return null;
      }
      try {
        await edit(chatId, msgId, `💸 Sending <b>$${(w.usdtAmount || 0).toFixed(4)} USDT</b> to <code>${escH(w.address)}</code> ...\n\nDo not tap anything, this takes ~15 seconds.`);
        let result;
        try {
          const { sendUsdtPayout } = await import('../lib/tonPayout.js');
          result = await sendUsdtPayout({ toAddress: w.address, amountUsd: w.usdtAmount });
        } catch (e) {
          const m = escH(String(e.message || e).slice(0, 400));
          if (e.safeToRetry === false) {
            await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'unknown', payoutError: String(e.message || e).slice(0, 400) } });
            await edit(chatId, msgId, `⚠️ <b>Payment status UNCLEAR</b> for <code>${wid}</code>\n\n${m}\n\n<b>Do NOT retry.</b> Open the payout wallet and check the latest outgoing USDT transfer. If it reached the user, tap Approve Manually; if not, Reject (refunds).`, { reply_markup: kbUnclear });
          } else {
            await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'failed', payoutError: String(e.message || e).slice(0, 400) } });
            await edit(chatId, msgId, `❌ <b>Auto-pay failed — nothing was sent.</b>\n\n${m}\n\nFix it, then tap Retry.`, { reply_markup: kbFail });
          }
          return null;
        }
        if (!result.confirmed) {
          await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'unknown', payoutError: 'sent, not confirmed within 14s' } });
          await edit(chatId, msgId, `⚠️ <b>Sent, but not confirmed yet</b> for <code>${wid}</code>\n\nThe transfer was submitted but not visible within 14 seconds. <b>Do NOT retry.</b> Check the payout wallet, then Approve Manually (if it arrived) or Reject.`, { reply_markup: kbUnclear });
          return null;
        }
        await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'sent', payoutSeqno: result.seqno, payoutAt: new Date() } });
        return { link: result.txHash ? `https://tonviewer.com/transaction/${result.txHash}` : `https://tonviewer.com/${encodeURIComponent(String(w.address).trim())}` };
      } finally {
        await locks.updateOne({ _id: 'payoutLock' }, { $set: { until: 0 } }).catch(() => {});
      }
    }

    if (data === 'a_payout') {
      let t;
      if (!process.env.TON_PAYOUT_MNEMONIC) t = '💳 <b>Payout Wallet</b>\n\n❌ <code>TON_PAYOUT_MNEMONIC</code> is not set on Render. Withdrawals stay manual.';
      else {
        try {
          const { getPayoutWalletInfo, payoutMaxUsd } = await import('../lib/tonPayout.js');
          const i = await getPayoutWalletInfo();
          t = `💳 <b>Payout Wallet</b>\n\n⚙️ Auto-pay: <b>${process.env.TON_PAYOUT_ENABLED === '1' ? 'ON ✅' : 'OFF (TON_PAYOUT_ENABLED is not 1)'}</b>\n📍 <code>${i.address}</code> (${i.version})\n💎 TON: <b>${i.ton.toFixed(3)}</b> (≈0.05 needed per payout for gas)\n💵 USDT: <b>${i.usdt.toFixed(2)}</b>\n🛡 Max per payout: <b>$${payoutMaxUsd()}</b>\n📆 Max per 24h: <b>${Number(process.env.TON_PAYOUT_DAILY_MAX_USD) > 0 ? '$' + Number(process.env.TON_PAYOUT_DAILY_MAX_USD) : 'no limit'}</b>`;
        } catch (e) { t = `💳 <b>Payout Wallet</b>\n\n❌ ${escH(String(e.message || e).slice(0, 300))}`; }
      }
      await edit(chatId, msgId, t, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    // ── Approve / Reject withdrawal ───────────────────────────
    if (data.startsWith('wd_approve_') || data.startsWith('wd_reject_') || data.startsWith('wd_manual_')) {
      const approve = !data.startsWith('wd_reject_');
      const wid = data.replace(/^wd_(approve|reject|manual)_/, '');

      // 💸 AUTO PAYOUT (ported from NEWTUBE). ✅ Approve on a TonKeeper withdrawal pays the USDT automatically when
      // TON_PAYOUT_ENABLED=1; "✋ Approve Manually" approves WITHOUT sending (you paid by hand). Nothing is sent otherwise.
      let txLink = null;
      if (data.startsWith('wd_approve_') && process.env.TON_PAYOUT_ENABLED === '1' && process.env.TON_PAYOUT_MNEMONIC) {
        const pre = await withdrawals.findOne({ _id: new ObjectId(wid), status: 'pending' });
        if (pre && pre.method === 'tonkeeper') {
          const r = await autoPay(pre);
          if (!r) return res.status(200).json({ ok: true });
          txLink = r.link;
        }
      }
      // Atomic claim: flips pending -> approved/rejected in one step, so a
      // double-tap on Approve can never pay the referral bonus twice.
      const claimed = await withdrawals.findOneAndUpdate(
        { _id: new ObjectId(wid), status: 'pending' },
        { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date(), ...(txLink ? { txLink } : {}) } },
        { returnDocument: 'before' }
      );
      const w = claimed?.value || claimed;
      if (!w) {
        await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already processed', show_alert: true });
        return res.status(200).json({ ok: true });
      }
      if (!approve) {
        await users.updateOne({ telegramId: w.telegramId }, { $inc: { egBalance: w.egAmount }, $set: { withdrawPending: false } });
      } else {
        await users.updateOne({ telegramId: w.telegramId }, { $set: { withdrawPending: false } });
      }

      // Referral withdraw bonus: when a withdrawal is APPROVED, the person who
      // referred this user earns 15% of the withdrawn MM$ (on top, not deducted
      // from the withdrawer).
      let bonusInfo = '';
      if (approve) {
        const wUser = await users.findOne({ telegramId: w.telegramId }, { projection: { referredBy: 1 } });
        if (wUser?.referredBy) {
          const bonus = Math.floor(w.egAmount * REF_WITHDRAW_BONUS_PCT * 100) / 100;
          if (bonus > 0) {
            await users.updateOne(
              { telegramId: wUser.referredBy },
              { $inc: { egBalance: bonus, totalRefEarnedEG: bonus, totalRefWithdrawBonus: bonus } }
            );
            await users.updateOne({ telegramId: w.telegramId }, { $inc: { refBonusGenerated: bonus } });
            await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { referralBonus: bonus, referralBonusTo: wUser.referredBy } });
            await send(wUser.referredBy, `🎁 <b>Referral Bonus!</b>\n\nYour friend's withdrawal was approved — you earned <b>+${bonus} MM$</b> (15%).`);
            bonusInfo = `\n🎁 Referral bonus paid: ${bonus} MM$ → <code>${wUser.referredBy}</code>`;
          }
        }
      }

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: approve ? '✅ Approved' : '❌ Rejected', show_alert: true });
      const notif = approve
        ? `✅ <b>Withdrawal Approved!</b>\n\n💰 ${w.egAmount} MM$ → ${w.usdtAmount} USDT\n📤 ${w.method}\n📍 <code>${w.address}</code>${txLink ? `\n🔗 <a href="${txLink}">View transaction</a>` : ''}`
        : `❌ <b>Withdrawal Rejected.</b>\nYour ${w.egAmount} MM$ has been refunded.`;
      await send(w.telegramId, notif);
      if (bonusInfo) await send(chatId, `✅ Approved.${bonusInfo}`);
      return res.status(200).json({ ok: true });
    }

    // ── Ban / Unban from user lookup ──────────────────────────
    if (data.startsWith('ban_') || data.startsWith('unban_')) {
      const isBan  = data.startsWith('ban_');
      const target = data.replace('ban_', '').replace('unban_', '');
      await users.updateOne({ telegramId: target }, { $set: { isBanned: isBan } });
      if (isBan) await markBanned(db, [target]); else await markUnbanned(db, [target]); // permanent registry: banned IDs can't re-register
      await edit(chatId, msgId, `${isBan ? '🚫 Banned' : '✅ Unbanned'}: <code>${target}</code>`, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    // ── Withdraw: wrong address -> reject + refund + let the user fix the wallet ──
    if (data.startsWith('wd_wrongaddr_')) {
      const wid = data.replace('wd_wrongaddr_', '');
      const claimed = await withdrawals.findOneAndUpdate({ _id: new ObjectId(wid), status: 'pending' }, { $set: { status: 'rejected', processedAt: new Date(), rejectReason: 'wrong_address' } }, { returnDocument: 'before' });
      const w = claimed?.value || claimed;
      if (!w) { await edit(chatId, msgId, 'Already processed.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
      await users.updateOne({ telegramId: w.telegramId }, { $inc: { egBalance: w.egAmount }, $set: { withdrawPending: false, walletChangeStatus: 'approved' } });
      await edit(chatId, msgId, `⚠️ Rejected (wrong address) + refunded: <code>${w.telegramId}</code>`, { reply_markup: backKb });
      await send(w.telegramId, `⚠️ <b>Withdrawal rejected — wrong address.</b>\n\nYour ${w.egAmount} MM$ was refunded. Open the app → Profile → Withdraw and enter your correct TonKeeper address.`).catch(() => {});
      return res.status(200).json({ ok: true });
    }
    // ── Wallet change: accept / deny ──
    if (data.startsWith('wc_ok_') || data.startsWith('wc_no_')) {
      const ok = data.startsWith('wc_ok_');
      const target = data.slice(6);
      if (ok) await users.updateOne({ telegramId: target, walletChangeStatus: 'pending' }, { $set: { walletChangeStatus: 'approved' } });
      else await users.updateOne({ telegramId: target, walletChangeStatus: 'pending' }, { $unset: { walletChangeStatus: '' } });
      await edit(chatId, msgId, `${ok ? '✅ Wallet change accepted' : '❌ Wallet change denied'}: <code>${target}</code>`, { reply_markup: backKb });
      await send(target, ok ? '✅ <b>Wallet change approved.</b>\n\nOpen Profile → Withdraw and enter your new TonKeeper address.' : '❌ <b>Wallet change denied.</b>').catch(() => {});
      return res.status(200).json({ ok: true });
    }

    // ── Signup Bursts (ported from NEWTUBE) ────────────────────
    if (data === 'a_signups' || data.startsWith('sb_')) {
      await handleSignupCallback(data, { db, chatId, msgId, send, edit, backKb });
      return res.status(200).json({ ok: true });
    }

    // ── Lock / Unlock (bot-pattern alerts) ──────────────────────
    if (/^(un)?lock_/.test(data)) {
      const lk = data.startsWith('lock_');
      const target = data.replace(/^(un)?lock_/, '');
      await users.updateOne({ telegramId: target }, lk
        ? { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'admin' } }
        : { $set: { accountLocked: false }, $unset: { accountLockedAt: '', accountLockedReason: '' } });
      await edit(chatId, msgId, `${lk ? '🔒 Locked' : '🔓 Unlocked'}: <code>${target}</code>`, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    // ── User-created tasks: review queue ────────────────────────
    if (data === 'a_review') {
      const list = await tasks.find({ reviewStatus: 'pending_review' }).sort({ createdAt: 1 }).limit(10).toArray();
      await edit(chatId, msgId, list.length ? `🕐 <b>${list.length} task(s) waiting for review</b>` : '🕐 No tasks waiting for review.', { reply_markup: backKb });
      for (const t of list) {
        await send(chatId, `📋 <b>${t.title}</b>\n🔗 ${t.link}\n👥 ${t.maxCompletions} slots · 💰 ${t.reward} MM$/person\n👤 Creator: <code>${t.createdBy}</code>`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `tr_ok_${t.id}` }, { text: '❌ Reject', callback_data: `tr_no_${t.id}` }]] } });
      }
      return res.status(200).json({ ok: true });
    }
    if (data.startsWith('tr_ok_') || data.startsWith('tr_no_')) {
      const ok = data.startsWith('tr_ok_');
      const id = data.slice(6);
      const r = await tasks.findOneAndUpdate({ id, reviewStatus: 'pending_review' },
        { $set: ok ? { reviewStatus: 'approved', active: true, approvedAt: new Date() } : { reviewStatus: 'rejected', active: false, rejectedAt: new Date() } });
      const t = r?.value !== undefined ? r.value : r;
      if (!t) { await edit(chatId, msgId, 'Already reviewed.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
      await edit(chatId, msgId, `${ok ? '✅ Approved' : '❌ Rejected'}: <b>${t.title}</b>`, { reply_markup: backKb });
      await send(t.createdBy, ok ? `✅ <b>Your task is live!</b>\n\n📋 ${t.title}\nUsers can now complete it in the Tasks tab.`
        : `❌ <b>Your task was not approved.</b>\n\n📋 ${t.title}\nPlease contact support for a refund or to fix it.`).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    // ── Admin menu buttons ────────────────────────────────────
    if (data === 'a_menu') {
      await edit(chatId, msgId, '👑 <b>Gram Edge Farm Admin Panel</b>\n\nSelect an option:', { reply_markup: adminKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_stats') {
      const total   = await users.countDocuments();
      const today   = new Date(); today.setHours(0,0,0,0);
      const newToday = await users.countDocuments({ createdAt: { $gte: today } });
      const pendingW = await withdrawals.countDocuments({ status: 'pending' });
      const taskCnt = await tasks.countDocuments({ active: true });
      const egAgg   = await users.aggregate([{ $group: { _id: null, t: { $sum: '$egBalance' } } }]).toArray();
      await edit(chatId, msgId,
        `📊 <b>Dashboard</b>\n\n` +
        `👥 Total Users: <b>${total}</b>\n` +
        `🆕 Today Joined: <b>${newToday}</b>\n` +
        `📋 Active Tasks: <b>${taskCnt}</b>\n` +
        `⏳ Pending Withdrawals: <b>${pendingW}</b>\n` +
        `💰 Total MM$: <b>${egAgg[0]?.t || 0}</b>`,
        { reply_markup: backKb }
      );
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_pending') {
      const list = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
      if (!list.length) {
        await edit(chatId, msgId, '✅ No pending withdrawals.', { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }
      await edit(chatId, msgId, `💸 <b>${list.length} pending withdrawal(s)</b> — sending details below:`, { reply_markup: backKb });
      for (const w of list) {
        await send(chatId,
          `💸 <b>Withdrawal Request</b>\n\n` +
          `👤 <code>${w.telegramId}</code> (@${w.username || '?'})\n` +
          `💰 ${w.egAmount} MM$ → <b>${w.usdtAmount} USDT</b>\n` +
          `📤 Method: <b>${w.method}</b>\n` +
          `📍 Address: <code>${w.address}</code>\n` +
          `📅 ${new Date(w.createdAt).toLocaleString()}`,
          { reply_markup: { inline_keyboard: [[
            { text: '✅ Approve', callback_data: `wd_approve_${w._id}` },
            { text: '❌ Reject',  callback_data: `wd_reject_${w._id}`  },
          ]]}}
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_user') {
      state[fromId] = { step: 'user_lookup' };
      await edit(chatId, msgId, '👤 Send the <b>Telegram numeric ID</b> of the user:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_toprefer') {
      const top = await users.find().sort({ totalReferred: -1 }).limit(20).toArray();
      let out = '🏆 <b>All-time Top 20 Referrers</b>\n\n';
      top.forEach((u, i) => { out += `${i+1}. @${u.username || u.firstName} — <b>${u.totalReferred || 0}</b> refs\n`; });
      await edit(chatId, msgId, out || 'No data yet.', { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_weekly') {
      const weekAgo = new Date(Date.now() - 7*24*60*60*1000);
      const pipeline = [
        { $match: { createdAt: { $gte: weekAgo }, referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 20 },
      ];
      const weekly = await users.aggregate(pipeline).toArray();
      let out = '📅 <b>Weekly Top 20 Referrers</b>\n\n';
      for (let i = 0; i < weekly.length; i++) {
        const u = await users.findOne({ telegramId: weekly[i]._id });
        out += `${i+1}. @${u?.username || u?.firstName || weekly[i]._id} — <b>${weekly[i].count}</b> refs\n`;
      }
      await edit(chatId, msgId, out || 'No data this week.', { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_addtask') {
      state[fromId] = { step: 'task_title' };
      await edit(chatId, msgId,
        `📋 <b>Add Task — Step 1/4</b>\n\nEnter the <b>task title</b>:`,
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } }
      );
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_tasklist') {
      const list = await tasks.find({ active: true }).sort({ createdAt: -1 }).limit(20).toArray();
      if (!list.length) {
        await edit(chatId, msgId, '📋 No active tasks.', { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }
      await edit(chatId, msgId, `📝 <b>${list.length} active task(s)</b> — details below:`, { reply_markup: backKb });
      for (const t of list) {
        await send(chatId,
          `📋 <b>${t.title}</b>\n` +
          `💰 Reward: <b>${t.reward} MM$</b>\n` +
          `👥 Completed: <b>${t.completedCount || 0}</b>${t.maxCompletions ? ` / ${t.maxCompletions}` : ' / Unlimited'}\n` +
          `🔗 ${t.link || 'No link'}\n` +
          `🔧 Type: <b>${t.type}</b>`,
          { reply_markup: { inline_keyboard: [[{ text: '🗑 Remove Task', callback_data: `task_del_${t.id}` }]] } }
        );
      }
      return res.status(200).json({ ok: true });
    }

    // ── Remove task ────────────────────────────────────────────
    if (data.startsWith('task_del_')) {
      const taskId = data.replace('task_del_', '');
      await tasks.updateOne({ id: taskId }, { $set: { active: false } });
      await edit(chatId, msgId, `🗑 Task removed: <code>${taskId}</code>`, { reply_markup: backKb });
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_addpromo') {
      state[fromId] = { step: 'promo_count' };
      await edit(chatId, msgId,
        '🎟 <b>Create Promo Codes</b>\n\nHow many codes to generate?\n(e.g. 5 = 5 unique codes)',
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } }
      );
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_broadcast') {
      state[fromId] = { step: 'broadcast_msg' };
      await edit(chatId, msgId, '📢 Type your <b>broadcast message</b>:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }

    if (data === 'bc_addlink') {
      const s = state[fromId];
      if (!s || s.step !== 'broadcast_link_choice') return res.status(200).json({ ok: true });
      s.step = 'broadcast_link_url';
      await edit(chatId, msgId, '🔗 Link-er URL den (http:// othoba https:// diye shuru):');
      return res.status(200).json({ ok: true });
    }

    if (data === 'bc_skip') {
      const s = state[fromId];
      if (!s || s.step !== 'broadcast_link_choice') return res.status(200).json({ ok: true });
      const msgText = s.text;
      delete state[fromId];
      await runBroadcast(chatId, users, msgText, null);
      return res.status(200).json({ ok: true });
    }

    if (data === 'a_sendeg') {
      state[fromId] = { step: 'sendeg_id' };
      await edit(chatId, msgId, '💰 Enter <b>Telegram ID</b> to send MM$ to:', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
      return res.status(200).json({ ok: true });
    }


    return res.status(200).json({ ok: true });
  }

  // ══════════════════════════════════════════════════════════════
  // TEXT MESSAGES
  // ══════════════════════════════════════════════════════════════
  const msg = update.message;
  if (!msg?.text) return res.status(200).json({ ok: true });

  const fromId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  // ── /start ─────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    await users.updateOne({ telegramId: fromId }, { $unset: { botBlocked: '' } }).catch(() => {});
    if (fromId === String(ADMIN_ID)) {
      await send(chatId, `👑 <b>Gram Edge Farm Admin Panel</b>\n\nWelcome back, Admin!`, { reply_markup: adminKb });
      return res.status(200).json({ ok: true });
    }

    const user = await users.findOne({ telegramId: fromId });
    const ref  = user?.referCode || '';
    await sendPhoto(chatId, START_PHOTO,
      `🥚 <b>Welcome to Gram Edge Farm!</b>\n\nWatch ads · Complete tasks · Withdraw crypto!\n\n💰 TonKeeper USDT withdrawals\n👥 Earn 250 MM$ per referral + 15% of their withdrawals`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🚀 Open Gram Edge Farm', web_app: { url: APP_URL } }],
        [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL+'?startapp='+ref)}&text=${encodeURIComponent('🥚 Join Gram Edge Farm! Earn MM$ coins!')}` }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // ── Admin multi-step flows ──────────────────────────────────
  if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

  const s = state[fromId];
  if (!s) {
    await send(chatId, '👑 <b>Gram Edge Farm Admin Panel</b>', { reply_markup: adminKb });
    return res.status(200).json({ ok: true });
  }

  // User lookup
  if (s.step === 'user_lookup') {
    const u = await users.findOne({ telegramId: text });
    delete state[fromId];
    if (!u) { await send(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
    const wCount = await withdrawals.countDocuments({ telegramId: text });
    await send(chatId,
      `👤 <b>User Info</b>\n\n` +
      `ID: <code>${u.telegramId}</code>\n` +
      `Name: <b>${u.firstName}</b> (@${u.username || 'none'})\n` +
      `💰 Balance: <b>${u.egBalance} MM$</b>\n` +
      `👥 Referrals: <b>${u.totalReferred || 0}</b>\n` +
      `🎁 Ref Earned: <b>${u.totalRefEarnedEG || 0} MM$</b>\n` +
      `📤 Withdrawals: <b>${wCount}</b>\n` +
      `📺 Ads Watched: <b>${u.totalAdsWatched || 0}</b>\n` +
      `🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
      `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()}`,
      { reply_markup: { inline_keyboard: [
        [u.isBanned
          ? { text: '✅ Unban User', callback_data: `unban_${u.telegramId}` }
          : { text: '🚫 Ban User',   callback_data: `ban_${u.telegramId}` }
        ],
        [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // Send MM$
  if (s.step === 'sendeg_id') {
    s.targetId = text; s.step = 'sendeg_amount';
    await send(chatId, `💰 How many <b>MM$</b> to send to <code>${text}</code>?`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'sendeg_amount') {
    const amt = parseInt(text);
    if (!amt || isNaN(amt)) { await send(chatId, '❌ Invalid number'); return res.status(200).json({ ok: true }); }
    const u = await users.findOne({ telegramId: s.targetId });
    delete state[fromId];
    if (!u) { await send(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
    await users.updateOne({ telegramId: s.targetId }, { $inc: { egBalance: amt } });
    await send(chatId, `✅ Sent <b>${amt} MM$</b> to <code>${s.targetId}</code>`, { reply_markup: adminKb });
    await send(s.targetId, `🎁 You received <b>${amt} MM$</b> from admin!`);
    return res.status(200).json({ ok: true });
  }

  // Broadcast — step 1: capture message text, then ask about a link button
  if (s.step === 'broadcast_msg') {
    s.text = text;
    s.step = 'broadcast_link_choice';
    await send(chatId,
      `📢 <b>Message preview:</b>\n\n${text}\n\n` +
      `Ekta link button add korte chan?`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔗 Add Link Button', callback_data: 'bc_addlink' }],
        [{ text: '⏭ Skip — Send Now', callback_data: 'bc_skip' }],
      ]}}
    );
    return res.status(200).json({ ok: true });
  }

  // Broadcast — step 2a: waiting for the URL
  if (s.step === 'broadcast_link_url') {
    if (!/^https?:\/\//i.test(text)) {
      await send(chatId, '❌ Link ta http:// othoba https:// diye shuru hote hobe. Abar den:');
      return res.status(200).json({ ok: true });
    }
    s.linkUrl = text;
    s.step = 'broadcast_link_text';
    await send(chatId, `🔗 Button-er upor ki lekha thakbe? (e.g. "Open App")`);
    return res.status(200).json({ ok: true });
  }

  // Broadcast — step 2b: waiting for the button label, then send
  if (s.step === 'broadcast_link_text') {
    const btnText = text;
    const linkUrl = s.linkUrl;
    const msgText = s.text;
    delete state[fromId];
    await runBroadcast(chatId, users, msgText, { inline_keyboard: [[{ text: btnText, url: linkUrl }]] });
    return res.status(200).json({ ok: true });
  }

  // Promo — auto generate
  if (s.step === 'promo_count') {
    const count = parseInt(text);
    if (!count || isNaN(count) || count < 1 || count > 50) { await send(chatId, '❌ Enter a number between 1 and 50:'); return res.status(200).json({ ok: true }); }
    s.count = count; s.step = 'promo_reward';
    await send(chatId, `🎟 Generating <b>${count}</b> codes\n\nEnter <b>MM$ reward</b> per code:`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'promo_reward') {
    s.reward = parseInt(text);
    if (!s.reward || isNaN(s.reward)) { await send(chatId, `❌ Invalid. Enter MM$ reward:`); return res.status(200).json({ ok: true }); }
    s.step = 'promo_maxuses';
    await send(chatId, `Reward: <b>${s.reward} MM$</b>\n\nMax uses per code? (0 = unlimited):`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'promo_maxuses') {
    const maxUses = parseInt(text) || 9999;
    delete state[fromId];
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24hr
    const generated = [];
    for (let i = 0; i < s.count; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
      await promos.insertOne({ code, reward: s.reward, currency: 'mm', maxUses, usedCount: 0, expiresAt: expireAt, createdAt: new Date() });
      generated.push(code);
    }
    const codeList = generated.map((c, i) => `${i+1}. <code>${c}</code>`).join('\n');
    await send(chatId,
      `✅ <b>${s.count} Promo Code(s) Created!</b>\n\n` +
      `💰 Reward: <b>${s.reward} MM$</b> each\n` +
      `👥 Max uses: <b>${maxUses}</b>\n` +
      `⏰ Expires: <b>24 hours</b>\n\n` +
      `📋 <b>Codes:</b>\n${codeList}`,
      { reply_markup: adminKb }
    );
    // 📢 send the new code(s) to ALL users automatically (runs in the background; you get a summary when done)
    const promoText = `🎁 <b>New Promo Code${generated.length > 1 ? 's' : ''}!</b>\n\n` +
      `${generated.map(c => `<code>${c}</code>`).join('\n')}\n\n` +
      `💰 <b>${s.reward} MM$</b> each · ⏰ valid 24 hours${maxUses < 9999 ? ` · first ${maxUses} users only` : ''}\n\n` +
      `Open the app → <b>Home</b> → <b>Promo Code</b> and enter ${generated.length > 1 ? 'a code' : 'the code'}.`;
    runBroadcast(chatId, users, promoText, { inline_keyboard: [[{ text: '🎁 Open Gram Edge Farm', web_app: { url: APP_URL } }]] }, { raw: true }).catch(e => console.error('promo broadcast failed:', e));
    return res.status(200).json({ ok: true });
  }

  // Task creation — 5 steps
  if (s.step === 'task_title') { s.title = text; s.step = 'task_link'; await send(chatId, `📋 <b>Step 2/4</b>\n\nTitle: ✅ <b>${s.title}</b>\n\nEnter <b>task link</b> (or type <code>none</code>):`); return res.status(200).json({ ok: true }); }
  if (s.step === 'task_link') { s.link = text === 'none' ? '' : text; s.step = 'task_reward'; await send(chatId, `📋 <b>Step 3/4</b>\n\nEnter <b>MM$ reward</b> amount (50,000 MM$ = $1):`); return res.status(200).json({ ok: true }); }
  if (s.step === 'task_reward') {
    s.reward = parseInt(text);
    if (!s.reward || isNaN(s.reward)) { await send(chatId, '❌ Invalid reward. Enter a number:'); return res.status(200).json({ ok: true }); }
    s.step = 'task_quantity';
    await send(chatId, `📋 <b>Step 4/4</b>\n\nHow many users can complete this task?\n(Enter number, or <code>0</code> for unlimited):`);
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'task_quantity') {
    s.maxCompletions = parseInt(text) || 0;
    s.type = 'none';
    s.step = 'task_confirm';
    const preview =
      `📋 <b>Task Preview:</b>\n\n` +
      `Title: <b>${s.title}</b>\n` +
      `Link: ${s.link || 'none'}\n` +
      `Reward: <b>${s.reward} MM$</b>\n` +
      `Max: <b>${s.maxCompletions || 'Unlimited'}</b>\n\n` +
      `Type <b>CONFIRM</b> to save:`;
    await send(chatId, preview, { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
    return res.status(200).json({ ok: true });
  }
  if (s.step === 'task_confirm') {
    if (text.toUpperCase() !== 'CONFIRM') { await send(chatId, '❌ Type <b>CONFIRM</b> to save:'); return res.status(200).json({ ok: true }); }
    delete state[fromId];
    const taskId = 'task_' + Date.now();
    await tasks.insertOne({ id: taskId, title: s.title, link: s.link, reward: s.reward, maxCompletions: s.maxCompletions, type: s.type, active: true, createdAt: new Date(), completedCount: 0 });
    await send(chatId,
      `✅ <b>Task Created!</b>\n\n📋 ${s.title}\n💰 ${s.reward} MM$\n🔗 ${s.link || 'No link'}\n👥 Max: ${s.maxCompletions || 'Unlimited'}`,
      { reply_markup: adminKb }
    );
    return res.status(200).json({ ok: true });
  }

  // Default — show menu
  await send(chatId, '👑 <b>Gram Edge Farm Admin Panel</b>', { reply_markup: adminKb });
  res.status(200).json({ ok: true });
}
