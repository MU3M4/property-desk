import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  const redis = Redis.fromEnv();
  if (req.method === 'DELETE') {
    const phone = String(req.query.phone || '');
    await redis.hdel('leads', phone); await redis.del(`wa:${phone}`);
    return res.status(200).json({ deleted: phone });
  }
  const all = (await redis.hgetall('leads')) || {};
  const leads = Object.values(all).map((v) => (typeof v === 'string' ? JSON.parse(v) : v));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ leads });
}
