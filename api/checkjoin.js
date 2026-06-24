const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = '@ton_edge_play';
const COMMUNITY = '@ton_edge_community';

async function checkMembership(userId, chatUsername) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatUsername}&user_id=${userId}`
    );
    const data = await res.json();
    return ['member', 'administrator', 'creator'].includes(data.result?.status);
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');

  const telegramId = req.query.telegramId || req.body?.telegramId;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const [ch, com] = await Promise.all([
    checkMembership(telegramId, CHANNEL),
    checkMembership(telegramId, COMMUNITY),
  ]);

  return res.status(200).json({ joined: ch && com, channel: ch, community: com });
}
