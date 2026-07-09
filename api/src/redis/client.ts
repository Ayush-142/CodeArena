import { createClient } from 'redis';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export const redisClient = createClient({ url: env.redisUrl });
redisClient.on('error', (err) => logger.error({ err }, 'Redis client error'));
await redisClient.connect();
