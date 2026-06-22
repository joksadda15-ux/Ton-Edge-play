import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI);

const DEFAULT_TASKS = [
  { id: 'join_channel', title: 'Join Telegram Channel', reward: 10, link: 'https://t.me/TonEdgePlay', type: 'telegram' },
  { id: 'follow_twitter', title: 'Follow on Twitter/X', reward: 10, link: 'https://x.com/TonEdgePlay', type: 'social' },
  { id: 'share_app', title: 'Share App with Friends', reward: 10, link: '', type: 'share' },
];

export default async function handler(req, res) {
  try {
    await client.connect();
    const db = client.db('tonedge');
    const users = db.collection('users');
    const tasks = db.collection('tasks');

    // GET — fetch all tasks with user completion status
    if (req.method === 'GET') {
      const { telegramId } = req.query;
      if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

      const user = await users.findOne({ telegramId: String(telegramId) });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const allTasks = await tasks.find({}).toArray();
      const taskList = allTasks.length > 0 ? allTasks : DEFAULT_TASKS;

      const completedIds = user.completedTasks || [];
      const result = taskList.map(t => ({
        ...t,
        completed: completedIds.includes(t.id),
      }));

      return res.status(200).json({ success: true, tasks: result });
    }

    // POST — complete a task
    if (req.method === 'POST') {
      const { telegramId, taskId } = req.body;
      if (!telegramId || !taskId) return res.status(400).json({ error: 'telegramId and taskId required' });

      const user = await users.findOne({ telegramId: String(telegramId) });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const completedIds = user.completedTasks || [];
      if (completedIds.includes(taskId)) {
        return res.status(400).json({ error: 'Task already completed.' });
      }

      const allTasks = await tasks.find({}).toArray();
      const taskList = allTasks.length > 0 ? allTasks : DEFAULT_TASKS;
      const task = taskList.find(t => t.id === taskId);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      await users.updateOne(
        { telegramId: String(telegramId) },
        {
          $inc: { egBalance: task.reward },
          $push: { completedTasks: taskId },
        }
      );

      return res.status(200).json({ success: true, reward: task.reward });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    await client.close();
  }
}
