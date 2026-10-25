import { MongoClient } from 'mongodb';
import { ensureAllIndexes } from './indexes.js';

const uri = process.env.MONGODB_URI;

let client;
let clientPromise;

if (!global._mongoClientPromise) {
  client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

// All indexes (including the TTL auto-delete ones) live in lib/indexes.js.
// They are created ONCE per server start, in the background, so no request ever waits for them.
let indexesEnsured = false;

export async function getDb() {
  const c = await clientPromise;
  const db = c.db('tonedge');
  if (!indexesEnsured) {
    indexesEnsured = true;
    ensureAllIndexes(db).catch((err) => console.error('ensureAllIndexes error:', err));
  }
  return db;
}

export default clientPromise;
