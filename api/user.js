// FILE PATH: api/user.js
// (GitHub repo te ei path e file ta rakhbe: api/user.js)
//
// Handles /api/user (register / fetch / heartbeat) plus small
// action-routed extras that used to be their own files:
//   ?action=ipcheck    — GET,  was api/ipcheck.js
//   ?action=ipswitch   — POST, was the POST branch of api/ipcheck.js
// Merged in because Vercel's free (Hobby) plan caps a project at 12
// serverless functions total — every file under /api counts as one,
// so folding related small endpoints into the file they're closest to
// keeps headroom for future features instead of burning a slot each time.

import { getDb } from '../lib/mongodb.js';
import { verifyTelegramInit } from '../lib/auth.js';
import { checkReferralVelocity, alertIpSignupVelocity } from '../lib/velocity.js';
import { getClientIp, checkDevice, claimDevice, claimDeviceForUser, getOwnerPublicInfo, registryKey, recordSignupAndCheckVelocity, IP_SIGNUP_VELOCITY_THRESHOLD } from '../lib/ipRegistry.js';
import { checkAndRecordFingerprint } from '../lib/fingerprintCheck.js';
import { isRegistryBanned } from '../lib/banRegistry.js';
import { REF } from '../lib/refReward.js';

const MAX_IP_SWITCHES = 2;

// Referral: referrer gets this many MM$ the moment a friend joins via their link.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || req.body?.action;

  try {
    const db = await getDb();
    const users = db.collection('users');

    // ── GET /api/user?action=ipcheck  (one account per DEVICE; fingerprint `fp`, IP only as soft fallback) ──
    if (req.method === 'GET' && action === 'ipcheck') {
      const { telegramId, fp = '' } = req.query;
      const initData = req.query.initData || '';
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) return res.status(403).json({ error: 'Invalid Telegram session' });

      const tgId = String(telegramId);
      const chk = await checkDevice(db, fp, getClientIp(req), tgId);
      if (chk.fallbackCollision) await users.updateOne({ telegramId: tgId }, { $set: { ipFallbackFlag: true } });
      if (!chk.blocked) {
        if (chk.unclaimed && await users.findOne({ telegramId: tgId }, { projection: { _id: 1 } })) await claimDevice(db, chk.key, tgId);
        return res.status(200).json({ success: true, conflict: false });
      }
      const owner = await getOwnerPublicInfo(db, chk.ownerId);
      const me = await users.findOne({ telegramId: tgId }, { projection: { ipSwitchCount: 1 } });
      return res.status(200).json({ success: true, conflict: true, owner, switchesLeft: Math.max(0, MAX_IP_SWITCHES - (me?.ipSwitchCount || 0)) });
    }

    // ── POST /api/user  {action:'ipswitch'} ────────────────────
    if (req.method === 'POST' && action === 'ipswitch') {
      const { telegramId, initData, fp = '' } = req.body;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) return res.status(403).json({ error: 'Invalid Telegram session' });
      const tgId = String(telegramId);
      const ip = getClientIp(req);
      const key = registryKey(fp, ip);
      if (!key) return res.status(400).json({ error: 'Could not determine your device.' });

      const user = await users.findOne({ telegramId: tgId });
      const used = user?.ipSwitchCount || 0;
      if (used >= MAX_IP_SWITCHES) return res.status(403).json({ error: 'No account switches remaining for this account.' });
      const chk = await checkDevice(db, fp, ip, tgId);
      if (!chk.blocked) return res.status(200).json({ success: true, alreadyOwner: true });

      const r = await claimDeviceForUser(db, key, tgId);
      if (!r.ok) return res.status(429).json({ error: `This device was switched recently. Try again in ${Math.ceil(r.retryAfterMs / 3600000)}h.` });
      if (user) await users.updateOne({ telegramId: tgId }, { $inc: { ipSwitchCount: 1 } });
      return res.status(200).json({ success: true, switchesLeft: Math.max(0, MAX_IP_SWITCHES - (used + 1)) });
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
      const { telegramId, username, firstName, referCode, initData, fp = '' } = req.body;

      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const tgUser = verifyTelegramInit(initData);
      if (!tgUser || String(tgUser.id) !== String(telegramId)) {
        return res.status(403).json({ error: 'Invalid Telegram session' });
      }

      const tgId = String(telegramId);
      const clientIp = getClientIp(req);
      // One request does both jobs (the app used to call ipcheck first, then this): load the user and run the device check together.
      const [existing, chk] = await Promise.all([
        users.findOne({ telegramId: tgId }),
        checkDevice(db, fp, clientIp, tgId),
      ]);
      if (chk.fallbackCollision && existing) await users.updateOne({ telegramId: tgId }, { $set: { ipFallbackFlag: true } });
      if (chk.blocked) {
        // another account owns this device: do NOT create/open anything (also means no referral reward for a blocked sign-up)
        const owner = await getOwnerPublicInfo(db, chk.ownerId);
        return res.status(200).json({
          success: true, conflict: true, owner,
          switchesLeft: Math.max(0, MAX_IP_SWITCHES - (existing?.ipSwitchCount || 0)),
        });
      }
      if (existing && chk.unclaimed) await claimDevice(db, chk.key, tgId);

      if (existing) {
        checkAndRecordFingerprint(db, tgId, fp).catch(() => {}); // soft multi-account flag (admin review only)
        const updated = await users.findOneAndUpdate(
          { telegramId: tgId },
          { $set: { lastActive: new Date() }, $inc: { appOpens: 1 } },
          { returnDocument: 'after' }
        );
        const userDoc = updated?.value || updated;
        return res.status(200).json({ success: true, user: userDoc, isNew: false });
      }

      // permanently banned Telegram IDs can never open a fresh account
      if (await isRegistryBanned(db, tgId)) return res.status(403).json({ error: 'Account banned' });

      const myReferCode =
        'TEP' + tgId.slice(-5) + Math.random().toString(36).slice(2, 5).toUpperCase();

      const newUser = {
        telegramId: tgId,
        username: username || '',
        firstName: firstName || 'User',
        egBalance: 0,
        referCode: myReferCode,
        referredBy: null,
        totalReferred: 0,
        totalRefEarned: 0,
        totalRefEarnedEG: 0,
        dailyClaimLast: null,
        adTasks: {},
        totalAdsWatched: 0,
        completedTasks: [],
        promosUsed: [],
        isBanned: false,
        appOpens: 1,
        withdrawPending: false,
        ipSwitchCount: 0,
        signupIp: clientIp,
        createdAt: new Date(),
        lastActive: new Date(),
      };

      // bot-farm guard: many NEW accounts from one IP in minutes -> locked (no withdraw / ad rewards) until admin reviews
      const { count: ipSignups } = await recordSignupAndCheckVelocity(db, clientIp);
      if (ipSignups >= IP_SIGNUP_VELOCITY_THRESHOLD) {
        newUser.accountLocked = true; newUser.accountLockedAt = new Date(); newUser.accountLockedReason = 'ip_signup_velocity';
      }
      alertIpSignupVelocity(clientIp, ipSignups, tgId); // tells the admin (first time + every 10th)

      if (referCode) {
        const referrer = await users.findOne({ referCode });
        if (referrer && referrer.telegramId !== tgId) {
          newUser.referredBy = referrer.telegramId;
          newUser.refProg = { join: true };        // marks a friend of the NEW referral system (see lib/refReward.js)
          const payJoin = !referrer.isBanned && !referrer.accountLocked && !newUser.accountLocked;
          if (payJoin) newUser.refBonusGenerated = REF.join;
          // also remember WHEN each signup happened (last 50) so referral velocity can be measured
          const after = await users.findOneAndUpdate(
            { telegramId: referrer.telegramId },
            { $inc: { totalReferred: 1, ...(payJoin ? { egBalance: REF.join, totalRefEarnedEG: REF.join } : {}) }, // +50 MM$ for the join; the other milestones are paid later by lib/refReward.js
              $push: { recentReferralSignups: { $each: [new Date()], $slice: -50 } } },
            { returnDocument: 'after' }
          );
          checkReferralVelocity(db, after?.value !== undefined ? after.value : after).catch(() => {}); // alert-only, never blocks the signup
        }
      }

      await users.insertOne(newUser);
      const devKey = registryKey(fp, clientIp);
      if (devKey && !devKey.startsWith('ip:')) { const c = await checkDevice(db, fp, clientIp, tgId); if (c.unclaimed) await claimDevice(db, devKey, tgId); }
      checkAndRecordFingerprint(db, tgId, fp).catch(() => {});
      return res.status(200).json({ success: true, user: newUser, isNew: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('user.js error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
        }
