import { createClient } from 'redis';

export const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Single shared, non-subscriber client — mirrors api/src/redis/client.ts's singleton
// pattern. Used for the verdicts publish (index.ts) and the leaderboard ZINCRBY +
// ch:leaderboard publish (scoring.ts). Never put this client into subscriber mode.
export const redisClient = createClient({ url: redisUrl });
redisClient.on('error', (err) => console.error('[worker] redis client error', err));
await redisClient.connect();
