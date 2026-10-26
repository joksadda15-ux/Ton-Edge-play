// FILE PATH: api/payments.js
// (GitHub repo te ei path e file ta rakhbe: api/payments.js)
// TON deposit -> "Create Task" (ported from NEWTUBE api/payments.js, adapted to Gram Edge Farm).
//   POST /api/payments {action:'create'|'cancel', telegramId, initData, title, url, package|orderId}
//   GET  /api/payments?action=status|myTasks&telegramId&initData[&orderId]
//   cron: GET/POST /api/payments?cron=checkDeposits&secret=CRON_SECRET   (every 1 min from cron-job.org)
// Payments are matched ON-CHAIN by the memo (comment). The only place an order flips pending -> paid is the cron.
import { getDb } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { tgSend, checkBotAdmin } from '../lib/tg.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { isCronAuthorized } from '../lib/cronAuth.js';
import { TON_RECEIVE_ADDRESS, randomTonMemo, buildTonDeepLink, fetchRecentTonTransactions } from '../lib/tonPay.js';

// ===== EDIT HERE =====
export const TASK_REWARD_MM = 10;            // MM$ every completion of a user-created task pays
export const TASK_PACKAGES = {               // taskCount completions for X TON
  100:  { taskCount: 100,  priceNanoTon: 150_000_000 },
  200:  { taskCount: 200,  priceNanoTon: 300_000_000 },
  500:  { taskCount: 500,  priceNanoTon: 750_000_000 },
  1000: { taskCount: 1000, priceNanoTon: 1_500_000_000 },
};
const ORDER_EXPIRY_MIN = 15;
// =====================
const ADMIN_ID = process.env.ADMIN_ID;
const MIN_ACCEPT_RATIO = 0.97;
const LATE_GRACE_MS = 7 * 24 * 3600 * 1000;
const MAX_TITLE = 80;
const esc = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let indexReady = false;
async function ensureIndexes(db) {
  if (indexReady) return; indexReady = true;
  await db.collection('taskCreateOrders').createIndex({ memo: 1 }, { unique: true }).catch(() => {});
}

function orderResponse(o) {
  return { ok: true, order: { id: String(o._id), memo: o.memo, amountNanoTon: o.amountNanoTon, taskCount: o.taskCount,
    address: TON_RECEIVE_ADDRESS, status: o.status, expiresAt: o.expiresAt, deepLink: buildTonDeepLink(o.amountNanoTon, o.memo) } };
}

// Two kinds of task (same as NEWTUBE):
//   'link' = Mini App / website link. Users open it and wait; there is no way to prove they really used it.
//   'api'  = Channel / Group join. Telegram itself proves the join, so the bot must be admin of that channel/group.
function buildDraft(b) {
  const title = String(b.title || '').trim();
  if (!title) return { error: 'missing_fields' };
  if (title.length > MAX_TITLE) return { error: 'title_too_long' };
  const verifyType = b.verifyType === 'api' ? 'api' : b.verifyType === 'link' ? 'link' : null;
  if (!verifyType) return { error: 'missing_fields' };
  if (verifyType === 'api') {
    let name = String(b.channelUsername || '').trim().replace(/^@/, '');
    const m = name.match(/t\.me\/([a-zA-Z0-9_]+)/);        // a pasted https://t.me/name link works too
    if (m) name = m[1];
    if (!/^[a-zA-Z0-9_]{4,}$/.test(name)) return { error: 'invalid_channel' };
    return { draft: { title, verifyType, channelId: `@${name}`, url: `https://t.me/${name}` } };
  }
  const url = String(b.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return { error: 'invalid_url' };
  return { draft: { title, verifyType, channelId: null, url } };
}

export default async function handler(req, res) {
  try {
    const db = await getDb();
    await ensureIndexes(db);
    if (req.query?.cron === 'checkDeposits') return cronHandler(req, res, db);

    const src = req.method === 'GET' ? req.query : (req.body || {});
    const tgUser = verifyTelegramInit(src.initData);
    if (!tgUser || String(tgUser.id) !== String(src.telegramId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const tgId = String(tgUser.id);
    const user = await db.collection('users').findOne({ telegramId: tgId }, { projection: { isBanned: 1, accountLocked: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    const orders = db.collection('taskCreateOrders');

    // "Verify bot": is our bot an admin of that channel/group? (asked BEFORE paying, and again inside create)
    if (req.method === 'POST' && src.action === 'verifyBot') {
      const { draft, error } = buildDraft({ title: 'x', verifyType: 'api', channelUsername: src.channelUsername });
      if (error) return res.status(400).json({ ok: false, error });
      const chk = await checkBotAdmin(draft.channelId);
      if (!chk.ok) return res.status(200).json({ ok: false, error: chk.error });
      return res.status(200).json({ ok: true, channel: draft.channelId, title: chk.title });
    }

    if (req.method === 'POST' && src.action === 'create') {
      if (!TON_RECEIVE_ADDRESS) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
      if (user.accountLocked) return res.status(403).json({ ok: false, error: 'account_locked' });
      const pkg = TASK_PACKAGES[String(src.package)];
      if (!pkg) return res.status(400).json({ ok: false, error: 'invalid_package' });
      const { draft, error } = buildDraft(src);
      if (error) return res.status(400).json({ ok: false, error });
      if (draft.verifyType === 'api') {            // nobody pays for a task that can never be verified
        const chk = await checkBotAdmin(draft.channelId);
        if (!chk.ok) return res.status(chk.error === 'server_error' ? 500 : 400).json({ ok: false, error: chk.error });
      }
      const now = new Date();
      const existing = await orders.findOne({ userId: tgId, status: 'pending', expiresAt: { $gt: now } });
      if (existing) return res.status(200).json(orderResponse(existing));
      const expiresAt = new Date(now.getTime() + ORDER_EXPIRY_MIN * 60000);
      let order = null;
      for (let i = 0; i < 3 && !order; i++) {
        try {
          const doc = { userId: tgId, memo: randomTonMemo('TC'), package: String(src.package), taskCount: pkg.taskCount,
            amountNanoTon: pkg.priceNanoTon, draft, status: 'pending', createdAt: now, expiresAt };
          const r = await orders.insertOne(doc);
          order = { ...doc, _id: r.insertedId };
        } catch (e) { if (!(e?.code === 11000 && i < 2)) throw e; }
      }
      if (!order) return res.status(500).json({ ok: false, error: 'server_error' });
      return res.status(200).json(orderResponse(order));
    }

    if (req.method === 'POST' && src.action === 'cancel') {
      let id; try { id = new ObjectId(src.orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }
      await orders.updateOne({ _id: id, userId: tgId, status: 'pending' }, { $set: { status: 'expired', expiredAt: new Date(), cancelledByUser: true } });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && src.action === 'status') {
      let id; try { id = new ObjectId(src.orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }
      const o = await orders.findOne({ _id: id, userId: tgId });
      if (!o) return res.status(404).json({ ok: false, error: 'order_not_found' });
      return res.status(200).json({ ok: true, status: o.status, expiresAt: o.expiresAt });
    }

    if (req.method === 'GET' && src.action === 'myTasks') {
      // cursor pagination (newest first): `after` = _id of the last task of the previous page
      const MY_PAGE = 10;
      const q = { createdBy: tgId, isUserCreated: true };
      const after = String(src.after || '');
      if (/^[a-f0-9]{24}$/.test(after)) q._id = { $lt: new ObjectId(after) };
      const rows = await db.collection('tasks').find(q)
        .project({ title: 1, maxCompletions: 1, completedCount: 1, createdAt: 1, reviewStatus: 1, active: 1, verifyType: 1 })
        .sort({ _id: -1 }).limit(MY_PAGE + 1).toArray();
      const hasMore = rows.length > MY_PAGE;
      const page = hasMore ? rows.slice(0, MY_PAGE) : rows;
      const nextCursor = hasMore ? String(page[page.length - 1]._id) : null;
      const list = page.map(({ _id, ...t }) => t);
      return res.status(200).json({ ok: true, tasks: list, nextCursor, packages: TASK_PACKAGES, reward: TASK_REWARD_MM });
    }
    if (req.method === 'GET' && src.action === 'packages') {
      return res.status(200).json({ ok: true, packages: TASK_PACKAGES, reward: TASK_REWARD_MM });
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('payments.js error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

// ── cron: verify payments on-chain ───────────────────────────────
async function cronHandler(req, res, db) {
  if (!isCronAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!TON_RECEIVE_ADDRESS) return res.status(500).json({ ok: false, error: 'TON_RECEIVE_ADDRESS not set' });
  const txs = await fetchRecentTonTransactions(100);
  const out = await checkTaskCreate(db, txs, new Date());
  return res.status(200).json({ ok: true, ...out });
}

const MIN_PKG = Math.min(...Object.values(TASK_PACKAGES).map(p => p.priceNanoTon));
const REASONS = {
  no_matching_order: 'No order matches this comment',
  underpaid: 'Paid LESS than the package price',
  duplicate_payment: 'Second payment for an order that is already paid',
  order_cancelled_by_user: 'Order was cancelled by the user before payment arrived',
  order_too_old: 'Order expired more than 7 days ago',
};

async function checkTaskCreate(db, txs, now) {
  const orders = db.collection('taskCreateOrders');
  const tasks = db.collection('tasks');
  const unmatched = db.collection('unmatchedTonDeposits');
  const expired = await orders.updateMany({ status: 'pending', expiresAt: { $lte: now } }, { $set: { status: 'expired', expiredAt: now } });

  const incoming = [];
  for (const tx of txs) {
    const m = tx.in_msg;
    if (!m || !m.source) continue;            // outgoing transfers have no source
    const value = Number(m.value || 0);
    if (!value) continue;
    const text = String(m.message || '').trim();
    const tokens = text.toUpperCase().split(/[^A-Z0-9]+/).filter(t => t.startsWith('TC') && t.length >= 4);
    incoming.push({ value, text, tokens, hash: tx.transaction_id?.hash || null, source: m.source });
  }
  if (!incoming.length) return { expired: expired.modifiedCount, matched: 0, flagged: 0 };

  const memos = [...new Set(incoming.flatMap(i => i.tokens))];
  const byMemo = new Map((memos.length ? await orders.find({ memo: { $in: memos } }).toArray() : []).map(o => [o.memo, o]));
  const hashes = incoming.map(i => i.hash).filter(Boolean);
  const seen = new Set((hashes.length ? await unmatched.find({ _id: { $in: hashes } }, { projection: { _id: 1 } }).toArray() : []).map(d => d._id));

  let flagged = 0, matched = 0;
  const flag = async (item, reason, order) => {
    if (!item.hash || seen.has(item.hash)) return;
    seen.add(item.hash);
    const r = await unmatched.updateOne({ _id: item.hash },
      { $setOnInsert: { reason, amountNanoTon: item.value, comment: item.text.slice(0, 200), source: item.source, orderUserId: order?.userId || null, createdAt: now } },
      { upsert: true });
    if (!r.upsertedCount) return;
    flagged++;
    if (ADMIN_ID) tgSend(ADMIN_ID,
      `⚠️ <b>Unmatched TON deposit</b>\n\nReason: ${esc(REASONS[reason] || reason)}\nAmount: <b>${(item.value / 1e9).toFixed(4)} TON</b>\nComment: <code>${esc(item.text || '(none)')}</code>\nFrom: <code>${esc(item.source)}</code>\n` +
      (order ? `Order user: <code>${esc(order.userId)}</code> · expected ${(order.amountNanoTon / 1e9).toFixed(4)} TON\n` : '') +
      `Tx: <code>${esc(item.hash)}</code>\n\nNot credited automatically — check and add the task manually if the payment is real.`).catch(() => {});
  };

  for (const item of incoming) {
    const order = item.tokens.map(t => byMemo.get(t)).find(Boolean);
    if (!order) { if (item.value >= MIN_PKG * MIN_ACCEPT_RATIO) await flag(item, 'no_matching_order', null); continue; }
    if (order.status === 'paid') { if (!order.txHash || order.txHash === item.hash) continue; await flag(item, 'duplicate_payment', order); continue; }
    if (item.value < order.amountNanoTon * MIN_ACCEPT_RATIO) { await flag(item, 'underpaid', order); continue; }
    if (order.cancelledByUser) { await flag(item, 'order_cancelled_by_user', order); continue; }
    if (order.status === 'expired' && order.expiresAt && now.getTime() - new Date(order.expiresAt).getTime() > LATE_GRACE_MS) { await flag(item, 'order_too_old', order); continue; }

    // ATOMIC: this order can flip to paid (and insert its task) exactly once, however many times the tx is seen.
    const claimed = await orders.findOneAndUpdate(
      { _id: order._id, status: { $in: ['pending', 'expired'] }, cancelledByUser: { $ne: true } },
      { $set: { status: 'paid', paidAt: now, txHash: item.hash, receivedNanoTon: item.value, paidLate: order.status === 'expired' } },
      { returnDocument: 'after' }
    );
    const o = claimed?.value !== undefined ? claimed.value : claimed;
    if (!o) continue;

    const taskDoc = { id: 'task_' + Date.now() + '_' + String(o._id).slice(-4), title: o.draft.title, link: o.draft.url, reward: TASK_REWARD_MM,
      maxCompletions: o.taskCount, completedCount: 0, type: o.draft.verifyType || 'link', category: 'exclusive', verifyType: o.draft.verifyType || 'link', channelId: o.draft.channelId || null,
      active: false, reviewStatus: 'pending_review',
      isUserCreated: true, createdBy: o.userId, createdAt: now };
    const ins = await tasks.insertOne(taskDoc);
    await orders.updateOne({ _id: o._id }, { $set: { createdTaskId: ins.insertedId } });
    matched++;
    tgSend(o.userId, `✅ <b>Payment Confirmed!</b>\n\n📋 ${esc(taskDoc.title)}\n👥 ${taskDoc.maxCompletions} people can complete it (+${TASK_REWARD_MM} MM$ each)\n\n⏳ Waiting for admin review — once approved it goes live in the Tasks tab. 🎉`).catch(() => {});
    if (ADMIN_ID) tgSend(ADMIN_ID, `🆕 <b>New Task Waiting for Review</b>\n\n📋 ${esc(taskDoc.title)}\n🔗 ${esc(taskDoc.link)}\n👥 ${taskDoc.maxCompletions} slots · 💰 ${TASK_REWARD_MM} MM$/person\n\nOpen "🕐 Pending Review" in the admin panel.`).catch(() => {});
  }
  return { expired: expired.modifiedCount, matched, flagged };
      }
