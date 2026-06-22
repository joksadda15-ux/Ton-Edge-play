// Run this once after deploying to Vercel:
// node setup-webhook.js

const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE'; // replace before running
const VERCEL_URL = 'https://ton-edge.vercel.app';

async function setWebhook() {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${VERCEL_URL}/api/bot` }),
    }
  );
  const data = await res.json();
  console.log(data);
}

setWebhook();
