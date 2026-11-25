// FILE PATH: lib/backup.js
// 💾 DAILY BACKUP → sent to the admin's Telegram as one small .ndjson.gz file.
// Why Telegram: the free Atlas cluster (M0) has NO backups, and Render's free disk is wiped on every restart.
// Telegram keeps the file for free, forever, outside both. Restore with:  node api/scripts/restore-backup.js <file>
//
// Only data that CANNOT be re-created is saved (money, wallets, referrals, withdrawals, tasks, promos, bans, ad stats).
// Throw-away data (fraud traps, IP/device registry, S2S credits, order counters) is NOT saved: it expires by TTL anyway.
// User rows keep ~20 small fields (not the whole document) so the file stays tiny: ~0.5 KB per user before gzip.
import zlib from 'zlib';
import { BSON } from 'mongodb';
const { EJSON } = BSON;

const USER_FIELDS = ['telegramId', 'username', 'firstName', 'egBalance', 'referCode', 'referredBy', 'totalReferred', 'totalRefEarned', 'totalRefEarnedEG',
  'lockedWalletAddress', 'farm2', 'farmClaims', 'totalAdsWatched', 'tasksDoneTotal', 'adsgramTaskTotal', 'withdrawalsApproved', 'totalWithdrawnMM',
  'loginBonus', 'isBanned', 'bannedAt', 'accountLocked', 'createdAt', 'lastActive'];
const userProjection = { _id: 0, ...Object.fromEntries(USER_FIELDS.map((f) => [f, 1])) };  // users are matched by telegramId on restore

const PLAN = [
  { c: 'users',             q: {}, p: userProjection },
  { c: 'withdrawals',       q: {} },
  { c: 'tasks',             q: { isUserCreated: { $ne: true } } },   // admin tasks only (user-made tasks delete themselves after 5 days)
  { c: 'promos',            q: {} },
  { c: 'bannedTelegramIds', q: {} },
  { c: 'adStatsDaily',      q: {} },
  { c: 'botSettings',       q: { _id: { $ne: 'dailyNotify' } } },
];
export const MAX_FILE_MB = 45;   // Telegram bots can send files up to 50 MB

export async function buildBackup(db) {
  const gz = zlib.createGzip({ level: 6 });
  const chunks = []; let bytes = 0;
  gz.on('data', (b) => { chunks.push(b); bytes += b.length; });
  const done = new Promise((res, rej) => { gz.on('end', res); gz.on('error', rej); });
  const counts = {};
  for (const { c, q, p } of PLAN) {
    let n = 0;
    try {
      const cur = db.collection(c).find(q, p ? { projection: p } : {}).batchSize(500);
      for await (const doc of cur) {
        if (!gz.write(EJSON.stringify({ c, d: doc }, { relaxed: false }) + '\n')) await new Promise((r) => gz.once('drain', r));
        n++;
      }
    } catch (e) { counts[c] = `ERR ${String(e.message).slice(0, 40)}`; continue; }
    counts[c] = n;
  }
  gz.end(); await done;
  return { buf: Buffer.concat(chunks), counts };
}

export async function sendBackupToTelegram(buf, counts) {
  const chatId = process.env.ADMIN_ID;
  if (!chatId || !process.env.BOT_TOKEN) throw new Error('ADMIN_ID / BOT_TOKEN missing');
  const mb = buf.length / 1048576;
  if (mb > MAX_FILE_MB) throw new Error(`backup is ${mb.toFixed(1)} MB (> ${MAX_FILE_MB} MB Telegram limit)`);
  const day = new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `💾 Backup ${day} · ${mb.toFixed(2)} MB\n` + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · '));
  form.append('disable_notification', 'true');
  form.append('document', new Blob([buf], { type: 'application/gzip' }), `gef-backup-${day}.ndjson.gz`);
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram: ${j.description || r.status}`);
  return { mb: Number(mb.toFixed(2)) };
}

export async function runBackup(db) {
  const { buf, counts } = await buildBackup(db);
  const sent = await sendBackupToTelegram(buf, counts);
  return { ...sent, counts };
}
