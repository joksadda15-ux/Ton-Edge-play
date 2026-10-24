// FILE PATH: server.js
// (GitHub repo te ei path e file ta rakhbe: server.js)
// Gram Edge Farm API — standalone Express server (no Vercel needed).
// Runs on any Node host: Render, Railway, VPS, etc.
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

const app = express();
app.set('trust proxy', true); // so x-forwarded-for / IP checks work behind the host's proxy
app.use(express.json({ limit: '1mb' }));

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

// Health check — also use this URL for the free uptime pinger (keeps the server awake).
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

const routes = { user, tasks, daily, ads, withdraw, bot, farm, payments };
app.all('/api/:name', async (req, res) => {
  const handler = routes[req.params.name];
  if (!handler) return res.status(404).json({ error: 'Not found' });
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[${req.params.name}]`, err);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Gram Edge Farm API listening on :${port}`));
