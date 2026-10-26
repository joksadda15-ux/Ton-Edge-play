// FILE PATH: api/logo.js
// Serves a task's logo that the admin sent as a PHOTO in the bot.
//   GET /api/logo?id=<taskId>
// The Telegram file link contains the bot token, so it must never reach the browser. This route fetches the picture
// from Telegram, keeps a small copy in memory, and tells the browser to cache it for 7 days. Result: Telegram is
// asked once per logo and then (almost) never again, so this costs next to no CPU.
import { getDb } from '../lib/mongodb.js';
import { tgApi } from '../lib/tg.js';

const cache = new Map();           // fileId -> { buf, type }
const MAX_CACHE = 150;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export default async function handler(req, res) {
  const id = String(req.query?.id || '');
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) return res.status(400).end();
  const db = await getDb();
  const task = await db.collection('tasks').findOne({ id }, { projection: { logoFileId: 1 } });
  if (!task?.logoFileId) return res.status(404).end();

  let hit = cache.get(task.logoFileId);
  if (!hit) {
    const f = await tgApi('getFile', { file_id: task.logoFileId });
    const path = f?.result?.file_path;
    if (!path) return res.status(404).end();
    const r = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${path}`);
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 600 * 1024) return res.status(413).end();
    hit = { buf, type: TYPES[String(path).split('.').pop().toLowerCase()] || 'image/jpeg' };
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(task.logoFileId, hit);
  }
  res.setHeader('Content-Type', hit.type);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.status(200).end(hit.buf);
}
