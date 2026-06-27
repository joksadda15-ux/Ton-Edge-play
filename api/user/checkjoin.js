const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = '@ton_edge_play';
const COMMUNITY = '@ton_edge_community';

async function checkMembership(userId, chatUsername) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatUsername)}&user_id=${userId}`
    );
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.ok) return false;
    const status = data.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ton-edge-play.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const telegramId = req.query.telegramId || req.body?.telegramId;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  try {
    // Check both channels in parallel
    const [channel, community] = await Promise.all([
      checkMembership(telegramId, CHANNEL),
      checkMembership(telegramId, COMMUNITY),
    ]);

    return res.status(200).json({
      joined: channel && community,
      channel,
      community,
      // Debug info
      telegramId: String(telegramId),
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('checkjoin error:', err);
    // On error return false — don't allow bypass
    return res.status(200).json({ joined: false, channel: false, community: false, error: 'Check failed' });
  }
}
