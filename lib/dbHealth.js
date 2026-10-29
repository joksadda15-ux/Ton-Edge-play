// FILE PATH: lib/dbHealth.js
// 🗄 Database Health (admin bot): shows how full the free MongoDB (512 MB) is and PROVES whether the TTL auto-delete works.
// "Overdue" = documents that should already have been deleted by their TTL index. If that number is not 0 the TTL is NOT working.
// 🔧 Fix = repairs the TTL indexes only (never touches your data directly). Keep TTL_SPECS in sync with lib/indexes.js.
const DAY = 86400;
const MIN_WITHDRAW_EG = 2500;
export const FREE_LIMIT_MB = 512;

// col, key (the date field), secs (expireAfterSeconds), partial (partialFilterExpression), overdue (query for documents that must be gone)
export const TTL_SPECS = [
  { col: 'users', key: 'bannedAt', secs: 60 * DAY, partial: { isBanned: true }, label: 'banned users (60d)',
    overdue: (t) => ({ isBanned: true, bannedAt: { $lt: t(60 * DAY) } }) },
  { col: 'users', key: 'lastActive', secs: 90 * DAY, partial: { egBalance: { $lt: MIN_WITHDRAW_EG } }, label: 'inactive small accounts (90d)',
    overdue: (t) => ({ egBalance: { $lt: MIN_WITHDRAW_EG }, lastActive: { $lt: t(90 * DAY) } }) },
  { col: 'withdrawals', key: 'processedAt', secs: 90 * DAY, partial: { status: 'rejected' }, label: 'rejected withdrawals (90d)',
    overdue: (t) => ({ status: 'rejected', processedAt: { $lt: t(90 * DAY) } }) },
  { col: 'fingerprints', key: 'lastSeenAt', secs: 180 * DAY, label: 'device fingerprints (180d)', overdue: (t) => ({ lastSeenAt: { $lt: t(180 * DAY) } }) },
  { col: 'ipRegistry', key: 'lastSeenAt', secs: 120 * DAY, label: 'IP registry (120d)', overdue: (t) => ({ lastSeenAt: { $lt: t(120 * DAY) } }) },
  { col: 'ipSignupVelocity', key: 'updatedAt', secs: 1 * DAY, label: 'IP signup counters (1d)', overdue: (t) => ({ updatedAt: { $lt: t(1 * DAY) } }) },
  { col: 'promos', key: 'expiresAt', secs: 0, label: 'expired promo codes', overdue: (t) => ({ expiresAt: { $lt: t(0) } }) },
  { col: 'tasks', key: 'completedAt', secs: 5 * DAY, partial: { isUserCreated: true }, label: 'finished user tasks (5d)',
    overdue: (t) => ({ isUserCreated: true, completedAt: { $lt: t(5 * DAY) } }) },
  { col: 'taskCreateOrders', key: 'expiredAt', secs: 30 * DAY, partial: { status: 'expired' }, label: 'expired payment orders (30d)',
    overdue: (t) => ({ status: 'expired', expiredAt: { $lt: t(30 * DAY) } }) },
  { col: 'adsgramS2S', key: 'at', secs: 1 * DAY, label: 'Adsgram S2S credits (1d)', lazy: true, overdue: (t) => ({ at: { $lt: t(1 * DAY) } }) },
  { col: 'adminClusters', key: 'createdAt', secs: 7 * DAY, label: 'saved burst lists (7d)', lazy: true, overdue: (t) => ({ createdAt: { $lt: t(7 * DAY) } }) },
];

const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

// pure: what is the state of ONE TTL index?  → 'ok' | 'missing' | 'no_ttl' | 'wrong'
export function judgeIndex(spec, indexes) {
  const ix = (indexes || []).find((i) => Object.keys(i.key || {}).length === 1 && i.key[spec.key] === 1);
  if (!ix) return { state: 'missing' };
  if (ix.expireAfterSeconds == null) return { state: 'no_ttl', name: ix.name };
  if (ix.expireAfterSeconds !== spec.secs || !same(ix.partialFilterExpression, spec.partial)) return { state: 'wrong', name: ix.name, has: ix.expireAfterSeconds };
  return { state: 'ok', name: ix.name };
}

const mb = (n) => (n / 1048576);
const fmtMb = (n) => (mb(n) >= 10 ? mb(n).toFixed(0) : mb(n).toFixed(1)) + ' MB';

export async function dbHealthReport(db) {
  const now = Date.now();
  const t = (secs) => new Date(now - secs * 1000 - 2 * 3600 * 1000);   // 2 hours of grace for MongoDB's 60-second TTL sweeper
  const lines = [];
  let bad = 0;

  // storage
  let used = 0;
  try {
    const st = await db.command({ dbStats: 1 });
    used = (st.storageSize || 0) + (st.indexSize || 0);
    const pct = Math.round((100 * mb(used)) / FREE_LIMIT_MB);
    lines.push(`💾 <b>Storage:</b> ${fmtMb(used)} of ${FREE_LIMIT_MB} MB (<b>${pct}%</b>) ${pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢'}\n<i>data ${fmtMb(st.storageSize || 0)} · indexes ${fmtMb(st.indexSize || 0)}</i>`);
  } catch (e) { lines.push('💾 Storage: could not read (' + String(e.message).slice(0, 60) + ')'); }

  // biggest collections
  const names = [...new Set(['users', 'withdrawals', 'tasks', 'adsgramS2S', 'ipRegistry', 'fingerprints', 'adminClusters', 'taskCreateOrders', 'promos', 'bannedTelegramIds', 'ipSignupVelocity', 'botSettings'])];
  const sizes = [];
  for (const n of names) {
    try { const s = await db.command({ collStats: n }); sizes.push({ n, size: (s.storageSize || 0) + (s.totalIndexSize || 0), count: s.count || 0 }); } catch { /* collection does not exist yet */ }
  }
  sizes.sort((a, b) => b.size - a.size);
  if (sizes.length) lines.push('📚 <b>Biggest:</b>\n' + sizes.slice(0, 5).map((s) => `• ${s.n}: ${fmtMb(s.size)} · ${s.count.toLocaleString('en')} docs`).join('\n'));

  // TTL health
  const ttl = [];
  for (const sp of TTL_SPECS) {
    let st = { state: 'missing' }, over = 0, note = '';
    try {
      const idx = await db.collection(sp.col).listIndexes().toArray();
      st = judgeIndex(sp, idx);
    } catch { st = { state: sp.lazy ? 'lazy' : 'missing' }; }
    try { over = await db.collection(sp.col).countDocuments(sp.overdue(t)); } catch { /* ignore */ }
    let icon = '✅';
    if (st.state === 'lazy') { icon = '⚪'; note = 'not created yet (made on first use)'; }
    else if (st.state === 'missing') { icon = '❌'; note = sp.lazy ? 'missing (made on first use)' : 'index missing'; if (!sp.lazy) bad++; }
    else if (st.state === 'no_ttl') { icon = '❌'; note = 'index exists but has NO auto-delete'; bad++; }
    else if (st.state === 'wrong') { icon = '⚠️'; note = `wrong time (${Math.round((st.has || 0) / DAY)}d)`; bad++; }
    if (over > 0) { icon = '🔴'; note = `${over.toLocaleString('en')} overdue, should already be deleted` + (note ? ' · ' + note : ''); bad++; }
    ttl.push(`${icon} ${sp.label}${note ? ' — ' + note : ''}`);
  }
  lines.push('🧹 <b>TTL auto-delete</b>\n' + ttl.join('\n'));
  lines.push(bad === 0
    ? '🟢 <b>TTL is working.</b> Nothing overdue, every index is correct.'
    : `🔴 <b>${bad} problem(s).</b> Tap 🔧 Fix TTL indexes, then 🔄 Refresh after a few minutes.`);
  return { text: '🗄 <b>Database Health</b>\n\n' + lines.join('\n\n'), bad, usedMb: mb(used) };
}

// repair: create / retime / recreate the TTL indexes. Only indexes are touched.
export async function repairTtl(db) {
  const out = [];
  for (const sp of TTL_SPECS) {
    try {
      const col = db.collection(sp.col);
      let idx = [];
      try { idx = await col.listIndexes().toArray(); } catch { if (sp.lazy) { out.push(`⚪ ${sp.col}.${sp.key}: skipped (no collection yet)`); continue; } }
      const j = judgeIndex(sp, idx);
      const opts = { expireAfterSeconds: sp.secs, ...(sp.partial ? { partialFilterExpression: sp.partial } : {}) };
      if (j.state === 'ok') { out.push(`✅ ${sp.col}.${sp.key}: already correct`); continue; }
      if (j.state === 'wrong' && same(idx.find((i) => i.name === j.name)?.partialFilterExpression, sp.partial)) {
        await db.command({ collMod: sp.col, index: { name: j.name, expireAfterSeconds: sp.secs } });
        out.push(`🔧 ${sp.col}.${sp.key}: time corrected`); continue;
      }
      if (j.state === 'wrong' || j.state === 'no_ttl') await col.dropIndex(j.name);
      await col.createIndex({ [sp.key]: 1 }, opts);
      out.push(`🔧 ${sp.col}.${sp.key}: ${j.state === 'missing' ? 'created' : 'recreated'}`);
    } catch (e) { out.push(`❌ ${sp.col}.${sp.key}: ${String(e.message).slice(0, 80)}`); }
  }
  return out;
}

// ctx: { db, chatId, msgId, send, edit, backKb }  → true = handled
export async function handleDbHealthCallback(data, ctx) {
  const { db, chatId, msgId, edit, backKb } = ctx;
  const kb = (bad) => ({ inline_keyboard: [
    ...(bad ? [[{ text: '🔧 Fix TTL indexes', callback_data: 'dbh_fix' }]] : []),
    [{ text: '🔄 Refresh', callback_data: 'a_dbh' }],
    ...backKb.inline_keyboard,
  ] });
  if (data === 'a_dbh') {
    await edit(chatId, msgId, '🗄 Checking the database...');
    const r = await dbHealthReport(db);
    await edit(chatId, msgId, r.text, { reply_markup: kb(r.bad) });
    return true;
  }
  if (data === 'dbh_fix') {
    await edit(chatId, msgId, '🔧 Repairing TTL indexes...');
    const out = await repairTtl(db);
    await edit(chatId, msgId, `🔧 <b>TTL repair</b>\n\n${out.join('\n')}\n\n<i>MongoDB deletes old data within a few minutes after this. Tap Refresh later.</i>`, { reply_markup: kb(false) });
    return true;
  }
  return false;
}
