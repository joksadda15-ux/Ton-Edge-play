// FILE PATH: lib/signupBursts.js
// (GitHub repo te ei path e file ta rakhbe: lib/signupBursts.js)
// Ported from NEWTUBE; adapted to Gram Edge Farm users (telegramId, totalAdsWatched, dailyClaimLast, farmHarvests).
// lib/signupBursts.js
//
// 18 Oct 2026 — 🆕 SIGNUP BURSTS for the NEWTUBE admin panel (ported from the Fruit Cut admin bot: lib/adminSecurity.js "Signup Bursts").
//
// Kaj: onek account EKSATHE (kichu second-er gap-e gap-e) toiri hole seta "burst". Eta bot-farm-er sobcheye boro lokkhon.
// Admin panel → 🆕 Signup Bursts → last 1 ghonta / 24 ghonta / 7 din-er burst-er list, prottek burst-er jonno:
//   • koyta account, kon shomoy theke kon shomoy (Bangladesh time), minute-e koyta
//   • koyta ek-i signup IP theke · koyta ek-i referrer-er link diye · koyta kokhono kichu kore ni ("dead")
//   • ekta verdict (🔴 bot farm / 🟠 very likely fake / 🟡 suspicious / 🟢 probably real)
//   • buttons: 👁 Members (ID + data) · 🔒 Lock all · 🚫 Ban all (always asks first, valid 2 min) · ✅ Real users — unlock
//
// NOTE: Fruit Cut-er original `signupBursts.scanBursts()` file amar kache chhilo na — tai oi scanner ami NEWTUBE-er jonno nijei likhechi,
// Fruit Cut-er screen/button/verdict-er moto kore. Number gulo (MIN, GAP_MS …) niche CFG-te bodlano jay.
//
// Buttons (callback_data) ei file handle kore:  a_signups · sb_scan_<hours> · sb_view|page|lock|clear|banask|banok_<burstId>
//
// DATA: users.createdAt (join time), users.referredBy, users.signupIp (NOTUN: api/user.js ekhon notun account-er signup IP rakhe —
// ager account-er IP chhilo na, tai purano burst-e "IP: not recorded" dekhabe, referrer ar "dead" hishab thik thakbe).
// Burst-er member-list `adminClusters` collection-e 7 din rakha hoy (button-e chapar jonno), tarpor nijei muche jay (TTL).

import crypto from 'crypto';
import { markBanned } from './banRegistry.js';

export const CFG = {
    MIN: 8,            // koyta account hole "burst" (ekta chain-e) — 8+
    GAP_MS: 20000,     // chain: prottek account ager account-er 20 second-er moddhe join korle
    MAX_SHOWN: 5,      // ekbare sobcheye boro koyta burst dekhabe
    SCAN_LIMIT: 30000, // max koyta notun user pora hobe
};

const DHAKA_MS = 6 * 60 * 60 * 1000;
const hx = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dhakaClock = (ms) => new Date(ms + DHAKA_MS).toISOString().slice(5, 19).replace('T', ' ');
const dhakaHms = (ms) => new Date(ms + DHAKA_MS).toISOString().slice(11, 19);
const spanText = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60}s` : `${s}s`; };
const rangeLabel = (h) => (h >= 168 ? '7 days' : h >= 24 ? `${Math.round(h / 24)} day${h >= 48 ? 's' : ''}` : `${h} hour${h > 1 ? 's' : ''}`);

// ── "dead" = ei account kokhono kichu kore ni (ek WTC-o earn kore ni, task/ad/channel-verify kichu na) ──
const isDead = (u) => !(u.totalAdsWatched > 0) && !((u.completedTasks || []).length) && !(u.tasksDoneTotal > 0) && !(u.farmClaims > 0) && !(u.loginBonus && u.loginBonus.lastDay) && !u.dailyClaimLast && !(u.farmHarvests > 0);

function topOf(list) {
    const m = new Map();
    for (const v of list) if (v) m.set(v, (m.get(v) || 0) + 1);
    let best = null, n = 0;
    for (const [k, c] of m) if (c > n) { best = k; n = c; }
    return { value: best, n };
}

function makeInfo(members) {
    const ip = topOf(members.map(u => u.signupIp));
    const ref = topOf(members.map(u => u.referredBy));
    const dead = members.filter(isDead).length;
    return {
        ipN: ip.n, topIp: ip.value, ipKnown: members.filter(u => u.signupIp).length,
        refN: ref.n, topRef: ref.value,
        dead,
        banned: members.filter(u => u.isBanned).length,
        locked: members.filter(u => u.accountLocked).length,
    };
}

function verdictOf(size, inf) {
    const ip = inf.ipN / size, rf = inf.refN / size, dd = inf.dead / size;
    if (ip >= 0.6 || rf >= 0.6) return '🔴 Looks like a BOT FARM — most accounts share one IP or one referrer.';
    if (dd >= 0.8) return '🟠 Very likely FAKE — almost all of them never did anything in the app.';
    if (ip >= 0.3 || rf >= 0.3 || dd >= 0.5) return '🟡 Suspicious — open 👁 Members and check before you act.';
    return '🟢 Probably real people (different IPs / referrers and many used the app) — maybe a channel post or a viral link.';
}

// ── SCAN ─────────────────────────────────────────────────────────
export async function scanBursts(db, hours) {
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const rows = await db.collection('users').find(
        { createdAt: { $gte: since } },
        { projection: { telegramId: 1, createdAt: 1, referredBy: 1, signupIp: 1, isBanned: 1, accountLocked: 1, totalAdsWatched: 1, completedTasks: 1, dailyClaimLast: 1, farmHarvests: 1, tasksDoneTotal: 1, farmClaims: 1, loginBonus: 1 } }
    ).sort({ createdAt: 1 }).limit(CFG.SCAN_LIMIT).toArray();

    // 1) chains: prottek account ager-ta-r CFG.GAP_MS-er moddhe
    const chains = [];
    let cur = [];
    for (const u of rows) {
        const t = new Date(u.createdAt).getTime();
        if (cur.length && t - cur[cur.length - 1]._t > CFG.GAP_MS) { if (cur.length >= CFG.MIN) chains.push(cur); cur = []; }
        cur.push(Object.assign({}, u, { _t: t }));
    }
    if (cur.length >= CFG.MIN) chains.push(cur);

    // 2) bystander: jodi chain-e ekta shared IP/referrer sobcheye boro hoy, tahole ja "real-looking" (onno IP + onno referrer + app e kaj korechhe)
    //    sheigulo bad — tara shudhu ek-i minute-e join korechhilo
    const bursts = [];
    for (const ch of chains) {
        const first = makeInfo(ch);
        let members = ch, bystanders = 0;
        const dominant = first.ipN >= ch.length * 0.4 || first.refN >= ch.length * 0.4;
        if (dominant) {
            members = ch.filter(u => (first.topIp && u.signupIp === first.topIp) || (first.topRef && u.referredBy === first.topRef) || isDead(u));
            bystanders = ch.length - members.length;
        }
        if (members.length < CFG.MIN) continue;
        const info = makeInfo(members);
        info.bystanders = bystanders;
        info.verdict = verdictOf(members.length, info);
        bursts.push({
            ids: members.map(u => String(u.telegramId)),
            size: members.length,
            start: members[0]._t,
            end: members[members.length - 1]._t,
            info,
        });
    }
    bursts.sort((a, b) => b.size - a.size);
    return { total: rows.length, bursts };
}

// ── saved member-lists (so the buttons work later) ───────────────
let clusterIndexReady = false;
export async function saveCluster(db, ids, kind = 'signup') {
    const col = db.collection('adminClusters');
    if (!clusterIndexReady) {
        clusterIndexReady = true;
        await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }).catch(() => {});
    }
    const cid = crypto.randomBytes(4).toString('hex');
    await col.insertOne({ _id: cid, ids: ids.slice(0, 2000), kind, createdAt: new Date() });
    return cid;
}
export async function loadCluster(db, cid) {
    return db.collection('adminClusters').findOne({ _id: cid });
}

// ── actions ──────────────────────────────────────────────────────
async function lockMany(db, ids) {
    const r = await db.collection('users').updateMany(
        { telegramId: { $in: ids }, isBanned: { $ne: true }, accountLocked: { $ne: true } },
        { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'signup_burst' } }
    );
    return r.modifiedCount || 0;
}
async function unlockMany(db, ids) {
    // shudhu jegulo "signup_burst" hishebe lock hoyechhilo — onno karone lock kora account ke ei button chhuy na
    const r = await db.collection('users').updateMany(
        { telegramId: { $in: ids }, accountLocked: true, accountLockedReason: 'signup_burst' },
        { $set: { accountLocked: false }, $unset: { accountLockedAt: '', accountLockedReason: '' } }
    );
    return r.modifiedCount || 0;
}
async function banMany(db, ids) {
    const now = new Date();
    const fresh = await db.collection('users').find({ telegramId: { $in: ids }, isBanned: { $ne: true } }, { projection: { telegramId: 1 } }).toArray();
    const freshIds = fresh.map(u => u.telegramId);
    if (freshIds.length) {
        await db.collection('users').updateMany(
            { telegramId: { $in: freshIds } },
            { $set: { isBanned: true, bannedAt: now, bannedReason: 'admin_signup_burst', appealBlocked: true } }
        );
    }
    for (let i = 0; i < ids.length; i += 1000) await markBanned(db, ids.slice(i, i + 1000)); // permanent registry (re-signup bondho)
    // NEWTUBE-er niyom (banall_ er moto): pending withdrawal auto-reject hoy na — shudhu sonkha janay, admin nijei decide kore
    const pendingWd = await db.collection('withdrawals').countDocuments({ telegramId: { $in: ids }, status: 'pending' });
    return { banned: freshIds.length, already: ids.length - freshIds.length, pendingWd };
}

const tsNow36 = () => Math.floor(Date.now() / 1000).toString(36);
const tsFresh = (t36) => { const t = parseInt(t36, 36); return Number.isFinite(t) && Date.now() / 1000 - t >= 0 && Date.now() / 1000 - t <= 120; };

// ── SCREENS ──────────────────────────────────────────────────────
function burstButtons(cid, n) {
    return { inline_keyboard: [
        [{ text: '👁 Members (IDs + data)', callback_data: `sb_view_${cid}` }],
        [{ text: `🔒 Lock all ${n}`, callback_data: `sb_lock_${cid}` }, { text: `🚫 Ban all ${n}`, callback_data: `sb_banask_${cid}` }],
        [{ text: '✅ Real users — unlock', callback_data: `sb_clear_${cid}` }],
    ] };
}

async function runSignupScan(ctx, hours) {
    const { db, chatId, msgId, send, edit } = ctx;
    await edit(chatId, msgId, `🆕 Scanning sign-ups of the last ${rangeLabel(hours)}...`);
    const res = await scanBursts(db, hours);
    const top = res.bursts.slice(0, CFG.MAX_SHOWN);
    const inBursts = res.bursts.reduce((a, b) => a + b.size, 0);
    const rangeKb = { inline_keyboard: [
        [{ text: (hours === 1 ? '• ' : '') + '1 hour', callback_data: 'sb_scan_1' }, { text: (hours === 24 ? '• ' : '') + '24 hours', callback_data: 'sb_scan_24' }, { text: (hours === 168 ? '• ' : '') + '7 days', callback_data: 'sb_scan_168' }],
        [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
    ] };
    await edit(chatId, msgId,
        `🆕 <b>Signup Bursts</b> — last ${rangeLabel(hours)} <i>(Bangladesh time)</i>\n\n` +
        `New accounts: <b>${res.total.toLocaleString('en-US')}</b>\n` +
        `Bursts found: <b>${res.bursts.length}</b> · accounts inside bursts: <b>${inBursts.toLocaleString('en-US')}</b>\n\n` +
        `<i>Burst = ${CFG.MIN}+ accounts where each one joined within ${CFG.GAP_MS / 1000}s of the previous one.</i>\n` +
        (res.bursts.length ? (res.bursts.length > top.length ? `\nShowing the ${top.length} biggest ↓` : '\nDetails ↓') : '\n🟢 No burst found in this period.'),
        { reply_markup: rangeKb });

    let i = 0;
    for (const b of top) {
        i++;
        const cid = await saveCluster(db, b.ids, 'signup');
        const inf = b.info || {};
        const dur = b.end - b.start;
        const perMin = dur >= 30000 ? ` · ~${Math.round(b.size / (dur / 60000))} accounts/min` : '';
        const pct = (x) => `${x}/${b.size} (${Math.round((100 * x) / b.size)}%)`;
        await send(chatId,
            `🆕 <b>Burst #${i} — ${b.size} accounts</b>\n` +
            `🕐 ${dhakaClock(b.start)} → ${dhakaHms(b.end)} <i>(${spanText(dur)}${perMin})</i>\n\n` +
            (inf.ipKnown
                ? `🌐 Same signup IP: <b>${pct(inf.ipN || 0)}</b>${inf.topIp ? ` — <code>${hx(inf.topIp)}</code>` : ''}\n`
                : `🌐 Signup IP: <i>not recorded (only accounts created after this update store their IP)</i>\n`) +
            `🔗 Same referrer: <b>${pct(inf.refN || 0)}</b>${inf.topRef ? ` — <code>${hx(inf.topRef)}</code>` : ''}\n` +
            `💀 Never did anything: <b>${pct(inf.dead || 0)}</b>\n` +
            `🚫 Already banned: ${inf.banned || 0} · 🔒 locked: ${inf.locked || 0}\n` +
            (inf.bystanders ? `🧍 ${inf.bystanders} real-looking account(s) that joined in the same minute were left out of this list (different IP + referrer, and they really used the app).\n` : '') + '\n' +
            `<b>${inf.verdict || ''}</b>`,
            { reply_markup: burstButtons(cid, b.size) });
    }
}

// ctx: { db, chatId, msgId, send, edit, backKb }  → true = handled
export async function handleSignupCallback(data, ctx) {
    const { db, chatId, msgId, send, edit, backKb } = ctx;
    if (data === 'a_signups') { await runSignupScan(ctx, 24); return true; }
    if (data.startsWith('sb_scan_')) { const h = parseInt(data.slice(8), 10); await runSignupScan(ctx, [1, 24, 168].includes(h) ? h : 24); return true; }
    if (!data.startsWith('sb_')) return false;

    const m = /^sb_(view|page|lock|clear|banask|banok)_([0-9a-f]{8})(?:_([0-9a-z]+))?$/.exec(data);
    if (!m) return false;
    const [, act, cid, arg] = m;
    const cl = await loadCluster(db, cid);
    if (!cl) { await send(chatId, '⚠️ This list is too old (saved for 7 days) — open 🆕 Signup Bursts again.', { reply_markup: backKb }); return true; }
    const ids = cl.ids;

    if (act === 'view' || act === 'page') {
        const per = 20;
        const page = act === 'page' ? Math.max(0, parseInt(arg, 10) || 0) : 0;
        const rows = (await db.collection('users').find({ telegramId: { $in: ids } }).limit(600).toArray())
            .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const slice = rows.slice(page * per, page * per + per);
        const lines = slice.map((u) =>
            `${u.isBanned ? '🚫' : u.accountLocked ? '🔒' : '•'} ${u.createdAt ? dhakaHms(new Date(u.createdAt).getTime()) : '—'} ${hx(u.firstName || 'User')}${u.username ? ' @' + hx(u.username) : ''} <code>${u.telegramId}</code> · ${u.egBalance || 0} MM$ · 📺${u.totalAdsWatched || 0} · ✅${(u.completedTasks || []).length}` +
            `${u.referredBy ? ` · ref <code>${hx(u.referredBy)}</code>` : ''}${u.signupIp ? ` · ${hx(u.signupIp)}` : ''}`);
        const nav = [];
        if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `sb_page_${cid}_${page - 1}` });
        if ((page + 1) * per < rows.length) nav.push({ text: 'Next ▶️', callback_data: `sb_page_${cid}_${page + 1}` });
        const kb = [];
        if (nav.length) kb.push(nav);
        kb.push([{ text: `🔒 Lock all ${ids.length}`, callback_data: `sb_lock_${cid}` }, { text: `🚫 Ban all ${ids.length}`, callback_data: `sb_banask_${cid}` }]);
        kb.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
        await send(chatId,
            `👁 <b>Accounts of this burst</b> — ${page * per + 1}–${page * per + slice.length} of ${rows.length}\n<i>time (BD) · name · ID · MM$ · ads · tasks · referrer · IP</i>\n\n${lines.join('\n') || '—'}`,
            { reply_markup: { inline_keyboard: kb } });
        return true;
    }
    if (act === 'lock') {
        const n = await lockMany(db, ids);
        await send(chatId, `🔒 Locked <b>${n}</b> of ${ids.length} accounts.\nThey cannot withdraw and earn no referral rewards; the app still opens. If some are real people, tap ✅ Real users — unlock on the burst.`, { reply_markup: backKb });
        return true;
    }
    if (act === 'clear') {
        const n = await unlockMany(db, ids);
        await send(chatId, `✅ Unlocked <b>${n}</b> account(s) that were locked as a signup burst.`, { reply_markup: backKb });
        return true;
    }
    if (act === 'banask') {
        await edit(chatId, msgId,
            `⚠️ <b>Ban ${ids.length} accounts for good?</b>\n\n` +
            `• They can never sign up again (permanent ban record) and cannot appeal\n• Their pending withdrawals are NOT auto-rejected — you will get the count and decide\n• This cannot be undone from here\n\n` +
            `Open 👁 Members first if you are not sure — a real person among them would be banned too.\n\n<i>This confirmation expires in 2 minutes.</i>`,
            { reply_markup: { inline_keyboard: [
                [{ text: '❌ No, cancel', callback_data: `sb_view_${cid}` }],
                [{ text: `✅ Yes, ban all ${ids.length}`, callback_data: `sb_banok_${cid}_${tsNow36()}` }],
            ] } });
        return true;
    }
    if (act === 'banok') {
        if (!tsFresh(arg)) { await edit(chatId, msgId, '⌛ Confirmation expired. Open the burst again if you still want to ban.', { reply_markup: backKb }); return true; }
        const r = await banMany(db, ids);
        await edit(chatId, msgId,
            `🚫 <b>Done.</b> ${r.banned} banned (${r.already} were already banned).` +
            (r.pendingWd ? `\n\n⚠️ <b>${r.pendingWd}</b> pending withdrawal(s) from these accounts still need a manual Reject / Ban &amp; Wipe.` : ''),
            { reply_markup: backKb });
        return true;
    }
    return false;
                                       }
