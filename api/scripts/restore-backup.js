// FILE PATH: api/scripts/restore-backup.js
// Restore from a Telegram backup file (gef-backup-YYYY-MM-DD.ndjson.gz). Run it on your own computer:
//   MONGODB_URI="mongodb+srv://..." node api/scripts/restore-backup.js gef-backup-2026-11-24.ndjson.gz          ← DRY RUN: only counts, writes nothing
//   MONGODB_URI="mongodb+srv://..." node api/scripts/restore-backup.js gef-backup-2026-11-24.ndjson.gz --apply  ← really writes
// --apply only fills in what is MISSING (insert if the _id / telegramId does not exist). It never overwrites a live user/withdrawal,
// so it is safe to run on a healthy database. Add --overwrite to replace existing rows too (use only after a real disaster).
import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';
import { MongoClient, BSON } from 'mongodb';
const { EJSON } = BSON;

const [file, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply'), OVERWRITE = flags.includes('--overwrite');
if (!file || !process.env.MONGODB_URI) { console.error('usage: MONGODB_URI=... node api/scripts/restore-backup.js <file.ndjson.gz> [--apply] [--overwrite]'); process.exit(1); }

const client = await new MongoClient(process.env.MONGODB_URI).connect();
const db = client.db('tonedge');
const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
const stat = {}; let ops = {};
async function flush(c) {
  if (!ops[c]?.length) return;
  if (APPLY) await db.collection(c).bulkWrite(ops[c], { ordered: false }).catch((e) => console.error(c, String(e.message).slice(0, 80)));
  ops[c] = [];
}
for await (const line of rl) {
  if (!line.trim()) continue;
  const { c, d } = EJSON.parse(line);
  stat[c] = (stat[c] || 0) + 1;
  const filter = c === 'users' ? { telegramId: d.telegramId } : { _id: d._id };
  (ops[c] ||= []).push(OVERWRITE
    ? { replaceOne: { filter, replacement: d, upsert: true } }
    : { updateOne: { filter, update: { $setOnInsert: d }, upsert: true } });
  if (ops[c].length >= 500) await flush(c);
}
for (const c of Object.keys(ops)) await flush(c);
console.log(APPLY ? '✅ restored' : '🔎 DRY RUN (nothing written) — add --apply', stat);
await client.close();
