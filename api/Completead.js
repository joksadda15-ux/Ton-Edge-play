import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegramId } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');

    const user = await users.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const plan = user.activePlan;
    if (!plan || plan.status !== 'pending') {
      return res.status(400).json({ error: 'No pending plan found.' });
    }

    const newAdsWatched = (plan.adsWatched || 0) + 1;
    const allAdsWatched = newAdsWatched >= plan.adsRequired;

    // Check referral ad milestone (20 ads total = 120 EG to referrer)
    const newTotalAds = (user.totalAdsWatched || 0) + 1;
    const referralAdBonus = newTotalAds === 20 && user.referredBy;

    if (allAdsWatched) {
      // All ads done — start mining
      const miningFinishTime = new Date(Date.now() + plan.miningHours * 60 * 60 * 1000);

      await users.updateOne(
        { telegramId: String(telegramId) },
        {
          $set: {
            'activePlan.adsWatched': newAdsWatched,
            'activePlan.status': 'mining',
            miningFinishTime,
          },
          $inc: { totalAdsWatched: 1 },
        }
      );

      // Give referrer 120 EG if this user just hit 20 ads
      if (referralAdBonus) {
        await users.updateOne(
          { telegramId: user.referredBy },
          { $inc: { egBalance: 120, totalRefEarned: 120 } }
        );
      }

      return res.status(200).json({
        success: true,
        miningStarted: true,
        miningFinishTime,
        message: `All ads watched! Mining started for ${plan.miningHours} hours.`,
      });
    } else {
      // More ads needed
      await users.updateOne(
        { telegramId: String(telegramId) },
        {
          $set: { 'activePlan.adsWatched': newAdsWatched },
          $inc: { totalAdsWatched: 1 },
        }
      );

      return res.status(200).json({
        success: true,
        miningStarted: false,
        adsWatched: newAdsWatched,
        adsRequired: plan.adsRequired,
        remaining: plan.adsRequired - newAdsWatched,
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
