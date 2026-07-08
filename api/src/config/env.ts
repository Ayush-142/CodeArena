function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  jwtSecret: requireEnv('JWT_SECRET'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  hintMaxTokens: Number(process.env.HINT_MAX_TOKENS) || 600,
  hintGlobalRpmLimit: Number(process.env.HINT_GLOBAL_RPM_LIMIT) || 8,
  // Confirmed via a live 429 during testing: Google's actual free-tier daily cap for
  // gemini-2.5-flash-lite is 20 requests/day/project (not the ~1,000/day originally
  // assumed). 18 leaves a 2-request margin under that hard limit for retries/testing.
  hintGlobalDailyLimit: Number(process.env.HINT_GLOBAL_DAILY_LIMIT) || 18,
};
