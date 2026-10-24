// FILE PATH: scripts/migrate-gold-to-mm.js
// (GitHub repo te ei path e file ta rakhbe: scripts/migrate-gold-to-mm.js)
// ONE-TIME migration: Gold -> MM$.  Run ONCE (after backing up your DB):
//   MONGODB_URI="..." node scripts/migrate-gold-to-mm.js          (dry run, changes nothing)
//   MONGODB_URI="..." node scripts/migrate-gold-to-mm.js --apply  (writes changes)
//
// Old economy: 1,000,000 Gold = 50,000 EG = $1  ->  20 Gold = 1 MM$.
// So every Gold value is divided by 20 and added to egBalance, keeping $ value identical.
import { MongoClient } from 'mongodb';

const RATE = 20;
const apply = process.argv.includes('--apply');
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db('tonedge');

const users = db.collection('users');
const tasks = db.collection('tasks');
const promos = db.collection('promos');

const withGold = await users.countDocuments({ goldBalance: { $gt: 0 } });
const oldTasks = await tasks.countDocuments({ mmMigrated: { $ne: true } });
const oldPromos = await promos.countDocuments({ currency: 'gold' });
console.log(`users with Gold: ${withGold} | tasks to convert: ${oldTasks} | gold promos: ${oldPromos}`);

if (!apply) { console.log('Dry run only. Add --apply to write.'); await client.close(); process.exit(0); }

// 1) users: egBalance += goldBalance / 20, then drop goldBalance
await users.updateMany({ goldBalance: { $gt: 0 } }, [
  { $set: { egBalance: { $round: [{ $add: [{ $ifNull: ['$egBalance', 0] }, { $divide: ['$goldBalance', RATE] }] }, 2] } } },
]);
await users.updateMany({}, { $unset: { goldBalance: '', tree: '', referralValidPaid: '' } });

// 2) tasks: reward was in Gold -> MM$
await tasks.updateMany({ mmMigrated: { $ne: true } }, [
  { $set: { reward: { $round: [{ $divide: ['$reward', RATE] }, 2] }, mmMigrated: true } },
]);

// 3) promos: gold promos -> MM$ (eg promos are already MM$)
await promos.updateMany({ currency: 'gold' }, [
  { $set: { reward: { $round: [{ $divide: ['$reward', RATE] }, 2] }, currency: 'mm' } },
]);

console.log('Migration done.');
await client.close();
