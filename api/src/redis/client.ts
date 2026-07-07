import { createClient } from 'redis';
import { env } from '../config/env.js';

export const redisClient = createClient({ url: env.redisUrl });
redisClient.on('error', (err) => console.error('Redis client error', err));
await redisClient.connect();
