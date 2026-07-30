import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

let client;
let clientPromise;

if (!global._mongoClientPromise) {
  client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

// Runs once per warm serverless instance (guarded by the module-level flag
// below), not on every request. createIndex is a no-op if the index
// already exists, so this is safe to call repeatedly across cold starts too.
let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    // Promo codes: auto-delete once expiresAt passes, instead of sitting in
    // the DB forever after their 24h window closes.
    await db.collection('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // IP registry: bound growth by dropping entries nobody has touched in a
    // year — long enough to not weaken the one-account-per-IP check in
    // practice, short enough to stop it growing unbounded on a free tier.
    await db.collection('ipRegistry').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 31536000 });
  } catch (err) {
    // Index creation failing (e.g. race with another cold start, or an
    // existing index with different options) shouldn't break requests.
    console.error('ensureIndexes error:', err);
  }
}

export async function getDb() {
  const c = await clientPromise;
  const db = c.db('tonedge');
  await ensureIndexes(db);
  return db;
}

export default clientPromise;
