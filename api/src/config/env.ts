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
};
