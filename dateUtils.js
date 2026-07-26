// Bangladesh Standard Time is UTC+6, with no daylight saving.
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

// Returns today's calendar date in Bangladesh time as "YYYY-MM-DD".
// Used as the reset key for anything that should flip over at BD midnight
// (daily ad-watch limits, the ads-watched-today count for the withdraw
// gate, etc). Date.toISOString() alone is UTC-based and would flip the
// "day" at 06:00 BD time instead — always compute this via bdTodayKey()
// rather than rolling your own, so every daily-reset feature stays in sync.
export function bdTodayKey() {
  return new Date(Date.now() + BD_OFFSET_MS).toISOString().slice(0, 10);
}
