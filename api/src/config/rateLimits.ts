export interface RateWindow {
  windowMs: number;
  limit: number;
}

export const SUBMISSION_RATE_WINDOWS: RateWindow[] = [
  { windowMs: 10_000, limit: 1 }, // 1 submission / 10s / user — blocks double-click / rapid-fire spam
  { windowMs: 3_600_000, limit: 30 }, // 30 submissions / hour / user — caps sustained abuse, generous for normal practice
];

export const AUTH_RATE_WINDOWS: RateWindow[] = [
  { windowMs: 15 * 60_000, limit: 10 }, // 10 attempts / 15min / IP — slows brute force without punishing typo retries
];

export const HINT_ANTI_SPAM_WINDOWS: RateWindow[] = [
  { windowMs: 3_000, limit: 1 }, // 1 request / 3s / (user,problem,level) — blocks double-click only;
  // the real per-level cap already falls out of sequential unlocking (max 3 ever), and the real
  // daily cap is the dedicated refundable module in api/src/hints/quota.ts, not this middleware.
];

// More generous than SUBMISSION_RATE_WINDOWS — Run only executes the (small) public sample
// set, not the full hidden test suite, and is explicitly meant to be the fast-iteration
// affordance. No idempotency key backs Run, so the 1/3s window is also what prevents a
// double-click from firing two runs (a duplicate click gets 429 instead of being coalesced).
export const RUN_RATE_WINDOWS: RateWindow[] = [
  { windowMs: 3_000, limit: 1 }, // 1 run / 3s / user — anti-double-click, matches hints' cadence
  { windowMs: 3_600_000, limit: 60 }, // 60 runs / hour / user — 2x the submission hourly cap
];
