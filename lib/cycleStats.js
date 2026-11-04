// FILE PATH: lib/cycleStats.js
// 📊 CYCLE REPORT ("since last withdraw" counters) — ported from NEWTUBE.
//
// Every time a user earns MM$ (farm claim, ad, task, login bonus, promo, referral ...) a small counter on users.cy goes up.
// The admin sees it in the User Lookup panel and on every withdraw request: "since the last withdraw this user got X from Y".
// When a withdrawal is APPROVED the counters are copied into the withdrawal doc (snapshot) and users.cy is cleared.
//
// users.cy shape (all optional):  { since: Date, <key>N: <how many times>, <key>W: <how much MM$> }   e.g. farmN / farmW, taskN / taskW
//   • In an update:  $inc: { ...cyInc('farm', 30) }   +   $min: cyMin()
//
// ⚠ cyMin() uses $min on 'cy.since': a missing field always counts as "smaller", so it is only set the first time in a cycle.

const BD_MS = 6 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
// Bangladesh time (UTC+6), same as the rest of the app
export function fmtBDDate(d) {
  if (!d) return '—';
  const x = new Date(new Date(d).getTime() + BD_MS);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
export function fmtBDDateTime(d) {
  if (!d) return '—';
  const x = new Date(new Date(d).getTime() + BD_MS);
  return `${fmtBDDate(d)} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

// key -> label shown to the admin. Unknown keys fall back to the raw key, so a new source never breaks the report.
const LABELS = {
  farm: '🌾 Farm claims',
  gigapub: '🎬 GigaPub', adsgram_init: '📺 AdsGram',
  daily_gigapub: '🎬 Daily GigaPub', daily_adsgram: '📺 Daily Adsgram', daily_adsgram_task: '📋 Adsgram Task',
  task: '✅ Tasks', login: '📅 Login bonus', promo: '🎟 Promo', adminGift: '💰 Admin gift',
  refJoin: '👥 Referral joins', refStep: '🪜 Referral steps', refMilestone: '🏆 Ref milestones', refCommission: '💸 Ref commission',
};
const ORDER = Object.keys(LABELS);
const label = (k) => LABELS[k] || k;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (n) => Math.round(num(n) * 100) / 100;
const isCountKey = (k) => /N$/.test(k) && k.length > 1;
const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function cyInc(key, amount = 0) { return { [`cy.${key}N`]: 1, [`cy.${key}W`]: num(amount) }; }
export function cyMin() { return { 'cy.since': new Date() }; }

function rowsFrom(cy = {}) {
  const rows = [];
  for (const k of Object.keys(cy)) {
    if (!isCountKey(k)) continue;
    const key = k.slice(0, -1);
    const n = num(cy[k]), w = num(cy[`${key}W`]);
    if (n <= 0 && w <= 0) continue;
    rows.push({ key, label: label(key), n, w });
  }
  rows.sort((a, b) => {
    const ia = ORDER.indexOf(a.key), ib = ORDER.indexOf(b.key);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || b.w - a.w;
  });
  return rows;
}

// report for one user — never throws (a report problem must not break a withdraw / admin screen)
export async function buildCycleReport(db, user) {
  const cy = (user && user.cy) || {};
  const rows = rowsFrom(cy);
  let lastWithdrawAt = null;
  try {
    if (db && user?.telegramId !== undefined) {
      const last = await db.collection('withdrawals').find({ telegramId: String(user.telegramId) }, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).toArray();
      lastWithdrawAt = last[0]?.createdAt || null;
    }
  } catch { /* ignore */ }
  return { since: cy.since || null, lastWithdrawAt, rows, totalN: rows.reduce((a, r) => a + r.n, 0), totalW: rows.reduce((a, r) => a + r.w, 0) };
}

const sinceText = (rep) => rep.since ? fmtBDDateTime(rep.since) : (rep.lastWithdrawAt ? `${fmtBDDateTime(rep.lastWithdrawAt)} (last withdraw)` : 'start');

// short block (withdraw request + user lookup)
export function renderCycleShort(rep) {
  if (!rep || !rep.rows.length) return '📊 <b>Since last withdraw:</b> no counted earnings yet';
  const top = rep.rows.slice(0, 8).map((r) => `   ${r.label}: <b>${r.n}</b> · ${fmt(r.w)} MM$`).join('\n');
  return `📊 <b>Since last withdraw</b> (from ${sinceText(rep)})\n${top}\n   Σ <b>${rep.totalN}</b> actions · <b>${fmt(rep.totalW)}</b> MM$`;
}

// full screen (📊 Cycle Report button)
export function renderCycleFull(user, rep) {
  const head = `📊 <b>Cycle Report</b>\nUser: <code>${user?.telegramId}</code> · ${esc(user?.firstName || '')}\n` +
    `Cycle start: <b>${rep ? sinceText(rep) : 'start'}</b>\nBalance now: <b>${fmt(user?.egBalance)} MM$</b>\n\n`;
  if (!rep || !rep.rows.length) return head + 'No counted earnings yet (new cycle, or earned before the counters were added).';
  const lines = rep.rows.map((r) => `${r.label}: <b>${r.n}</b> × · <b>${fmt(r.w)}</b> MM$`).join('\n');
  return head + lines + `\n\nΣ Total: <b>${rep.totalN}</b> actions · <b>${fmt(rep.totalW)}</b> MM$`;
}

// compact snapshot copied into the withdrawal doc (right before `cy` is reset)
export function makeCycleSnapshot(rep) {
  const rows = (rep && rep.rows) || [];
  return {
    cy: rows.reduce((o, r) => { o[r.key] = { n: r.n, w: fmt(r.w) }; return o; }, {}),
    cySince: (rep && rep.since) || null,
    cyTotalN: (rep && rep.totalN) || 0,
    cyTotalW: fmt(rep && rep.totalW),
  };
}

// one line for 💸 Withdraw History
export function renderCycleSnapshotLine(cycle) {
  const cy = cycle?.cy || {};
  const parts = Object.keys(cy)
    .sort((a, b) => (ORDER.indexOf(a) < 0 ? 999 : ORDER.indexOf(a)) - (ORDER.indexOf(b) < 0 ? 999 : ORDER.indexOf(b)))
    .map((k) => `${label(k)} ${cy[k].n}×(${cy[k].w})`);
  return parts.length ? `📋 that cycle: ${parts.join(' · ')} → Σ ${cycle.cyTotalW || 0} MM$` : '📋 that cycle: no counted earnings';
}
