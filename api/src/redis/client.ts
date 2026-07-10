import { createClient } from 'redis';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

// disableOfflineQueue: node-redis v4's default behavior queues commands in memory and waits
// for reconnection before sending them, rather than rejecting immediately — confirmed
// empirically to hang a request for minutes with Redis down (the rate limiter's own fail-open
// catch in middleware/rateLimit.ts never got a chance to fire, because the command it awaited
// never settled). Every consumer of this shared client (rate limiting, hint quota, metrics,
// leaderboard ZSET ops) already treats Redis as a degradable coordination layer, never a
// source of truth — failing fast when disconnected is strictly more correct for all of them
// than hanging indefinitely. Same fix as api/src/queue.ts's enableOfflineQueue:false (ioredis
// names the option the other way around).
export const redisClient = createClient({ url: env.redisUrl, disableOfflineQueue: true });
redisClient.on('error', (err) => logger.error({ err }, 'Redis client error'));
await redisClient.connect();
