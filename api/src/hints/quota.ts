import { redisClient } from '../redis/client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// Confirmed via a live 429 during Phase 6 testing: the whole app shares only 20
// Gemini requests/day (Google's free-tier cap is per-project, not per-user — see
// tryConsumeGlobalDailyHintSlot below). 3/user keeps a small handful of users from
// being able to exhaust that entire shared budget by themselves.
const DAILY_HINT_LIMIT = 3;

// Sliding-window sorted set: member = a unique token per consumption attempt,
// score = timestamp. ZREMRANGEBYSCORE trims entries older than the window on
// every call, so the set never grows unbounded and always reflects the live
// count. Returns the token (needed by the caller to refund) or null if the
// limit is already reached.
async function tryConsume(key: string, limit: number, windowMs: number): Promise<string | null> {
  const now = Date.now();
  const token = `${now}-${Math.random().toString(36).slice(2)}`;
  await redisClient.zRemRangeByScore(key, 0, now - windowMs);
  const count = await redisClient.zCard(key);
  if (count >= limit) return null;
  await redisClient.zAdd(key, { score: now, value: token });
  await redisClient.expire(key, Math.ceil(windowMs / 1000));
  return token;
}

async function refund(key: string, token: string): Promise<void> {
  await redisClient.zRem(key, token);
}

// Per-user daily cap. Implemented as a dedicated module rather than the generic
// rateLimit() Express middleware because a global-limiter rejection or an
// upstream Gemini RESOURCE_EXHAUSTED error (see routes/hints.ts) must be able to
// refund this consumption — the generic middleware has no "undo" primitive.
export async function tryConsumeDailyHint(userId: string): Promise<string | null> {
  return tryConsume(`rl:hint-daily:${userId}`, DAILY_HINT_LIMIT, DAY_MS);
}

export async function refundDailyHint(userId: string, token: string): Promise<void> {
  return refund(`rl:hint-daily:${userId}`, token);
}

export async function hintsRemainingToday(userId: string): Promise<number> {
  const key = `rl:hint-daily:${userId}`;
  await redisClient.zRemRangeByScore(key, 0, Date.now() - DAY_MS);
  const used = await redisClient.zCard(key);
  return Math.max(0, DAILY_HINT_LIMIT - used);
}

// Global — shared across ALL users via a fixed key, not per-user. Protects the
// whole app's Gemini free-tier quota, which Google enforces per-project across
// every caller, not per end user (a per-user cap alone can't protect this).
export async function tryConsumeGlobalHintSlot(rpmLimit: number): Promise<string | null> {
  return tryConsume('rl:hint-global', rpmLimit, MINUTE_MS);
}

export async function refundGlobalHintSlot(token: string): Promise<void> {
  return refund('rl:hint-global', token);
}

// Global DAILY cap — confirmed via a live 429 during Phase 6 testing that Google's
// actual free-tier limit for gemini-2.5-flash-lite is
// GenerateRequestsPerDayPerProjectPerModel-FreeTier: 20, not the ~1,000/day figure
// originally assumed when this phase was planned. The per-minute rl:hint-global above
// does nothing to protect this — a handful of users well under 8 requests/minute can
// still exhaust the whole day's budget for every user within minutes. Same refundable
// tryConsume/refund pattern, sliding 24h window, fixed key (not per-user).
export async function tryConsumeGlobalDailyHintSlot(dailyLimit: number): Promise<string | null> {
  return tryConsume('rl:hint-global-daily', dailyLimit, DAY_MS);
}

export async function refundGlobalDailyHintSlot(token: string): Promise<void> {
  return refund('rl:hint-global-daily', token);
}
