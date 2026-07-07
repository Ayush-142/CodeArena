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
