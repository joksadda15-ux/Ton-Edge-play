// FILE PATH: lib/dateUtils.js
//
// This file was missing from the repo — api/ads.js and api/withdraw.js both
// `import { bdTodayKey } from '../lib/dateUtils.js'`, but the file never
// existed. That makes those two serverless functions fail to load at all
// (Vercel can't resolve the import), which is why "Ads Earn" showed
// "Couldn't load ads" — every request to /api/ads was erroring before it
// ever reached the handler code. Withdraw's daily-ads-watched check
// (api/withdraw.js line ~17) was broken the same way.

// Returns today's date as YYYY-MM-DD in Bangladesh time (UTC+6), used as a
// per-day bucket key — e.g. user.adTasks[bdTodayKey()] — so daily limits
// reset at Bangladesh midnight regardless of the server's own timezone.
// Bangladesh has no daylight-saving shift, so a fixed +6h offset is exact.
export function bdTodayKey(date = new Date()) {
  const bd = new Date(date.getTime() + 6 * 60 * 60 * 1000);
  return bd.toISOString().slice(0, 10); // "2026-07-31"
}
