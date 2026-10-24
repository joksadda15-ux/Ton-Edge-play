// FILE PATH: lib/tonPay.js
// (GitHub repo te ei path e file ta rakhbe: lib/tonPay.js)
// TON deposit helpers (ported from NEWTUBE lib/tonPay.js).
// Env: TON_RECEIVE_ADDRESS (your wallet that receives deposits), TONCENTER_API_KEY (optional, free).
export const TON_RECEIVE_ADDRESS = process.env.TON_RECEIVE_ADDRESS;
export const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

export const randomTonMemo = (prefix) => prefix + Math.random().toString(36).slice(2, 8).toUpperCase();

// Tonkeeper universal link (works inside Telegram's WebView, unlike ton://).
export const buildTonDeepLink = (amountNanoTon, memo) =>
  `https://app.tonkeeper.com/transfer/${TON_RECEIVE_ADDRESS}?amount=${amountNanoTon}&text=${encodeURIComponent(memo)}`;

// Newest-first recent transactions of the receiving wallet. Retries on TonCenter hiccups (429/5xx).
export async function fetchRecentTonTransactions(limit = 100) {
  const headers = TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {};
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = new URL('https://toncenter.com/api/v2/getTransactions');
      url.searchParams.set('address', TON_RECEIVE_ADDRESS);
      url.searchParams.set('limit', String(limit));
      if (attempt < 2) url.searchParams.set('archival', 'false');
      const r = await fetch(url.toString(), { headers });
      if (r.ok) {
        const data = await r.json();
        if (data.ok) return data.result || [];
        lastErr = new Error(`TonCenter error: ${JSON.stringify(data).slice(0, 200)}`);
      } else {
        lastErr = new Error(`TonCenter HTTP ${r.status}`);
        if (r.status >= 400 && r.status < 500 && r.status !== 429) throw lastErr;
      }
    } catch (e) {
      lastErr = e;
      if (/TonCenter HTTP 4\d\d/.test(String(e?.message)) && !/429/.test(String(e?.message))) throw e;
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
  }
  throw lastErr || new Error('TonCenter unreachable');
}
