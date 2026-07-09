import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { redisClient } from '../redis/client.js';
import { AppError } from './errors.js';
import type { RateWindow } from '../config/rateLimits.js';
import { logger } from '../logger.js';

// Sliding-window request log implemented as a Redis ZSET, checked/updated atomically in one
// Lua script. Chosen over a two-bucket/fixed-window approximation: at this project's request
// volume the exact ZSET approach costs nothing extra, is atomic in one round trip, and is far
// easier to reason about ("one entry per request timestamp, trim anything outside the window,
// count what's left") than an approximation that can admit up to 2x burst at window boundaries.
//
// A single script call checks an arbitrary list of {windowMs, limit} pairs against ONE Redis
// key, matching §7's one-key-per-scope convention (rl:sub:{userId}, rl:auth:{ip}) exactly.
// This also avoids a real bug: chaining two independently-invoked single-window middlewares
// against the same key would break, because the first (shorter-window) middleware's trim step
// would delete entries the second (longer-window) middleware still needs to count. Trimming
// once by the max window across all windows, then checking each window's count, is correct
// for N windows sharing one key in a single atomic operation.
//
// KEYS[1] = zset key
// ARGV[1] = now (ms, epoch)
// ARGV[2] = JSON-encoded RateWindow[]
// ARGV[3] = unique member id for this request
// cjson is built into Redis's Lua scripting environment — no extra config needed.
const SLIDING_WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local windows = cjson.decode(ARGV[2])
local member = ARGV[3]

local maxWindow = 0
for _, w in ipairs(windows) do
  if w.windowMs > maxWindow then maxWindow = w.windowMs end
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - maxWindow)

for _, w in ipairs(windows) do
  local windowStart = now - w.windowMs
  local count = redis.call('ZCOUNT', KEYS[1], windowStart, now)
  if count >= w.limit then
    local oldest = redis.call('ZRANGEBYSCORE', KEYS[1], windowStart, now, 'LIMIT', 0, 1, 'WITHSCORES')
    local retryAfter = w.windowMs
    if oldest[2] ~= nil then
      retryAfter = (tonumber(oldest[2]) + w.windowMs) - now
    end
    return {0, retryAfter}
  end
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], maxWindow)
return {1, 0}
`;

async function checkSlidingWindow(
  key: string,
  windows: RateWindow[],
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const now = Date.now();
  const member = `${now}-${randomUUID()}`;
  const reply = (await redisClient.eval(SLIDING_WINDOW_SCRIPT, {
    keys: [key],
    arguments: [String(now), JSON.stringify(windows), member],
  })) as unknown as [number, number];
  return { allowed: reply[0] === 1, retryAfterMs: reply[1] };
}

export function rateLimit(opts: {
  keyPrefix: string;
  windows: RateWindow[];
  identify: (req: Request) => string;
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${opts.keyPrefix}:${opts.identify(req)}`;
    try {
      const { allowed, retryAfterMs } = await checkSlidingWindow(key, opts.windows);
      if (!allowed) {
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterMs }));
        return;
      }
      next();
    } catch (err) {
      // Redis unreachable: FAIL OPEN. Per §2, Redis is a coordination/perf layer, never
      // source of truth; rate limiting is an abuse-prevention layer, not a security boundary.
      // Failing closed would mean a Redis outage takes down all submissions/auth, which is a
      // worse failure mode for this project than temporarily allowing unlimited requests.
      // Logged at error level on every occurrence: fail-open must never fail silently, since
      // this is the one path where abuse-prevention goes unenforced — ops needs a log trail
      // to notice a sustained Redis outage.
      logger.error({ err, key }, 'rate limit check failed, failing open');
      next();
    }
  };
}
