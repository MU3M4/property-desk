import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  try {
    const redis = Redis.fromEnv();
    const [listings, updated] = await Promise.all([redis.get('listings'), redis.get('updated')]);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ listings: listings || [], updated: updated || null });
  } catch (e) {
    res.status(200).json({ listings: [], updated: null, error: 'storage not configured' });
  }
}
