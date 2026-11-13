// FILE PATH: lib/wdInfo.js
// Two facts the admin wants on every withdrawal card: WHEN the user joined and HOW MUCH he was already paid in total.
// One query for the joined dates + one grouped query for the paid totals, for a whole page of cards at once (no query per card).
const BD = 6 * 3600 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
// Full Bangladesh time (UTC+6), 12-hour clock, e.g. "13 Nov 2026, 07:12:54 PM"  (never uses the server's own timezone)
export const fmtBDFull = (d) => {
  if (!d) return 'unknown';
  const x = new Date(new Date(d).getTime() + BD);
  if (isNaN(x.getTime())) return 'unknown';
  const h = x.getUTCHours(), h12 = h % 12 || 12;
  return `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}, ${p2(h12)}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
};
const fmtDate = (d) => { const x = new Date(new Date(d).getTime() + BD); return `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };

// ids: array of telegramId strings  ->  Map(telegramId -> { joinedAt, n, usd, mm })
export async function loadWdInfo(db, ids) {
  const list = [...new Set(ids.map(String))];
  const map = new Map(list.map((id) => [id, { joinedAt: null, n: 0, usd: 0, mm: 0, refs: 0, refsReal: 0, refsActive: 0 }]));
  if (!list.length) return map;
  try {
    const us = await db.collection('users').find({ telegramId: { $in: list } }, { projection: { telegramId: 1, createdAt: 1, totalReferred: 1, activeReferrals: 1 } }).toArray();
    for (const u of us) { const m = map.get(String(u.telegramId)); if (m) { m.joinedAt = u.createdAt || null; m.refs = u.totalReferred || 0; m.refsActive = u.activeReferrals || 0; } }
    // real count straight from the users collection (the stored counter can be stale / reset), whole page in one grouped query
    const rc = await db.collection('users').aggregate([
      { $match: { referredBy: { $in: list } } },
      { $group: { _id: '$referredBy', n: { $sum: 1 } } },
    ]).toArray();
    for (const r of rc) { const m = map.get(String(r._id)); if (m) m.refsReal = r.n; }
    const paid = await db.collection('withdrawals').aggregate([
      { $match: { telegramId: { $in: list }, status: 'approved' } },
      { $group: { _id: '$telegramId', n: { $sum: 1 }, usd: { $sum: '$usdtAmount' }, mm: { $sum: '$egAmount' } } },
    ]).toArray();
    for (const p of paid) { const m = map.get(String(p._id)); if (m) { m.n = p.n; m.usd = p.usd || 0; m.mm = p.mm || 0; } }
  } catch (e) { console.error('loadWdInfo failed:', e.message); }
  return map;
}

// two lines for the card (HTML)
export function renderWdInfo(info) {
  const i = info || { joinedAt: null, n: 0, usd: 0, mm: 0, refs: 0, refsReal: 0, refsActive: 0 };
  const joined = i.joinedAt
    ? `${fmtDate(i.joinedAt)} (${Math.max(0, Math.floor((Date.now() - new Date(i.joinedAt).getTime()) / 86400000))} days ago)`
    : 'unknown';
  const paid = i.n ? `<b>${i.n}</b> time${i.n === 1 ? '' : 's'} · <b>$${i.usd.toFixed(2)}</b> (${Math.round(i.mm).toLocaleString()} MM$)` : '<b>none yet</b> (first withdrawal)';
  const refTotal = Math.max(i.refs || 0, i.refsReal || 0); // never show less than the real number of invited users
  const refs = `<b>${refTotal}</b> total${i.refsActive ? ` · ${i.refsActive} active` : ''}`;
  return `📆 Joined: <b>${joined}</b>\n👥 Total refer: ${refs}\n💸 Total withdrawn (paid): ${paid}\n`;
}
