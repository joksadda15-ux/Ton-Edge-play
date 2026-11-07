// FILE PATH: server.js
// (GitHub repo te ei path e file ta rakhbe: server.js)
// Gram Edge Farm API — standalone Express server (no Vercel needed).
// Runs on any Node host: Render, Railway, VPS, etc.
// 🛡 Protected by lib/shield.js (rate limits, auto-block, webhook secret) + crash guards below.
import express from 'express';
import cors from 'cors';

import user from './api/user.js';
import tasks from './api/tasks.js';
import daily from './api/daily.js';
import ads from './api/ads.js';
import withdraw from './api/withdraw.js';
import bot from './api/bot.js';
import farm from './api/farm.js';
import payments from './api/payments.js';
import cron from './api/cron.js';
import logo from './api/logo.js';
import { shieldIp, shieldUser } from './lib/shield.js';

// A bug or a hacker's weird request must NEVER kill the server: log it and keep running.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // so x-forwarded-for / IP checks work behind the host's proxy
app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

// Only your frontend (and Telegram, which sends no Origin header) may call the API.
// ALLOWED_ORIGIN = your frontend URL(s), comma separated, e.g. https://gram-edge-farm.vercel.app
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Health check — also use this URL for the free uptime pinger (keeps the server awake). Not rate limited, costs nothing.
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

app.use(shieldIp);                                  // 🛡 1: webhook secret + per-IP limit (before the body is even read)
app.use(express.json({ limit: '64kb' }));           // was 1mb: nobody needs a bigger body, and big bodies are a cheap way to hurt a small server
app.use(shieldUser);                                // 🛡 2: per-user limit (100/min) + fake-session limit

const routes = { user, tasks, daily, ads, withdraw, bot, farm, payments, cron, logo };
app.all('/api/:name', async (req, res) => {
  const name = req.params.name;
  const handler = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null; // 'constructor' & co. are not routes
  if (!handler) return res.status(404).json({ error: 'Not found' });
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[${name}]`, err);
    // Telegram re-sends a webhook update for ever while we answer 500, so the bot always answers 200
    if (!res.headersSent) res.status(name === 'bot' ? 200 : 500).json(name === 'bot' ? { ok: true } : { error: 'Server error' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

if (!process.env.WEBHOOK_SECRET) console.warn('⚠️  WEBHOOK_SECRET is not set: anyone who knows your admin ID could fake bot updates. See the setup steps.');

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Gram Edge Farm API listening on :${port}`));
server.requestTimeout = 30_000;   // a slow-loris request cannot hold a connection for ever
server.headersTimeout = 35_000;
server.keepAliveTimeout = 65_000;
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
