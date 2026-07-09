import { randomUUID } from 'node:crypto';
import { redisClient } from './redis.js';
import { logger } from './logger.js';

// Reuses the sliding-window-over-a-Redis-ZSET idiom already built for rate limiting
// (api/src/middleware/rateLimit.ts) instead of inventing a new metrics primitive: one member
// per event, score = event timestamp, the API's /metrics route ZCOUNTs the last 60s on read.
// The worker only ever writes here — it has no HTTP surface of its own (see
// startWorkerHeartbeat below for how liveness is reported without one). ARCHITECTURE.md §13.
const RETENTION_SECONDS = 24 * 60 * 60; // nothing here needs to outlive a day
const LATENCY_SAMPLE_CAP = 200;

async function recordEvent(key: string): Promise<void> {
  // Member must be a fresh unique id per event, never a business value (a verdict, a token
  // count) — ZSET members are unique, so two events with the same member collapse into one
  // and silently undercount.
  await redisClient.zAdd(key, { score: Date.now(), value: randomUUID() });
  await redisClient.expire(key, RETENTION_SECONDS);
}

export async function recordVerdict(verdict: string): Promise<void> {
  await Promise.all([recordEvent(`metrics:verdicts:${verdict}`), recordEvent('metrics:verdicts:all')]);
}

export async function recordRun(): Promise<void> {
  await recordEvent('metrics:runs');
}

export async function recordJudgeLatency(enqueuedAtMs: number): Promise<void> {
  const latencyMs = Date.now() - enqueuedAtMs;
  await redisClient.lPush('metrics:judge:latencies', String(latencyMs));
  await redisClient.lTrim('metrics:judge:latencies', 0, LATENCY_SAMPLE_CAP - 1);
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TTL_SECONDS = 30;

// The worker has no HTTP listener (a pure BullMQ consumer, no exposed port) — a Redis
// heartbeat key is how the API's /ready and /metrics routes learn whether the worker process
// is alive, without adding a second process/port just for a health check.
export function startWorkerHeartbeat(): void {
  const beat = () => {
    redisClient.set('worker:heartbeat', String(Date.now()), { EX: HEARTBEAT_TTL_SECONDS }).catch((err) => {
      logger.error({ err }, '[worker] heartbeat write failed');
    });
  };
  beat();
  setInterval(beat, HEARTBEAT_INTERVAL_MS);
}
