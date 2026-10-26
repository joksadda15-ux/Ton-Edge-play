// FILE PATH: lib/mongodb.js
// One shared MongoDB connection for the whole server. Every api/*.js file does:  import { getDb } from '../lib/mongodb.js';
// Needs the env var MONGODB_URI (Render -> Environment). Database name: tonedge
import { MongoClient } from 'mongodb';
import { ensureAllIndexes } from './indexes.js';

const DB_NAME = 'tonedge';

let clientPromise = null;
let indexesStarted = false;

export async function getDb() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
    clientPromise = client.connect().catch((err) => { clientPromise = null; throw err; }); // retry on next call if the first connect fails
  }
  const client = await clientPromise;
  const db = client.db(DB_NAME);
  if (!indexesStarted) {
    indexesStarted = true;
    ensureAllIndexes(db).catch((e) => console.error('ensureAllIndexes failed:', e.message)); // background, never blocks a request
  }
  return db;
}
