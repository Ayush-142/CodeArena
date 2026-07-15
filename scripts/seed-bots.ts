// Registers bot accounts (bot01..botN) against a live deployment's real HTTP API and saves each
// one's raw JWT to scripts/bot-tokens.json. The JWT (not just the session cookie) is what's
// saved because simulate-contest.ts's --load mode needs it twice over: once as a `Cookie: token=`
// header for REST calls, and once as the same header on a Socket.io handshake (socket.io-client
// has no browser cookie jar, so the raw token has to be threaded through by hand).
//
// Resumable: bots already present in bot-tokens.json are reused with NO network call at all
// (not even a login) — rl:auth (10 register/login attempts / 15min / IP, shared with every other
// auth call from this machine, per api/src/config/rateLimits.ts) is precious when growing a large
// pool incrementally, so re-running this script to add more bots must never re-spend budget on
// ones it already has. Progress is written after every new bot (not just at the end), so a crash
// or a long rate-limit wait mid-run never loses what's already been registered.
//
//   BASE_URL=https://your-vm npx tsx scripts/seed-bots.ts
//   BASE_URL=https://your-vm BOT_COUNT=45 npx tsx scripts/seed-bots.ts   # grow an existing pool
//
// Env: BASE_URL (default http://localhost:3001), BOT_COUNT (default 15)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, 'bot-tokens.json');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const BOT_COUNT = Number(process.env.BOT_COUNT) || 15;
const BOT_PASSWORD = 'BotPass123'; // fixed, same convention as api/src/scripts/simulate-contest.ts's bot accounts
const NETWORK_RETRY_MAX_ATTEMPTS = 8;

function botHandle(i: number): string {
  return `bot${String(i).padStart(2, '0')}`; // bot01..bot99
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ApiResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- generic HTTP response shape, varies per route
  setCookie?: string;
}

// Retries both 429 (server rate limit — sleeps the server's own retryAfterMs) and transport-level
// failures (DNS hiccup, connect timeout — this deployed VM's connectivity has proven flaky enough
// during long sessions that an unretried `fetch` throwing crashes and loses all unsaved progress).
async function apiRequest(method: string, path: string, body?: unknown): Promise<ApiResult> {
  let networkAttempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      networkAttempt = 0;
    } catch (err) {
      networkAttempt += 1;
      if (networkAttempt > NETWORK_RETRY_MAX_ATTEMPTS) throw err;
      const backoffMs = Math.min(2000 * 2 ** (networkAttempt - 1), 30_000);
      console.log(
        `  [network error] ${method} ${path} — ${err instanceof Error ? err.message : err} — retrying in ${backoffMs}ms (attempt ${networkAttempt}/${NETWORK_RETRY_MAX_ATTEMPTS})`,
      );
      await sleep(backoffMs);
      continue;
    }
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

function loadExisting(): Map<string, BotToken> {
  if (!existsSync(OUTPUT_PATH)) return new Map();
  const tokens: BotToken[] = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  return new Map(tokens.map((t) => [t.handle, t]));
}

function persist(byHandle: Map<string, BotToken>): void {
  writeFileSync(OUTPUT_PATH, JSON.stringify([...byHandle.values()], null, 2));
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
  const byHandle = loadExisting();
  console.log(`${byHandle.size} bot(s) already in ${OUTPUT_PATH} — reusing without a network call`);
  console.log(`ensuring ${BOT_COUNT} bots exist against ${BASE_URL}...`);

  for (let i = 1; i <= BOT_COUNT; i++) {
    const handle = botHandle(i);
    if (byHandle.has(handle)) continue; // already have a token — zero rl:auth spend

    const bot = await registerOrLoginBot(i);
    byHandle.set(handle, bot);
    persist(byHandle); // after every new bot — a crash or long 429 wait mid-run loses nothing
    console.log(`  bot ready: ${bot.handle} (${bot.userId})`);
    await sleep(300 + Math.random() * 500); // good-citizen jitter, same as simulate-contest.ts's createBots
  }

  console.log(`\n${byHandle.size} bot tokens present in ${OUTPUT_PATH}`);
}

await main();
