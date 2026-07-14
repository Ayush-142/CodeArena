// Registers 15 bot accounts (bot01..bot15) against a live deployment's real HTTP API and saves
// each one's raw JWT to scripts/bot-tokens.json. The JWT (not just the session cookie) is what's
// saved because simulate-contest.ts's --load mode needs it twice over: once as a `Cookie: token=`
// header for REST calls, and once as the same header on a Socket.io handshake (socket.io-client
// has no browser cookie jar, so the raw token has to be threaded through by hand).
//
// Resumable: re-running this script logs in instead of re-registering any bot that already
// exists, so it's safe to run again after a partial failure.
//
//   BASE_URL=https://your-vm npx tsx scripts/seed-bots.ts
//
// Env: BASE_URL (default http://localhost:3001), BOT_COUNT (default 15)
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, 'bot-tokens.json');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const BOT_COUNT = Number(process.env.BOT_COUNT) || 15;
const BOT_PASSWORD = 'BotPass123'; // fixed, same convention as api/src/scripts/simulate-contest.ts's bot accounts

function botHandle(i: number): string {
  return `bot${String(i).padStart(2, '0')}`; // bot01..bot15
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ApiResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- generic HTTP response shape, varies per route
  setCookie?: string;
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<ApiResult> {
  for (;;) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text.length > 0 ? JSON.parse(text) : null;

    if (res.status === 429) {
      const retryAfterMs: number =
        parsed?.error?.details?.retryAfterMs ?? Number(res.headers.get('retry-after') ?? '1') * 1000;
      console.log(`  [rate limited] ${method} ${path} — sleeping ${retryAfterMs}ms`);
      await sleep(retryAfterMs + 250);
      continue;
    }

    return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') ?? undefined };
  }
}

// Set-Cookie: "token=<jwt>; Max-Age=...; Path=/; ...; HttpOnly; Secure; SameSite=Strict"
function extractToken(setCookieHeader: string): string {
  const pair = setCookieHeader.split(';')[0]; // "token=<jwt>"
  const eq = pair.indexOf('=');
  return pair.slice(eq + 1);
}

interface BotToken {
  handle: string;
  email: string;
  userId: string;
  token: string;
}

async function registerOrLoginBot(i: number): Promise<BotToken> {
  const handle = botHandle(i);
  const email = `${handle}@codearena.dev`;

  let res = await apiRequest('POST', '/api/auth/register', { handle, email, password: BOT_PASSWORD });
  if (res.status === 201 && res.setCookie) {
    return { handle, email, userId: res.body.id as string, token: extractToken(res.setCookie) };
  }
  if (res.status === 409) {
    res = await apiRequest('POST', '/api/auth/login', { handle, password: BOT_PASSWORD });
    if (res.status === 200 && res.setCookie) {
      return { handle, email, userId: res.body.id as string, token: extractToken(res.setCookie) };
    }
  }
  throw new Error(`failed to register/login bot ${handle}: ${res.status} ${JSON.stringify(res.body)}`);
}

async function main(): Promise<void> {
  console.log(`registering ${BOT_COUNT} bots against ${BASE_URL}...`);
  const tokens: BotToken[] = [];
  for (let i = 1; i <= BOT_COUNT; i++) {
    const bot = await registerOrLoginBot(i);
    tokens.push(bot);
    console.log(`  bot ready: ${bot.handle} (${bot.userId})`);
    await sleep(300 + Math.random() * 500); // good-citizen jitter, same as simulate-contest.ts's createBots
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nwrote ${tokens.length} bot tokens to ${OUTPUT_PATH}`);
}

await main();
