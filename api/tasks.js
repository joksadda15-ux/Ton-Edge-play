// FILE PATH: api/withdraw.js
// Withdraw system (ported from NEWTUBE, adapted to MM$ / TonKeeper USDT).
//
//   GET  /api/withdraw?action=status   → balance + requirements + wallet state, in ONE call
//   GET  /api/withdraw?action=history  → the user's withdrawals
//   POST /api/withdraw                 → { address, egAmount }   create a withdrawal
//   POST /api/withdraw                 → { action:'walletChangeRequest' | 'walletChangeApply' }
//
// Rules:
//   • minimum 2,500 MM$ (= $0.05)
//   • requirement: 3 farm claims since the user's last withdrawal (never expires, nothing resets with time)
//   • 5% fee is taken from the payout
//   • the first wallet becomes the user's locked wallet; one wallet = one account
import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { tgSend } from '../lib/tg.js';

// ===== EDIT HERE =====
const MIN_WITHDRAW_EG = 2500;          // MM$  (50,000 MM$ = $1  →  2,500 MM$ = $0.05)
const EG_TO_USDT = 1 / 50000;
const FEE_PERCENT = 5;
const FARM_CLAIMS_REQUIRED = 3;        // farm claims needed since the last withdrawal (no time limit)
const TASKS_REQUIRED = 0;              // lifetime tasks needed (0 = no task requirement)
const MIN_ACCOUNT_AGE_HOURS = 0;       // first withdrawal only (0 = off)
const WALLET_CHANGE_MAX_REQUESTS = 2;  // lifetime wallet-change requests per user
const WITHDRAWALS_OPEN = process.env.WITHDRAWALS_OPEN !== '0';
// =====================

const ADMIN_ID = process.env.ADMIN_ID;
// One-tap manual payment: opens Tonkeeper with the address, USDT jetton and amount already filled in (USDT has 6 decimals)
const USDT_MASTER = process.env.TON_USDT_MASTER || 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const tonkeeperPayUrl = (addr, usd) => `https://app.tonkeeper.com/transfer/${encodeURIComponent(addr)}?jetton=${USDT_MASTER}&amount=${Math.round(Number(usd) * 1e6)}`;
const TON_ADDR_RE = /^(UQ|EQ)[A-Za-z0-9_-]{46}$/;
// farmClaims = lifetime counter (api/farm.js); farmClaimsAtWithdraw = its value when the last withdrawal was made
const recentClaims = (u) => Math.max(0, (u.farmClaims || 0) - (u.farmClaimsAtWithdraw || 0));
const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ageHoursLeft = (u) => {
  if (!MIN_ACCOUNT_AGE_HOURS || (u.withdrawalCount || 0) > 0) return 0;
  const created = u.createdAt ? new Date(u.createdAt).getTime() : 0;
  return Math.max(0, Math.ceil((created + MIN_ACCOUNT_AGE_HOURS * 3600000 - Date.now()) / 3600000));
};

async function authed(req, res, users, src) {
  const telegramId = src.telegramId;
  if (!telegramId) { res.status(400).json({ ok: false, error: 'telegramId required' }); return null; }
  const tg = verifyTelegramInit(src.initData || '');
  if (!tg || String(tg.id) !== String(telegramId)) { res.status(403).json({ ok: false, error: 'Invalid Telegram session' }); return null; }
  const user = await users.findOne({ telegramId: String(telegramId) });
  if (!user) { res.status(404).json({ ok: false, error: 'User not found' }); return null; }
  if (user.isBanned) { res.status(403).json({ ok: false, error: 'Account banned' }); return null; }
  return { user, tg };
}

// ── GET status ───────────────────────────────────────────────
async function handleStatus(req, res, db) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const a = await authed(req, res, db.collection('users'), req.query);
  if (!a) return;
  const u = a.user;
  const have = recentClaims(u);
  const tasksHave = (u.completedTasks || []).length;
  return res.status(200).json({
    ok: true,
    balance: u.egBalance || 0,
    minWithdraw: MIN_WITHDRAW_EG,
    feePercent: FEE_PERCENT,
    withdrawalsOpen: WITHDRAWALS_OPEN,
    withdrawPending: !!u.withdrawPending,
    lockedWallet: u.lockedWalletAddress ? { method: 'tonkeeper', address: u.lockedWalletAddress } : null,
    walletChange: {
      status: u.walletChangeStatus || null,
      requestsLeft: Math.max(0, WALLET_CHANGE_MAX_REQUESTS - (u.walletChangeRequests || 0)),
    },
    requirements: {
      farmRequired: FARM_CLAIMS_REQUIRED, farmHave: have, farmMet: have >= FARM_CLAIMS_REQUIRED,
      tasksRequired: TASKS_REQUIRED, tasksHave, tasksMet: tasksHave >= TASKS_REQUIRED,
      accountAgeHoursLeft: ageHoursLeft(u),
    },
  });
}

// ── GET history ──────────────────────────────────────────────
async function handleHistory(req, res, db) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const a = await authed(req, res, db.collection('users'), req.query);
  if (!a) return;
  // cursor pagination: `before` = createdAt (ms) of the last row the app already has
  const HIST_PAGE = 15;
  const q = { telegramId: String(a.user.telegramId) };
  const before = Number(req.query?.before);
  if (Number.isFinite(before) && before > 0) q.createdAt = { $lt: new Date(before) };
  const rows = await db.collection('withdrawals')
    .find(q).sort({ createdAt: -1 }).limit(HIST_PAGE + 1)
    .project({ egAmount: 1, usdtAmount: 1, status: 1, createdAt: 1 })
    .toArray();
  const hasMore = rows.length > HIST_PAGE;
  const list = hasMore ? rows.slice(0, HIST_PAGE) : rows;
  return res.status(200).json({ ok: true, history: list, nextCursor: hasMore ? new Date(list[list.length - 1].createdAt).getTime() : null });
}

// ── POST create ──────────────────────────────────────────────
async function handleCreate(req, res, db) {
  if (!WITHDRAWALS_OPEN) return res.status(403).json({ ok: false, error: 'withdrawals_closed', message: 'Withdrawals are closed right now. Requests already sent will still be processed.' });
  const users = db.collection('users');
  const a = await authed(req, res, users, req.body || {});
  if (!a) return;
  const user = a.user, tgId = String(user.telegramId);

  const amount = Math.floor(Number(req.body?.egAmount));
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount', message: 'Enter a valid amount.' });
  if (amount < MIN_WITHDRAW_EG) return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum withdrawal is ${MIN_WITHDRAW_EG.toLocaleString()} MM$.` });
  if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked', message: 'Your account is under review. Withdrawals are paused. Contact support.' });

  // wallet: the first one becomes the locked wallet; later requests always use the locked wallet
  const hasLocked = !!user.lockedWalletAddress;
  let address;
  if (hasLocked) address = user.lockedWalletAddress;
  else {
    address = String(req.body?.address || '').trim();
    if (!TON_ADDR_RE.test(address)) return res.status(400).json({ ok: false, error: 'invalid_address', message: 'Invalid TonKeeper address. It must start with UQ or EQ.' });
  }

  // one wallet = one account
  const dupUser = await users.findOne({ telegramId: { $ne: tgId }, lockedWalletAddress: address }, { projection: { telegramId: 1 } });
  const dupWd = dupUser ? null : await db.collection('withdrawals').findOne({ telegramId: { $ne: tgId }, address }, { projection: { telegramId: 1 } });
  if (dupUser || dupWd) {
    return res.status(403).json({ ok: false, error: 'wallet_in_use', message: 'This wallet is already linked to another account. One wallet can be used by one account only.' });
  }

  // requirements (re-checked atomically below)
  const tasksHave = (user.completedTasks || []).length;
  if (tasksHave < TASKS_REQUIRED) return res.status(400).json({ ok: false, error: 'need_tasks', message: `Complete ${TASKS_REQUIRED - tasksHave} more task(s) first.` });
  const left = ageHoursLeft(user);
  if (left > 0) return res.status(400).json({ ok: false, error: 'account_too_new', message: `Your account is too new. Wait ${left} more hour(s).` });
  const have = recentClaims(user);
  if (have < FARM_CLAIMS_REQUIRED) {
    return res.status(400).json({ ok: false, error: 'need_farm_claims', message: `Claim your farms ${FARM_CLAIMS_REQUIRED} times first (you have ${have}).` });
  }
  if ((user.egBalance || 0) < amount) return res.status(400).json({ ok: false, error: 'insufficient_balance', message: 'Not enough MM$.' });

  const grossUsdt = amount * EG_TO_USDT;
  const usdtAmount = parseFloat((grossUsdt * (1 - FEE_PERCENT / 100)).toFixed(4));

  const prevBaseline = user.farmClaimsAtWithdraw || 0;
  const undo = { $inc: { egBalance: amount, withdrawalCount: -1 }, $set: { withdrawPending: false, farmClaimsAtWithdraw: prevBaseline } };
  if (!hasLocked) undo.$unset = { lockedWalletAddress: '' };
  const set = { withdrawPending: true, farmClaimsAtWithdraw: user.farmClaims || 0 }; // the 3 claims are used up by this withdrawal
  if (!hasLocked) set.lockedWalletAddress = address;

  // ATOMIC GATE: balance, pending flag and the 3-farm-claims rule are all checked inside this single update,
  // so a double tap can never slip a second withdrawal through.
  const gate = await users.findOneAndUpdate(
    {
      telegramId: tgId,
      isBanned: { $ne: true },
      egBalance: { $gte: amount },
      withdrawPending: { $ne: true },
      $expr: {
        $gte: [
          { $subtract: [{ $ifNull: ['$farmClaims', 0] }, { $ifNull: ['$farmClaimsAtWithdraw', 0] }] },
          FARM_CLAIMS_REQUIRED,
        ],
      },
    },
    { $inc: { egBalance: -amount, withdrawalCount: 1 }, $set: set },
    { returnDocument: 'after' }
  );
  const updated = gate?.value || gate;
  if (!updated) {
    const again = await users.findOne({ telegramId: tgId }, { projection: { withdrawPending: 1 } });
    if (again?.withdrawPending) return res.status(409).json({ ok: false, error: 'withdraw_already_pending', message: 'You already have a withdrawal being processed. Wait until it is approved or rejected.' });
    return res.status(409).json({ ok: false, error: 'gate_failed', message: 'Could not process the withdrawal. Your balance or farm claims changed. Refresh and try again.' });
  }

  const doc = {
    telegramId: tgId,
    username: user.username || '',
    firstName: user.firstName || '',
    method: 'tonkeeper',
    address,
    egAmount: amount,
    grossUsdt: parseFloat(grossUsdt.toFixed(4)),
    feePercent: FEE_PERCENT,
    usdtAmount,                 // net amount the bot pays out
    status: 'pending',
    prevBaseline,               // restored if the admin rejects this withdrawal
    createdAt: new Date(),
  };
  let inserted;
  try {
    inserted = await db.collection('withdrawals').insertOne(doc);
  } catch (e) {
    console.error('withdraw insert failed, rolling back:', e.message);
    await users.updateOne({ telegramId: tgId }, undo).catch(() => {});
    return res.status(500).json({ ok: false, error: 'withdraw_save_failed', message: 'Could not save your request. You were not charged. Try again.' });
  }

  if (ADMIN_ID) {
    try {
      const prevApproved = await db.collection('withdrawals').countDocuments({ telegramId: tgId, status: 'approved' });
      const prevRejected = await db.collection('withdrawals').countDocuments({ telegramId: tgId, status: 'rejected' });
      const sent = await tgSend(ADMIN_ID,
        `💸 <b>New Withdraw Request</b>\n\n` +
        `👤 <code>${tgId}</code>${user.username ? ' (@' + esc(user.username) + ')' : ''}\n` +
        `💰 ${amount.toLocaleString()} MM$ → <b>${usdtAmount} USDT</b> (after ${FEE_PERCENT}% fee)\n` +
        `📤 Method: <b>tonkeeper</b>\n` +
        `📍 <code>${esc(address)}</code>\n` +
        `📊 Earlier: ✅ ${prevApproved} approved · ❌ ${prevRejected} rejected\n` +
        `🌾 Farm claims since last withdraw: <b>${have}</b> · Total claims: <b>${user.farmClaims || 0}</b>\n` +
        `👥 Referrals: <b>${user.totalReferred || 0}</b>${user.multiAccountFlag ? '\n🚩 Multi-account flag: <b>YES</b>' : ''}\n` +
        `🆔 <code>${inserted.insertedId}</code>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '✅ Approve', callback_data: `wd_approve_${inserted.insertedId}` }, { text: '❌ Reject', callback_data: `wd_reject_${inserted.insertedId}` }],
          [{ text: '💎 Pay in Tonkeeper', url: tonkeeperPayUrl(address, usdtAmount) }],
          [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${inserted.insertedId}` }],
        ] } });
      if (sent?.ok && sent.result?.message_id) {
        await db.collection('withdrawals').updateOne({ _id: inserted.insertedId }, { $set: { adminMsgChatId: ADMIN_ID, adminMsgId: sent.result.message_id } });
      }
    } catch (e) { console.error('admin withdraw notification failed:', e); /* the request is saved even if this notification fails */ }
  }

  return res.status(200).json({ ok: true, usdtAmount, balance: updated.egBalance, status: 'pending' });
}

// ── POST walletChangeRequest / walletChangeApply ─────────────
async function handleWalletChange(req, res, db, action) {
  const users = db.collection('users');
  const a = await authed(req, res, users, req.body || {});
  if (!a) return;
  const user = a.user, tgId = String(user.telegramId);
  if (!user.lockedWalletAddress) return res.status(400).json({ ok: false, error: 'no_wallet', message: 'You have no saved wallet yet. It is saved with your first withdrawal.' });

  if (action === 'walletChangeRequest') {
    if (user.withdrawPending) return res.status(409).json({ ok: false, error: 'withdraw_already_pending', message: 'Wait until your pending withdrawal is finished.' });
    const g = await users.findOneAndUpdate(
      {
        telegramId: tgId, isBanned: { $ne: true }, withdrawPending: { $ne: true },
        walletChangeStatus: { $nin: ['pending', 'approved'] },
        $or: [{ walletChangeRequests: { $exists: false } }, { walletChangeRequests: { $lt: WALLET_CHANGE_MAX_REQUESTS } }],
      },
      { $inc: { walletChangeRequests: 1 }, $set: { walletChangeStatus: 'pending', walletChangeRequestedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const gu = g?.value || g;
    if (!gu) {
      if (user.walletChangeStatus === 'pending') return res.status(409).json({ ok: false, error: 'wallet_change_pending', message: 'Your request is already waiting for the admin.' });
      if (user.walletChangeStatus === 'approved') return res.status(409).json({ ok: false, error: 'wallet_change_approved', message: 'Already approved. Enter your new wallet.' });
      return res.status(400).json({ ok: false, error: 'wallet_change_limit', message: 'No wallet-change requests left.' });
    }
    if (ADMIN_ID) {
      tgSend(ADMIN_ID,
        `🔄 <b>Wallet Change Request</b>\n\n👤 <code>${tgId}</code>${user.username ? ' (@' + esc(user.username) + ')' : ''}\n📍 Current: <code>${esc(user.lockedWalletAddress)}</code>\n🔢 Request <b>${gu.walletChangeRequests}/${WALLET_CHANGE_MAX_REQUESTS}</b>\n💰 Balance: <b>${(gu.egBalance || 0).toLocaleString()} MM$</b>`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Accept', callback_data: `wc_ok_${tgId}` }, { text: '❌ Deny', callback_data: `wc_no_${tgId}` }]] } }
      ).catch(() => {});
    }
    return res.status(200).json({ ok: true, status: 'pending' });
  }

  // walletChangeApply
  if (user.walletChangeStatus !== 'approved') return res.status(403).json({ ok: false, error: 'wallet_change_not_approved', message: 'The admin has not approved a wallet change for you.' });
  if (user.withdrawPending) return res.status(409).json({ ok: false, error: 'withdraw_already_pending', message: 'Wait until your pending withdrawal is finished.' });
  const address = String(req.body?.address || '').trim();
  if (!TON_ADDR_RE.test(address)) return res.status(400).json({ ok: false, error: 'invalid_address', message: 'Invalid TonKeeper address. It must start with UQ or EQ.' });
  const dup = await users.findOne({ telegramId: { $ne: tgId }, lockedWalletAddress: address }, { projection: { _id: 1 } });
  if (dup) return res.status(403).json({ ok: false, error: 'wallet_in_use', message: 'This wallet is already linked to another account.' });
  const done = await users.findOneAndUpdate(
    { telegramId: tgId, walletChangeStatus: 'approved', withdrawPending: { $ne: true } },
    { $set: { lockedWalletAddress: address, walletChangedAt: new Date() }, $unset: { walletChangeStatus: '' } },
    { returnDocument: 'after' }
  );
  if (!(done?.value || done)) return res.status(409).json({ ok: false, error: 'gate_failed', message: 'Could not change the wallet. Refresh and try again.' });
  if (ADMIN_ID) tgSend(ADMIN_ID, `✅ <b>Wallet changed</b>\n\n👤 <code>${tgId}</code>\n📍 <code>${esc(address)}</code>`).catch(() => {});
  return res.status(200).json({ ok: true, address });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const db = await getDb();
  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'status') return handleStatus(req, res, db);
    if (action === 'history') return handleHistory(req, res, db);
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  }
  if (req.method === 'POST') {
    const act = req.body?.action;
    if (act === 'walletChangeRequest' || act === 'walletChangeApply') return handleWalletChange(req, res, db, act);
    return handleCreate(req, res, db);
  }
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
