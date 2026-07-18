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

  // Phase 6 (Nakalchi integration): fire-and-forget integrity:analyze
  // enqueue at contest finalization (contests/rebuild.ts) is gated behind
  // this flag - off by default so an unconfigured deployment doesn't try to
  // reach a Nakalchi instance that isn't there.
  integrityAnalysisEnabled: process.env.INTEGRITY_ANALYSIS_ENABLED === 'true',
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,
  nakalchiApiBaseUrl: process.env.NAKALCHI_API_BASE_URL,
  nakalchiApiKey: process.env.NAKALCHI_API_KEY,
  nakalchiWebhookSecret: process.env.NAKALCHI_WEBHOOK_SECRET,
  internalWebhookCallbackUrl: process.env.INTERNAL_WEBHOOK_CALLBACK_URL,
};

// Fail fast, same posture as requireEnv above: these are only optional
// process.env reads (not requireEnv) because they're irrelevant to a
// deployment that never turns the flag on - but a deployment that DOES
// turn it on with an incomplete config should never silently no-op.
if (env.integrityAnalysisEnabled) {
  const missing = (
    [
      ['INTERNAL_SERVICE_TOKEN', env.internalServiceToken],
      ['NAKALCHI_API_BASE_URL', env.nakalchiApiBaseUrl],
      ['NAKALCHI_API_KEY', env.nakalchiApiKey],
      ['NAKALCHI_WEBHOOK_SECRET', env.nakalchiWebhookSecret],
      ['INTERNAL_WEBHOOK_CALLBACK_URL', env.internalWebhookCallbackUrl],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`INTEGRITY_ANALYSIS_ENABLED=true but missing required env var(s): ${missing.join(', ')}`);
  }
}
