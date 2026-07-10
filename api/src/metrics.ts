import { randomUUID } from 'node:crypto';
import { redisClient } from './redis/client.js';
import { submissionsQueue, runsQueue } from './queue.js';
import { logger } from './logger.js';

// Reads what worker/src/metrics.ts writes (verdicts/runs/judge-latency ZSETs+list, a heartbeat
// key), plus writes its own local metrics for events that originate in this process (hint
// tokens/cache hits — routes/hints.ts calls Gemini directly, the worker is never involved).
// Same sliding-window-ZSET idiom as rate limiting (api/src/middleware/rateLimit.ts) — reused
// deliberately rather than inventing a second pattern. ARCHITECTURE.md §13.

const MINUTE_MS = 60_000;
const STALE_TRIM_MS = 24 * 60 * 60 * 1000; // opportunistic cleanup of anything older than a day
const HEARTBEAT_FRESH_MS = 30_000; // must match worker/src/metrics.ts's HEARTBEAT_TTL_SECONDS

async function countLastMinute(key: string): Promise<number> {
  const now = Date.now();
  await redisClient.zRemRangeByScore(key, 0, now - STALE_TRIM_MS);
  return redisClient.zCount(key, now - MINUTE_MS, now);
}

interface JudgeLatencyStats {
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleCount: number;
}

async function judgeLatencyStats(): Promise<JudgeLatencyStats> {
  const raw = await redisClient.lRange('metrics:judge:latencies', 0, -1);
  const values = raw
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (values.length === 0) return { avgMs: null, p50Ms: null, p95Ms: null, sampleCount: 0 };
  const avgMs = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  const percentile = (p: number) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  return { avgMs, p50Ms: percentile(0.5), p95Ms: percentile(0.95), sampleCount: values.length };
}

// --- Active socket connections: in-memory, owned by socket/index.ts's connection/disconnect
// handlers (same process — the socket server runs inside the api container, see the Phase 7
// plan's decision on socket placement). Not persisted; resets on restart, which is fine for a
// live gauge. ---
let activeSocketConnections = 0;
export function incrementActiveSocketConnections(): void {
  activeSocketConnections += 1;
}
export function decrementActiveSocketConnections(): void {
  activeSocketConnections = Math.max(0, activeSocketConnections - 1);
}

// --- Hints: tokens/day is a plain daily counter, NOT a ZSET keyed by tokensUsed — two hints
// using the same token count would collide as ZSET members and silently undercount. Cache
// hit/miss stay ZSETs (per-minute rate is the interesting number there), each entry a fresh
// uuid member so repeat hits in the same millisecond never collide. ---
function hintTokensKey(date = new Date()): string {
  return `metrics:hint:tokens:${date.toISOString().slice(0, 10)}`; // yyyy-mm-dd, UTC
}

// All three recorders below swallow their own errors (logged, not thrown) — a metrics write
// must never fail the actual hint request, the same posture worker/src/index.ts uses around
// its recordVerdict/recordRun calls. Callers in routes/hints.ts can fire-and-forget these.

export async function recordHintTokens(tokensUsed: number): Promise<void> {
  if (tokensUsed <= 0) return;
  try {
    const key = hintTokensKey();
    await redisClient.incrBy(key, tokensUsed);
    await redisClient.expire(key, 48 * 60 * 60); // covers a read straddling the UTC day boundary
  } catch (err) {
    logger.error({ err }, '[metrics] recordHintTokens failed');
  }
}

export async function recordHintCacheHit(): Promise<void> {
  try {
    await redisClient.zAdd('metrics:hint:cacheHit', { score: Date.now(), value: randomUUID() });
    await redisClient.expire('metrics:hint:cacheHit', STALE_TRIM_MS / 1000);
  } catch (err) {
    logger.error({ err }, '[metrics] recordHintCacheHit failed');
  }
}

export async function recordHintCacheMiss(): Promise<void> {
  try {
    await redisClient.zAdd('metrics:hint:cacheMiss', { score: Date.now(), value: randomUUID() });
    await redisClient.expire('metrics:hint:cacheMiss', STALE_TRIM_MS / 1000);
  } catch (err) {
    logger.error({ err }, '[metrics] recordHintCacheMiss failed');
  }
}

async function hintTokensToday(): Promise<number> {
  // Reads only today's bucket — a request right after UTC midnight simply reports a fresh
  // (small) number rather than yesterday's; acceptable for an ops gauge, not a billing figure.
  const val = await redisClient.get(hintTokensKey());
  return val ? Number(val) : 0;
}

export interface WorkerHeartbeat {
  alive: boolean;
  ageMs: number | null;
}

export async function getWorkerHeartbeat(): Promise<WorkerHeartbeat> {
  const val = await redisClient.get('worker:heartbeat');
  if (!val) return { alive: false, ageMs: null };
  const ageMs = Date.now() - Number(val);
  return { alive: ageMs < HEARTBEAT_FRESH_MS, ageMs };
}

const VERDICT_TYPES = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'] as const;

export async function collectMetrics() {
  const [verdictsPerMinEntries, runsPerMin, judgeLatency, queueCounts, cacheHitPerMin, cacheMissPerMin, tokensToday, worker] =
    await Promise.all([
      Promise.all(VERDICT_TYPES.map(async (v) => [v, await countLastMinute(`metrics:verdicts:${v}`)] as const)),
      countLastMinute('metrics:runs'),
      judgeLatencyStats(),
      Promise.all([submissionsQueue.getJobCounts(), runsQueue.getJobCounts()]),
      countLastMinute('metrics:hint:cacheHit'),
      countLastMinute('metrics:hint:cacheMiss'),
      hintTokensToday(),
      getWorkerHeartbeat(),
    ]);

  return {
    verdictsPerMin: Object.fromEntries(verdictsPerMinEntries) as Record<(typeof VERDICT_TYPES)[number], number>,
    runsPerMin,
    judgeLatencyMs: judgeLatency,
    queueDepth: { submissions: queueCounts[0], runs: queueCounts[1] },
    activeSocketConnections,
    hints: { cacheHitPerMin, cacheMissPerMin, tokensUsedToday: tokensToday },
    worker,
  };
}
