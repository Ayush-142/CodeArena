// Bot-contest driver — exercises the REAL system end-to-end (real register/login/submit HTTP
// calls, real judging, real BullMQ/Docker pipeline), not DB inserts. Used to make a live demo
// contest's leaderboard reorder in real time (see DEMO.md), and separately (--load) to produce
// the measured performance numbers in README.md's "Measured performance" table.
//
//   npm run simulate-contest                 # drives the seeded live demo contest
//   npm run simulate-contest -- --contest=some-slug
//   npm run simulate-contest -- --cleanup    # removes bot AND load-test users + their submissions
//   npm run simulate-contest -- --load --contest=some-slug   # sustained load/acceptance test — see runOfficialLoadTest()
//   npm run simulate-contest -- --ramp --contest=some-slug   # staged max-load characterization — see runRampTest()
//
// Env: BASE_URL (default http://localhost:3001), SIMULATOR_BOT_COUNT (default 8),
// SIMULATOR_MAX_CONCURRENT (default 3), LOAD_MAX_INFLIGHT_PER_BOT (default 3),
// LOAD_DURATION_MINUTES (default 5), LOAD_WARMUP_COUNT (default 3),
// REDIS_TUNNEL_URL (default redis://127.0.0.1:6379), RAMP_STAGE_SECONDS (default 50),
// RAMP_DRAIN_DEADLINE_MS (default 300000).
//
// --load/--ramp are acceptance-test tools, not demo features: they deliberately saturate the
// judge queue to measure throughput/latency/drain-time under sustained load. Never run either
// during a live audience demo — see DEMO.md's warning.
//
// --load/--ramp talk to BASE_URL purely over HTTP + Socket.io (no Mongo connection — designed to
// run from an operator's own machine against a deployed VM, not just via `docker compose exec`
// on the VM itself). Each resolves --contest=<slug> through the public contest API, discovers
// that contest's problems (and their real Mongo ids, needed to find scripts/solutions/<problemId>/)
// from GET /api/contests/:id once the contest is running, loads bot sessions from
// scripts/bot-tokens.json (written by scripts/seed-bots.ts), and pulls queue depth by talking to
// BullMQ directly over REDIS_TUNNEL_URL — GET /metrics is deliberately unreachable through the
// public domain in production (see DEPLOY.md), so neither mode ever depends on it.
//
// Concurrency model: each bot keeps up to LOAD_MAX_INFLIGHT_PER_BOT submissions truly pending at
// once (fired without awaiting their verdict first — see runLoadWindow's fireOne/botScheduler),
// paced only by the server's own rl:sub floor (1 submission/10s/user). Applied concurrency is
// bots × in-flight-per-bot, e.g. 15 × 3 = 45 for the default --load spec — NOT a single global
// semaphore serializing every bot down to one shared pool (an earlier version of this script did
// that by mistake; Little's Law on its output — ~21.8 verdicts/min × ~9.5s judge latency ≈ 3.5 —
// gave away that only ~3 were ever truly concurrent, not 45).
import 'dotenv/config'; // MUST be first — same ESM import-hoisting reason as seed.ts/reset-demo-contest.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { io as ioClient, type Socket } from 'socket.io-client';
import { Contest } from '../models/Contest.js';
import { Problem } from '../models/Problem.js';
import { User } from '../models/User.js';
import { Submission } from '../models/Submission.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLUTIONS_DIR = join(__dirname, '../../../scripts/solutions');
const BOT_TOKENS_PATH = join(__dirname, '../../../scripts/bot-tokens.json');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const BOT_COUNT = Number(process.env.SIMULATOR_BOT_COUNT) || 8;
const MAX_CONCURRENT = Number(process.env.SIMULATOR_MAX_CONCURRENT) || 3;
const LOAD_DURATION_MINUTES = Number(process.env.LOAD_DURATION_MINUTES) || 5;
const LOAD_MAX_INFLIGHT_PER_BOT = Number(process.env.LOAD_MAX_INFLIGHT_PER_BOT) || 3;
const LOAD_WARMUP_COUNT = Number(process.env.LOAD_WARMUP_COUNT) || 3;
const REDIS_TUNNEL_URL = process.env.REDIS_TUNNEL_URL || 'redis://127.0.0.1:6379';

// Must match reset-demo-contest.ts's BOT_HANDLE_PREFIX. Alphanumeric-only (api/src/routes/
// auth.ts's HANDLE_RE has no underscore) — "bot0001", not "bot_0001".
const BOT_HANDLE_PREFIX = 'bot';
const BOT_PASSWORD = 'BotPass123'; // fixed, documented in DEMO.md — bot accounts, not real users
// Separate prefix from the demo-mode bots above so a load-test run and a contest-narrative run
// never collide on the same handle if both happen to be live at once; --cleanup removes both
// prefixes. (--load itself no longer creates these — it reads scripts/bot-tokens.json instead —
// but the prefix is kept so --cleanup still catches any left over from before this script
// switched to reusing seed-bots.ts's accounts.)
const LOAD_HANDLE_PREFIX = 'load';

function argValue(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=').slice(1).join('=') : undefined;
}
const CONTEST_SLUG = argValue('contest') || 'demo-live-contest';
const CLEANUP = process.argv.includes('--cleanup');
const LOAD_MODE = process.argv.includes('--load');
const RAMP_MODE = process.argv.includes('--ramp');

function botHandle(prefix: string, i: number): string {
  return `${prefix}${String(i).padStart(4, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Minimal concurrency gate: caps how many submit+poll-to-terminal cycles run at once across
// ALL bots. The judge queue itself processes one job at a time (no `concurrency` option set on
// either BullMQ Worker — see worker/src/index.ts), so this is a client-side safety net matching
// the plan's requirement, not the thing actually preventing overload. ---
class Semaphore {
  private available: number;
  private queue: (() => void)[] = [];
  constructor(n: number) {
    this.available = n;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.available -= 1;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

interface ApiResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- generic HTTP response shape, varies per route
  setCookie?: string;
}

// Incremented on every 429 any apiRequest call observes, across the whole process. --load's
// runLoadWindow snapshots this before/after each window to report a per-window count — a
// well-paced load window (respecting SUBMIT_RATE_FLOOR_MS below) should see this stay at 0;
// any nonzero count means the client raced the server's rate limiter, not that the limiter is
// itself capping achievable concurrency (see the file-level comment above on that distinction).
let total429Count = 0;

const NETWORK_RETRY_MAX_ATTEMPTS = 8;

// Every call treats 429 RATE_LIMITED as retryable — sleeps retryAfterMs (from the AppError's
// `details`, same shape rateLimit.ts always throws) and retries, so a live demo can't crash or
// abort mid-run on a rate-limit hit. Also retries transport-level failures (DNS hiccup, TLS
// reset, connection refused mid-handshake) with exponential backoff — the deployed VM's
// connectivity has proven flaky enough during long runs that an unretried `fetch` throwing would
// otherwise crash a 5-40 minute load/ramp run over a single transient blip. Only gives up after
// NETWORK_RETRY_MAX_ATTEMPTS consecutive network-level failures.
async function apiRequest(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  let networkAttempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      networkAttempt = 0; // reset backoff on any successful round trip, even a non-2xx one
    } catch (err) {
      networkAttempt += 1;
      if (networkAttempt > NETWORK_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      const backoffMs = Math.min(2000 * 2 ** (networkAttempt - 1), 30_000);
      console.log(
        `  [network error] ${method} ${path} — ${err instanceof Error ? err.message : err} — retrying in ${backoffMs}ms (attempt ${networkAttempt}/${NETWORK_RETRY_MAX_ATTEMPTS})`,
      );
      await sleep(backoffMs);
      continue;
    }
    const text = await res.text();
    const body = text.length > 0 ? JSON.parse(text) : null;

    if (res.status === 429) {
      total429Count += 1;
      const retryAfterMs: number =
        body?.error?.details?.retryAfterMs ?? Number(res.headers.get('retry-after') ?? '1') * 1000;
      console.log(`  [rate limited] ${method} ${path} — sleeping ${retryAfterMs}ms`);
      await sleep(retryAfterMs + 250);
      continue;
    }

    return { status: res.status, body, setCookie: res.headers.get('set-cookie') ?? undefined };
  }
}

function extractCookiePair(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]; // "token=<jwt>" — only the name=value pair belongs in a Cookie request header
}

interface Session {
  handle: string;
  cookie: string;
}

// Registers a fresh bot, or logs in if one with this handle already exists from a prior
// un-cleaned run — makes the simulator resumable without requiring `npm run reset-demo` (or
// `--cleanup`) before every single invocation. Register already sets the session cookie
// (verified: api/src/routes/auth.ts's issueAuthCookie runs on both register and login), so
// this is exactly one auth HTTP request per bot in the common case.
async function registerOrLoginBot(prefix: string, password: string, i: number): Promise<Session> {
  const handle = botHandle(prefix, i);
  const email = `${handle}@codearena.dev`;

  let res = await apiRequest('POST', '/api/auth/register', { body: { handle, email, password } });
  if (res.status === 201 && res.setCookie) {
    return { handle, cookie: extractCookiePair(res.setCookie) };
  }
  if (res.status === 409) {
    res = await apiRequest('POST', '/api/auth/login', { body: { handle, password } });
    if (res.status === 200 && res.setCookie) {
      return { handle, cookie: extractCookiePair(res.setCookie) };
    }
  }
  throw new Error(`failed to register/login bot ${handle}: ${res.status} ${JSON.stringify(res.body)}`);
}

async function createBots(prefix: string, password: string, count: number): Promise<Session[]> {
  const sessions: Session[] = [];
  for (let i = 1; i <= count; i++) {
    const session = await registerOrLoginBot(prefix, password, i);
    sessions.push(session);
    console.log(`  bot ready: ${session.handle}`);
    await sleep(300 + Math.random() * 500); // small jitter — good citizenship, not required by rl:auth at this volume
  }
  return sessions;
}

type SolutionKind = 'ac' | 'wa' | 'tle';
type SolutionSet = Partial<Record<SolutionKind, string>>;

function loadSolutions(slugs: string[]): Record<string, SolutionSet> {
  const out: Record<string, SolutionSet> = {};
  for (const slug of slugs) {
    const set: SolutionSet = {};
    for (const kind of ['ac', 'wa', 'tle'] as const) {
      const path = join(SOLUTIONS_DIR, `${slug}.${kind}.cpp`);
      if (existsSync(path)) set[kind] = readFileSync(path, 'utf8');
    }
    if (!set.ac) console.log(`  [warn] no AC solution for "${slug}" in scripts/solutions/ — bots will skip it`);
    out[slug] = set;
  }
  return out;
}

// Same three kinds, but keyed/discovered by problemId — scripts/solutions/<problemId>/{ac,wa,tle}/
// solution.cpp — used by --load, which learns problem ids from the live contest itself (see
// fetchContestProblems) rather than from a hardcoded slug list.
function loadSolutionsByProblemId(problems: { _id: string; slug: string }[]): Record<string, SolutionSet> {
  const out: Record<string, SolutionSet> = {};
  for (const problem of problems) {
    const set: SolutionSet = {};
    for (const kind of ['ac', 'wa', 'tle'] as const) {
      const path = join(SOLUTIONS_DIR, problem._id, kind, 'solution.cpp');
      if (existsSync(path)) set[kind] = readFileSync(path, 'utf8');
    }
    if (!set.ac) console.log(`  [warn] no AC solution for "${problem.slug}" (${problem._id}) in scripts/solutions/ — bots will skip it`);
    out[problem.slug] = set;
  }
  return out;
}

// Skill profile per bot, cycled across BOT_COUNT bots — gives the leaderboard a believable
// spread (fast clean solves, steady-with-one-slip, grinders, a rookie stuck on problem A)
// instead of every bot behaving identically. Returns the sequence of submission kinds to send
// for one problem, in order; an empty array means this bot never attempts that problem.
type Profile = 'ace' | 'steady' | 'grinder' | 'rookie';
const PROFILE_CYCLE: Profile[] = ['ace', 'steady', 'grinder', 'rookie'];

function planForProblem(profile: Profile, problemIndex: number): SolutionKind[] {
  switch (profile) {
    case 'ace':
      return ['ac'];
    case 'steady':
      return problemIndex < 2 ? ['wa', 'ac'] : ['wa'];
    case 'grinder':
      if (problemIndex === 0) return ['wa', 'wa', 'ac'];
      if (problemIndex === 1) return ['tle', 'wa'];
      return [];
    case 'rookie':
      return problemIndex === 0 ? ['wa', 'wa'] : [];
  }
}

async function submitAndWait(session: Session, problemSlug: string, code: string, contestId: string): Promise<void> {
  const res = await apiRequest('POST', '/api/submissions', {
    cookie: session.cookie,
    body: { problemSlug, language: 'cpp', code, contestId },
  });
  if (res.status !== 202) {
    console.log(`  [warn] ${session.handle} · ${problemSlug} · submit failed: ${res.status} ${JSON.stringify(res.body)}`);
    return;
  }
  const submissionId = res.body.id as string;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const poll = await apiRequest('GET', `/api/submissions/${submissionId}`, { cookie: session.cookie });
    const status: string | undefined = poll.body?.status;
    if (status && status !== 'queued' && status !== 'running') {
      console.log(`  ${session.handle} · ${problemSlug} · ${status}`);
      return;
    }
  }
  console.log(`  [warn] ${session.handle} · ${problemSlug} · timed out waiting for a terminal verdict`);
}

async function runBotSchedule(
  session: Session,
  profile: Profile,
  problems: { slug: string }[],
  solutions: Record<string, SolutionSet>,
  contestId: string,
  semaphore: Semaphore,
): Promise<void> {
  for (let i = 0; i < problems.length; i++) {
    const slug = problems[i].slug;
    const set = solutions[slug];
    for (const kind of planForProblem(profile, i)) {
      const code = set[kind];
      if (!code) continue;
      const release = await semaphore.acquire();
      try {
        await submitAndWait(session, slug, code, contestId);
      } finally {
        release();
      }
      // rl:sub:{userId} allows 1 submission / 10s / user (api/src/config/rateLimits.ts) —
      // apiRequest already retries on an actual 429, but pacing proactively avoids tripping it
      // in the first place, which reads better in a live demo than visible rate-limit stalls.
      await sleep(11_000 + Math.random() * 4000);
    }
  }
  console.log(`  ${session.handle} (${profile}) finished its schedule`);
}

async function cleanup(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
  // Matches both contest-mode bots ("bot0001") and --load's own bots ("load0001") — one
  // cleanup call removes everything this script has ever created.
  //
  // Anchored + exact 4-digit format (matches botHandle()'s zero-padding above) - NOT a bare
  // prefix match. Found via a live-DB audit (BUGLOG.md, 2026-07-19): the previous unanchored
  // `^(bot|load)` regex matched 60 pre-existing "bot01".."bot60" accounts (2-digit, no leading
  // zeros - left over from before this script's current zero-padding convention), which
  // `--cleanup` would have deleted along with their submissions. Staged here for review, not
  // committed automatically - re-verify against the live DB's actual handle set before trusting
  // this in production again.
  const bots = await User.find({ handle: { $regex: `^(${BOT_HANDLE_PREFIX}|${LOAD_HANDLE_PREFIX})\\d{4}$` } })
    .select('_id handle')
    .lean();
  const botIds = bots.map((b) => b._id);
  const { deletedCount: submissionsDeleted } = await Submission.deleteMany({ userId: { $in: botIds } });
  const { deletedCount: usersDeleted } = await User.deleteMany({ _id: { $in: botIds } });
  console.log(`cleanup: removed ${usersDeleted} bot users, ${submissionsDeleted} of their submissions`);
  await mongoose.disconnect();
}

function pickWeightedKind(): SolutionKind {
  // ~70% AC / 20% WA / 10% TLE — a plausible real-contest submission mix, not uniform random.
  const r = Math.random();
  if (r < 0.7) return 'ac';
  if (r < 0.9) return 'wa';
  return 'tle';
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

// --- Load-test bot sessions: read from scripts/bot-tokens.json (written by scripts/seed-bots.ts)
// instead of registering a fresh throwaway set — --load reuses the same 15 accounts every run so
// results aren't confounded by fresh-account effects, and so the accounts persist for repeat runs. ---
interface BotToken {
  handle: string;
  email: string;
  userId: string;
  token: string;
}

interface LoadSession extends Session {
  userId: string;
  token: string; // raw JWT — needed as-is for the Socket.io handshake's Cookie header (socket.io-client has no cookie jar)
}

function loadBotSessions(): LoadSession[] {
  if (!existsSync(BOT_TOKENS_PATH)) {
    throw new Error(`${BOT_TOKENS_PATH} not found — run "npx tsx scripts/seed-bots.ts" first`);
  }
  const tokens: BotToken[] = JSON.parse(readFileSync(BOT_TOKENS_PATH, 'utf8'));
  return tokens.map((t) => ({ handle: t.handle, userId: t.userId, token: t.token, cookie: `token=${t.token}` }));
}

interface ContestSummary {
  _id: string;
  slug: string;
  startAt: string;
  endAt: string;
}

async function resolveContestBySlug(slug: string): Promise<ContestSummary> {
  const res = await apiRequest('GET', '/api/contests');
  const match = (res.body?.contests as ContestSummary[] | undefined)?.find((c) => c.slug === slug);
  if (!match) {
    throw new Error(`contest "${slug}" not found via GET /api/contests — pass --contest=<slug> for a contest that exists`);
  }
  return match;
}

// Registration closes the instant a contest starts (contestsRouter's /:id/register — see
// api/src/routes/contests.ts), so this must run — and succeed for every bot — before startAt.
// $addToSet-backed on the server, so safe to call again for a bot that's already registered.
async function registerBotsForContest(sessions: LoadSession[], contestId: string): Promise<void> {
  for (const session of sessions) {
    const res = await apiRequest('POST', `/api/contests/${contestId}/register`, { cookie: session.cookie });
    if (res.status !== 200 && res.status !== 204) {
      console.log(`  [warn] ${session.handle} failed to register: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
}

interface ContestProblem {
  _id: string;
  slug: string;
}

// Only readable once the contest is in its 'running' phase (contestsRouter's GET /:id gates
// problem details on phase + registration — see api/src/routes/contests.ts) — contest problems
// stay isPublished:false until finalization, so this is the only way to learn their real ids.
async function fetchContestProblems(session: LoadSession, contestId: string): Promise<ContestProblem[]> {
  const res = await apiRequest('GET', `/api/contests/${contestId}`, { cookie: session.cookie });
  if (res.status !== 200) {
    throw new Error(`GET /api/contests/${contestId} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const problems = res.body?.problems as ContestProblem[] | undefined;
  if (!problems || problems.length === 0) {
    throw new Error(`contest ${contestId} has no visible problems yet — is it actually running and is this bot registered?`);
  }
  return problems.map((p) => ({ _id: p._id, slug: p.slug }));
}

// --- Judge-latency measurement via Socket.io, per DEPLOY.md's constraint that GET /metrics is
// unreachable through the public domain in production. One socket per bot (verdicts are routed
// to the `user:{userId}` room the server auto-joins on connect — see api/src/socket/index.ts —
// so no client-side room join is needed, unlike contest:join for leaderboard updates). A shared
// map keyed by submissionId lets any bot's socket resolve the pending wait for that submission. ---
interface PendingVerdict {
  enqueueTs: number;
  settle: (result: { verdict: string; latencyMs: number }) => void;
}
const pendingBySubmissionId = new Map<string, PendingVerdict>();

function connectBotSocket(session: LoadSession): Socket {
  const socket = ioClient(BASE_URL, {
    extraHeaders: { Cookie: `token=${session.token}` },
    reconnection: true,
    transports: ['websocket', 'polling'],
  });
  socket.on('verdict', (payload: { submissionId: string; verdict: string }) => {
    const pending = pendingBySubmissionId.get(payload.submissionId);
    if (pending) {
      pendingBySubmissionId.delete(payload.submissionId);
      pending.settle({ verdict: payload.verdict, latencyMs: Date.now() - pending.enqueueTs });
    }
  });
  socket.on('connect_error', (err) => console.log(`  [warn] ${session.handle} socket connect_error: ${err.message}`));
  return socket;
}

// PREVIOUSLY this gave up after 90s and let fireOne's `finally` free the bot's in-flight slot —
// which sounds safe but isn't: the real BullMQ job doesn't vanish when we stop watching it, so
// the bot would fire a brand-new submission into the "freed" slot while the old one was still
// genuinely outstanding server-side. Confirmed for real: a 5-minute run at nominal 45 applied
// concurrency fired 180 distinct submissions (32 completed + 148 timed out here), and peak queue
// depth hit 90 — both impossible if in-flight were actually bounded at 45. Verified separately
// that this was NOT server-side job duplication (every BullMQ job's `data.submissionId` was
// checked for uniqueness across a large sample — zero duplicates, zero jobs with
// attemptsMade > 1 — each fired submission really was a distinct, once-processed job). So the
// fix is here, not in the queue: a slot must only free on a REAL terminal verdict, never on
// giving up. VERDICT_SAFETY_NET_MS is not a "normal" timeout — it should never trip under
// ordinary saturation (a 90-job backlog fully drained in under 6 minutes in testing); it exists
// only to eventually surface something being truly broken (e.g. the worker process itself dead).
const VERDICT_SAFETY_NET_MS = Number(process.env.VERDICT_SAFETY_NET_MS) || 20 * 60_000;

let verdictsViaSocket = 0;
let verdictsViaPoll = 0;

// Races the Socket.io verdict event against a REST poll fallback so a dropped WS message never
// permanently loses a completion — but does NOT give up and free the caller's in-flight slot
// short of VERDICT_SAFETY_NET_MS (see the comment above for why that matters). Both paths measure
// latency from the same enqueueTs (recorded right after POST returns 202, i.e. as close to "the
// job was enqueued" as an external client can observe). Tracks which path actually resolved each
// submission (verdictsViaSocket/verdictsViaPoll) so a run can report whether Socket.io delivery
// was reliable or whether most completions were only ever observed via the poll fallback.
async function waitForVerdict(
  session: LoadSession,
  submissionId: string,
  enqueueTs: number,
): Promise<{ verdict: string; latencyMs: number } | null> {
  let settled = false;
  const viaSocket = new Promise<{ verdict: string; latencyMs: number }>((resolve) => {
    pendingBySubmissionId.set(submissionId, {
      enqueueTs,
      settle: (result) => {
        settled = true;
        verdictsViaSocket += 1;
        resolve(result);
      },
    });
  });
  const viaPoll = (async (): Promise<{ verdict: string; latencyMs: number } | null> => {
    const deadline = Date.now() + VERDICT_SAFETY_NET_MS;
    while (Date.now() < deadline && !settled) {
      await sleep(1000);
      if (settled) break;
      const poll = await apiRequest('GET', `/api/submissions/${submissionId}`, { cookie: session.cookie });
      const status: string | undefined = poll.body?.status;
      if (status && status !== 'queued' && status !== 'running') {
        settled = true;
        verdictsViaPoll += 1;
        return { verdict: status, latencyMs: Date.now() - enqueueTs };
      }
    }
    return null;
  })();
  const result = await Promise.race([viaSocket, viaPoll]);
  pendingBySubmissionId.delete(submissionId);
  return result;
}

// --- Queue-depth probe: talks to BullMQ directly over REDIS_TUNNEL_URL, same queue name/prefix
// as api/src/queue.ts's submissionsQueue, rather than going through GET /metrics (unreachable
// through the public domain in production — see DEPLOY.md). ---
function openQueueDepthProbe(): Queue {
  return new Queue('submissions', { connection: { url: REDIS_TUNNEL_URL }, prefix: 'queue' });
}

async function currentQueueDepth(probe: Queue): Promise<number> {
  const counts = await probe.getJobCounts('waiting', 'active');
  return (counts.waiting ?? 0) + (counts.active ?? 0);
}

// rl:sub allows 1 submission / 10s / user (api/src/config/rateLimits.ts) — a hard server-enforced
// floor, not a choice. Margin history: 200ms measured 6 real 429s in a 5-minute run; widening to
// 1s (plus fixing warm-up's own pacing) cut it to 2 — the residual pair traced to a network-error
// retry inside apiRequest, whose fixed 2s backoff isn't floor-aware (it doesn't know the calling
// bot's lastSubmitAt), so a retry can still land too close to that bot's prior submission on this
// VM's jitter. Widened again to 2s margin rather than reworking retry-floor coupling: the goal is
// a clean (zero-429) run, not maximally tight pacing — judge-worker CPU is the real bottleneck
// (see the throughput-ceiling comments elsewhere), so slower submission pacing changes nothing
// about what this test is actually measuring.
const SUBMIT_RATE_FLOOR_MS = 12_000;

interface LoadRunContext {
  sessions: LoadSession[];
  problems: ContestProblem[];
  solutions: Record<string, SolutionSet>;
  contestId: string;
  sockets: Socket[];
}

// Shared setup for both --load and --ramp: resolve the contest, load bot sessions from
// bot-tokens.json, register them (must happen before startAt), discover the contest's real
// problems once running, load their solutions, and bring up one Socket.io connection per bot.
async function prepareLoadRun(requiredMinutes: number): Promise<LoadRunContext> {
  console.log(`resolving contest "${CONTEST_SLUG}" via ${BASE_URL}...`);
  const contestSummary = await resolveContestBySlug(CONTEST_SLUG);
  const contestId = contestSummary._id;
  const startAt = new Date(contestSummary.startAt);
  const endAt = new Date(contestSummary.endAt);
  console.log(`  contest ${contestId}: startAt=${startAt.toISOString()} endAt=${endAt.toISOString()}`);

  const sessions = loadBotSessions();
  console.log(`loaded ${sessions.length} bot sessions from ${BOT_TOKENS_PATH}`);

  if (Date.now() < startAt.getTime()) {
    console.log(`registering ${sessions.length} bots for contest ${contestId} (must happen before startAt)...`);
    await registerBotsForContest(sessions, contestId);
    const waitMs = startAt.getTime() - Date.now() + 2000; // +2s margin past the exact boundary
    if (waitMs > 0) {
      console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the contest to start...`);
      await sleep(waitMs);
    }
  } else if (Date.now() > endAt.getTime()) {
    throw new Error(`contest ${contestId} already ended at ${endAt.toISOString()} — nothing to load-test`);
  } else {
    // Already running: registration may or may not have happened yet (e.g. re-running this
    // script after an earlier partial run). Try anyway — CONTEST_ALREADY_STARTED for an
    // already-registered bot is a harmless no-op from this script's point of view; a bot that
    // truly never made it in just won't be able to submit and gets skipped below.
    console.log(`contest ${contestId} is already running — attempting registration anyway (idempotent if already done)...`);
    await registerBotsForContest(sessions, contestId);
  }

  const remainingMinutes = (endAt.getTime() - Date.now()) / 60_000;
  if (remainingMinutes < requiredMinutes) {
    throw new Error(
      `contest ${contestId} only has ${remainingMinutes.toFixed(1)} minutes left — need at least ` +
        `${requiredMinutes.toFixed(1)} for this run`,
    );
  }

  const problems = await fetchContestProblems(sessions[0], contestId);
  console.log(`contest problems: ${problems.map((p) => `${p.slug} (${p._id})`).join(', ')}`);
  const solutions = loadSolutionsByProblemId(problems);

  const sockets = sessions.map(connectBotSocket);
  await Promise.all(
    sockets.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.connected) resolve();
          else s.once('connect', () => resolve());
          setTimeout(resolve, 5000); // don't block forever on one slow/failed handshake — waitForVerdict's REST poll covers it
        }),
    ),
  );
  console.log(`${sockets.filter((s) => s.connected).length}/${sockets.length} bot sockets connected`);

  return { sessions, problems, solutions, contestId, sockets };
}

// --- Warm-up: a few real AC submissions against these same problems before any timed window,
// so Docker/compile-layer caches are hot before measurement starts (not counted in any stat). ---
async function runWarmup(
  warmupBot: LoadSession,
  problems: ContestProblem[],
  solutions: Record<string, SolutionSet>,
  contestId: string,
): Promise<void> {
  console.log(`\n=== warm-up (${LOAD_WARMUP_COUNT} submissions) ===`);
  let lastSubmitAt = 0;
  for (let i = 0; i < LOAD_WARMUP_COUNT; i++) {
    const problem = problems[i % problems.length];
    const code = solutions[problem.slug]?.ac;
    if (!code) {
      console.log(`  [warn] no AC solution for warm-up problem "${problem.slug}" — skipping`);
      continue;
    }
    // Same rl:sub floor as the load generator itself — this bot is about to be reused as the
    // load window's first bot, so under-pacing here just relocates the 429 to the window's own
    // opening submissions instead of eliminating it.
    const waitMs = SUBMIT_RATE_FLOOR_MS - (Date.now() - lastSubmitAt);
    if (waitMs > 0) await sleep(waitMs);
    lastSubmitAt = Date.now();

    const res = await apiRequest('POST', '/api/submissions', {
      cookie: warmupBot.cookie,
      body: { problemSlug: problem.slug, language: 'cpp', code, contestId },
    });
    if (res.status !== 202) {
      console.log(`  [warn] warm-up submit failed: ${res.status} ${JSON.stringify(res.body)}`);
      continue;
    }
    const result = await waitForVerdict(warmupBot, res.body.id as string, Date.now());
    console.log(`  warm-up ${i + 1}/${LOAD_WARMUP_COUNT}: ${problem.slug} · ${result?.verdict ?? 'timed out'}`);
  }
  // The warm-up bot is reused as the load window's sessions[0] — without this, the window's
  // very first fire for that bot can land inside the warm-up's own rl:sub history (confirmed for
  // real: 3 of a run's 429s all clustered in its opening ~25s) even though this script's own
  // client-side pacing looks correct, because a fresh botScheduler's lastSubmitAt starts at 0
  // with no memory of what this same bot just did seconds earlier as the warm-up bot.
  const coolDownMs = SUBMIT_RATE_FLOOR_MS - (Date.now() - lastSubmitAt);
  if (coolDownMs > 0) await sleep(coolDownMs);
}

interface SubmitSample {
  ts: number;
  latencyMs: number;
}

interface LoadWindowResult {
  label: string;
  botCount: number;
  maxInFlightPerBot: number;
  appliedConcurrency: number;
  durationMs: number;
  effectiveWindowMs: number; // durationMs, extended to cover every fired submission's resolution — see throughputPerMin's comment
  completedCount: number;
  throughputPerMin: number;
  peakQueueDepth: number | null; // null if the redis tunnel never produced a single successful read during the window
  queueDepthAtWindowEnd: number | null; // snapshot taken the instant submitting stopped, BEFORE any drain-wait
  judgeP50Ms: number | null;
  judgeP95Ms: number | null;
  submitP95Ms: number | null;
  submitMeanMs: number | null;
  submitP95FirstMinuteMs: number | null;
  submitP95LastMinuteMs: number | null;
  maxGlobalInFlight: number;
  rateLimitHits: number;
  verdictsViaSocket: number; // resolved by a live Socket.io 'verdict' event during this window
  verdictsViaPoll: number; // resolved only by the REST poll fallback — a dropped/missed socket event
  drainTimeSeconds: number | null;
  drainedWithinDeadline: boolean;
}

// The core load generator, reused by both the fixed 15-bot/3-in-flight official run (--load) and
// each escalating stage of --ramp. Each bot independently keeps up to `maxInFlightPerBot`
// submissions pending at once — fired without awaiting their verdict first (true concurrency,
// not a global semaphore serializing everything down to one queue depth) — paced only by
// SUBMIT_RATE_FLOOR_MS, the server's own rate-limit floor, never awaiting a slot to free up
// before checking whether the submission window has ended.
async function runLoadWindow(opts: {
  label: string;
  sessions: LoadSession[];
  problems: ContestProblem[];
  solutions: Record<string, SolutionSet>;
  contestId: string;
  durationMs: number;
  maxInFlightPerBot: number;
  queueProbe: Queue;
  waitForDrain: boolean;
  drainDeadlineMs?: number;
}): Promise<LoadWindowResult> {
  const { label, sessions, problems, solutions, contestId, durationMs, maxInFlightPerBot, queueProbe } = opts;
  console.log(
    `\n=== ${label}: ${sessions.length} bots × ${maxInFlightPerBot} max in-flight each ` +
      `(applied concurrency ${sessions.length * maxInFlightPerBot}), ${(durationMs / 60_000).toFixed(1)} min ===`,
  );

  const rateLimitHitsBefore = total429Count;
  const verdictsViaSocketBefore = verdictsViaSocket;
  const verdictsViaPollBefore = verdictsViaPoll;
  const submitSamples: SubmitSample[] = [];
  const judgeLatenciesMs: number[] = [];
  const firedSubmissionIds: string[] = []; // every real Mongo id this window created — dumped to disk for forensic cross-checks against BullMQ/Mongo
  let completedCount = 0;

  let peakQueueDepth = 0;
  let lastQueueDepth = 0;
  let queueDepthEverRead = false; // distinguishes "genuinely 0" from "never got a successful read" (e.g. tunnel down the whole window)
  let keepPollingQueue = true;
  const queueDepthPoller = (async () => {
    let consecutiveFailures = 0;
    while (keepPollingQueue) {
      try {
        lastQueueDepth = await currentQueueDepth(queueProbe);
        queueDepthEverRead = true;
        if (lastQueueDepth > peakQueueDepth) peakQueueDepth = lastQueueDepth;
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        // Back off on sustained failure (e.g. the redis tunnel dropping for minutes) instead of
        // logging every 1s — this genuinely happened during development and flooded the log with
        // thousands of identical ECONNREFUSED lines without adding any information.
        if (consecutiveFailures <= 3 || consecutiveFailures % 30 === 0) {
          console.log(
            `  [warn] queue depth poll failed (${consecutiveFailures} consecutive): ${err instanceof Error ? err.message : err}`,
          );
        }
        await sleep(Math.min(1000 * consecutiveFailures, 15_000));
        continue;
      }
      await sleep(1000); // poll BullMQ waiting+active every 1s
    }
  })();

  const windowStart = Date.now();
  const stopAt = windowStart + durationMs;

  const pendingByBot = new Map<string, Set<string>>(sessions.map((s) => [s.handle, new Set<string>()]));
  const globalInFlight = () => sessions.reduce((sum, s) => sum + pendingByBot.get(s.handle)!.size, 0);
  let maxGlobalInFlight = 0;

  let keepStatusLogging = true;
  const statusLogger = (async () => {
    while (keepStatusLogging) {
      await sleep(5000);
      if (!keepStatusLogging) break;
      const parts = sessions.map((s) => `${s.handle}=${pendingByBot.get(s.handle)!.size}`);
      console.log(`  [in-flight t+${((Date.now() - windowStart) / 1000).toFixed(0)}s] global=${globalInFlight()} (${parts.join(', ')})`);
    }
  })();

  const inFlightPromises: Promise<void>[] = [];

  // Fired without being awaited by the scheduler below — that's what makes this "fire-and-track"
  // rather than "await-verdict-before-next". The pending-set add/delete brackets the ENTIRE
  // submit+wait-for-verdict cycle so pendingByBot always reflects true in-flight count, not just
  // "POST sent".
  async function fireOne(session: LoadSession): Promise<void> {
    const problem = problems[Math.floor(Math.random() * problems.length)];
    const kind = pickWeightedKind();
    const code = solutions[problem.slug]?.[kind];
    if (!code) return;

    const pending = pendingByBot.get(session.handle)!;
    const marker = `${Date.now()}-${Math.random()}`;
    pending.add(marker);
    if (globalInFlight() > maxGlobalInFlight) maxGlobalInFlight = globalInFlight();

    try {
      const submitStart = Date.now();
      // A fixed Idempotency-Key generated ONCE per logical attempt (reused across apiRequest's
      // own internal network-error retries) — without this, a POST that actually succeeded
      // server-side but whose response the client failed to receive (a real event during this
      // VM's flaky stretches) gets silently resubmitted as a brand-new submission on retry,
      // inflating both the measured submission count and rl:sub's rate-limit spend. The server's
      // idempotencyShortCircuit (api/src/routes/submissions.ts) coalesces same-key retries into
      // the original submission's id instead of creating a duplicate.
      const idempotencyKey = randomUUID();
      const res = await apiRequest('POST', '/api/submissions', {
        cookie: session.cookie,
        body: { problemSlug: problem.slug, language: 'cpp', code, contestId },
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      submitSamples.push({ ts: Date.now(), latencyMs: Date.now() - submitStart });

      if (res.status === 202) {
        const submissionId = res.body.id as string;
        firedSubmissionIds.push(submissionId);
        const enqueueTs = Date.now(); // as close to "job enqueued" as an external client can observe
        const result = await waitForVerdict(session, submissionId, enqueueTs);
        if (result) {
          judgeLatenciesMs.push(result.latencyMs);
          completedCount += 1;
        } else {
          console.log(
            `  [warn] ${session.handle} · ${problem.slug} · no verdict within the ${(VERDICT_SAFETY_NET_MS / 60_000).toFixed(0)}-minute safety net — something is likely actually broken`,
          );
        }
      } else if (res.status !== 429) {
        console.log(`  [warn] ${session.handle} · ${problem.slug} · submit failed: ${res.status}`);
      }
    } finally {
      pending.delete(marker);
    }
  }

  // Per bot: fire a new submission the instant a slot is free AND the rate-limit floor has
  // elapsed since this bot's own last submission — whichever constraint binds. Never awaits
  // fireOne() itself, so up to maxInFlightPerBot submissions run concurrently per bot.
  async function botScheduler(session: LoadSession): Promise<void> {
    const pending = pendingByBot.get(session.handle)!;
    let lastSubmitAt = 0;
    while (Date.now() < stopAt) {
      if (pending.size < maxInFlightPerBot && Date.now() - lastSubmitAt >= SUBMIT_RATE_FLOOR_MS) {
        lastSubmitAt = Date.now();
        inFlightPromises.push(fireOne(session));
        continue; // immediately re-check whether another slot can be filled
      }
      await sleep(200);
    }
  }

  await Promise.all(sessions.map(botScheduler));
  const loadStoppedAt = Date.now();
  const queueDepthAtWindowEnd = queueDepthEverRead ? lastQueueDepth : null; // pre-drain snapshot — the actual saturation signal

  keepStatusLogging = false;
  await statusLogger;

  // Let every fired submission genuinely resolve before computing stats — no early give-up (see
  // VERDICT_SAFETY_NET_MS's comment on why an earlier version of this script made that mistake).
  // This is bookkeeping only, not the drain signal; the real drain-wait below polls actual queue
  // depth, which is the authoritative "is the backlog actually gone" answer.
  await Promise.allSettled(inFlightPromises);
  // Throughput's true denominator: with judge latencies that can exceed a short stage's own
  // nominal duration (seen for real — 45-90s judge latency against ramp stages as short as 50s),
  // most completions land during THIS tail-wait, well after durationMs elapsed. Dividing
  // completedCount by durationMs alone would then report a rate several times higher than what
  // actually happened — confirmed by comparing an early version of the ramp test's short stages
  // against the official 5-minute run at the same applied concurrency: nominal-duration division
  // gave ~43/min at 45-concurrency in a 50s stage vs. ~7/min for the same concurrency sustained
  // over 5 minutes, a 6x discrepancy from denominator choice alone, not a real difference in
  // system behavior. Use the actual elapsed span from window start to every fired submission
  // having resolved, floored at durationMs (never shorter than the nominal window).
  const effectiveWindowMs = Math.max(durationMs, Date.now() - windowStart);

  let drainTimeSeconds: number | null = null;
  let drainedWithinDeadline = false;
  if (opts.waitForDrain) {
    console.log(`  ${label}: submission window complete — waiting for the queue to drain...`);
    const drainDeadlineMs = opts.drainDeadlineMs ?? 180_000;
    const drainWaitStart = Date.now();
    while (Date.now() - drainWaitStart < drainDeadlineMs) {
      if (lastQueueDepth === 0) {
        drainedWithinDeadline = true;
        break;
      }
      await sleep(500);
    }
    drainTimeSeconds = (Date.now() - loadStoppedAt) / 1000;
  }

  keepPollingQueue = false;
  await queueDepthPoller;

  const allLatencies = submitSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const submitP95 = percentile(allLatencies, 0.95);
  const submitMean = allLatencies.length > 0 ? Math.round(allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length) : null;

  const firstMinute = submitSamples
    .filter((s) => s.ts < windowStart + 60_000)
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);
  const lastMinute = submitSamples
    .filter((s) => s.ts >= loadStoppedAt - 60_000)
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);

  judgeLatenciesMs.sort((a, b) => a - b);

  // Forensic dump: every real Mongo submission id this window created, plus its exact time span
  // — lets a post-run check cross-reference against BullMQ (getJobs) and Redis's
  // metrics:judge:* / verdict counters for the SAME window, independent of anything this script
  // itself tracked in memory. Overwritten each window, not appended — read it immediately after
  // a run if you need it.
  const forensicPath = join(__dirname, '../../../scripts/last-run-submission-ids.json');
  writeFileSync(
    forensicPath,
    JSON.stringify({ label, windowStart, loadStoppedAt, submissionIds: firedSubmissionIds }, null, 2),
  );

  return {
    label,
    botCount: sessions.length,
    maxInFlightPerBot,
    appliedConcurrency: sessions.length * maxInFlightPerBot,
    durationMs,
    effectiveWindowMs,
    completedCount,
    throughputPerMin: completedCount / (effectiveWindowMs / 60_000),
    peakQueueDepth: queueDepthEverRead ? peakQueueDepth : null,
    queueDepthAtWindowEnd,
    judgeP50Ms: percentile(judgeLatenciesMs, 0.5),
    judgeP95Ms: percentile(judgeLatenciesMs, 0.95),
    submitP95Ms: submitP95,
    submitMeanMs: submitMean,
    submitP95FirstMinuteMs: percentile(firstMinute, 0.95),
    submitP95LastMinuteMs: percentile(lastMinute, 0.95),
    maxGlobalInFlight,
    rateLimitHits: total429Count - rateLimitHitsBefore,
    verdictsViaSocket: verdictsViaSocket - verdictsViaSocketBefore,
    verdictsViaPoll: verdictsViaPoll - verdictsViaPollBefore,
    drainTimeSeconds,
    drainedWithinDeadline,
  };
}

function printWindowSummary(r: LoadWindowResult): void {
  console.log(`\n=== ${r.label}: summary ===`);
  console.log(
    `Test conditions: ${r.botCount} bots × ${r.maxInFlightPerBot} max in-flight each (applied concurrency ` +
      `${r.appliedConcurrency}), ${(r.durationMs / 60_000).toFixed(1)}-minute window, ~70% AC / 20% WA / 10% TLE mix. ` +
      `${r.completedCount} verdicts observed.`,
  );
  console.log('Metric                                          | Measured');
  if (r.effectiveWindowMs > r.durationMs + 1000) {
    console.log(
      `  (throughput measured over ${(r.effectiveWindowMs / 1000).toFixed(0)}s, not the nominal ${(r.durationMs / 1000).toFixed(0)}s — ` +
        `judge latency exceeded the stage's own duration, so completions kept landing after submitting stopped)`,
    );
  }
  console.log(`Sustained judge throughput (verdicts/min)       | ${r.throughputPerMin.toFixed(1)}`);
  console.log(`Peak queue depth (jobs)                         | ${r.peakQueueDepth ?? 'n/a (redis tunnel unavailable)'}`);
  console.log(`Queue depth at window end, pre-drain (jobs)     | ${r.queueDepthAtWindowEnd ?? 'n/a (redis tunnel unavailable)'}`);
  console.log(`Max global in-flight (all bots)                 | ${r.maxGlobalInFlight}`);
  console.log(`Judge latency p95, enqueue→verdict (s)          | ${r.judgeP95Ms != null ? (r.judgeP95Ms / 1000).toFixed(1) : 'n/a'}`);
  console.log(`Judge latency p50, enqueue→verdict (s)          | ${r.judgeP50Ms != null ? (r.judgeP50Ms / 1000).toFixed(1) : 'n/a'}`);
  console.log(`POST /api/submissions p95 (ms)                  | ${r.submitP95Ms ?? 'n/a'}`);
  console.log(`Mean POST /api/submissions latency (ms)         | ${r.submitMeanMs ?? 'n/a'}`);
  console.log(`POST p95, first minute of window (ms)           | ${r.submitP95FirstMinuteMs ?? 'n/a'}`);
  console.log(`POST p95, last minute of window (ms)             | ${r.submitP95LastMinuteMs ?? 'n/a'}`);
  console.log(
    `Queue drain time after load stopped (s)         | ${
      r.drainTimeSeconds == null
        ? 'n/a (not waited)'
        : r.drainedWithinDeadline
          ? r.drainTimeSeconds.toFixed(1)
          : `>${r.drainTimeSeconds.toFixed(0)} (timed out)`
    }`,
  );
  console.log(`Rate-limit (429) hits during window              | ${r.rateLimitHits}`);
  console.log(`Verdicts resolved via Socket.io / poll fallback   | ${r.verdictsViaSocket} / ${r.verdictsViaPoll}`);
}

// --- Bot pool assignment: scripts/bot-tokens.json holds a pool (bot01..botN, in registration
// order). Rather than let --load and --ramp reuse the same bots (which would contaminate each
// other's rl:sub 30-submissions/hour/user sliding window — see the file-level comment on
// SUBMIT_RATE_FLOOR_MS's sibling constraint), each phase gets a disjoint slice: bot01-15 stay
// idle/reserved (already partially used by ad-hoc verification earlier in a session), bot16-30
// (15) are official --load's dedicated pool, and bot31-45 (15) are --ramp's — reused across ALL
// 5 stages (rl:auth's own 10-attempts/15min/IP cap makes registering enough bots for fully
// disjoint ramp stages impractically slow — see the ramp comment below for why reuse is safe here).
const OFFICIAL_BOT_OFFSET = Number(process.env.OFFICIAL_BOT_OFFSET) || 15;
const OFFICIAL_BOT_COUNT = 15;
// Independently overridable (not just derived from OFFICIAL_BOT_OFFSET/COUNT) so a ramp pool
// that's accumulated rl:sub usage from a prior run today can be swapped for a fresh, never-used
// range (e.g. RAMP_BOT_OFFSET=45 to use bot46-60) without touching --load's own pool.
const RAMP_BOT_OFFSET = Number(process.env.RAMP_BOT_OFFSET) || OFFICIAL_BOT_OFFSET + OFFICIAL_BOT_COUNT; // 30
const RAMP_BOT_COUNT = 15;

// Acceptance/load test — NOT a demo feature (see file header). Measures exactly the metrics
// README.md's "Measured performance" table expects, so filling that table in is copy-paste from
// this script's own summary output. Submits WITH contestId against a real, running, admin-created
// contest (--contest=<slug>) — the bots must already be (or must still be able to become)
// registered before that contest's startAt. Each of its 15 bots keeps up to
// LOAD_MAX_INFLIGHT_PER_BOT submissions truly concurrent (see runLoadWindow) — applied
// concurrency is bots × in-flight-per-bot, not a single global cap.
async function runOfficialLoadTest(): Promise<void> {
  const requiredMinutes = LOAD_DURATION_MINUTES + 5; // window + warm-up + drain buffer
  const ctx = await prepareLoadRun(requiredMinutes);
  const officialSessions = ctx.sessions.slice(OFFICIAL_BOT_OFFSET, OFFICIAL_BOT_OFFSET + OFFICIAL_BOT_COUNT);
  if (officialSessions.length < OFFICIAL_BOT_COUNT) {
    throw new Error(
      `--load needs ${OFFICIAL_BOT_COUNT} bots at offset ${OFFICIAL_BOT_OFFSET} (bot${OFFICIAL_BOT_OFFSET + 1}..) — ` +
        `only ${officialSessions.length} available in ${BOT_TOKENS_PATH}. Register more via scripts/seed-bots.ts.`,
    );
  }
  const queueProbe = openQueueDepthProbe();

  await runWarmup(officialSessions[0], ctx.problems, ctx.solutions, ctx.contestId);

  const result = await runLoadWindow({
    label: 'official load test window',
    sessions: officialSessions,
    problems: ctx.problems,
    solutions: ctx.solutions,
    contestId: ctx.contestId,
    durationMs: LOAD_DURATION_MINUTES * 60_000,
    maxInFlightPerBot: LOAD_MAX_INFLIGHT_PER_BOT,
    queueProbe,
    waitForDrain: true,
  });

  await queueProbe.close();
  for (const s of ctx.sockets) s.disconnect();

  printWindowSummary(result);

  // Deliberately no bot cleanup here — these are scripts/seed-bots.ts's persistent accounts,
  // not a throwaway set this script created, so they're left in place for reuse by a future run.
  // Use `--cleanup` explicitly if they should be removed.
}

// --- Ramp test (--ramp): escalating pressure in fixed-duration stages, draining the queue to 0
// between stages so one stage's backlog never contaminates the next's measurement. Ramps
// per-bot in-flight cap (1 → 2 → 3 → 5 → 8) on a FIXED 15-bot pool reused across every stage —
// not bot count — because rl:auth's 10-attempts/15min/IP cap makes registering enough bots for
// fully disjoint bot-count-ramped stages (the originally-planned 5→10→15→20→30) impractically
// slow. Reuse is safe at RAMP_STAGE_SECONDS=50: a bot pacing at the rl:sub floor (10.2s) for 50s
// attempts ~4.9 submissions; across all 5 stages that's ~24.5 total — comfortably under the
// 30-submissions/hour/user cap even for the single busiest bot. ---
interface RampStage {
  perBotCap: number;
}
const RAMP_STAGES: RampStage[] = [
  { perBotCap: 1 }, // applied concurrency 15
  { perBotCap: 2 }, // 30
  { perBotCap: 3 }, // 45 — the fixed spec's own concurrency
  { perBotCap: 5 }, // 75
  { perBotCap: 8 }, // 120
];
const RAMP_STAGE_SECONDS = Number(process.env.RAMP_STAGE_SECONDS) || 50;
const RAMP_DRAIN_DEADLINE_MS = Number(process.env.RAMP_DRAIN_DEADLINE_MS) || 300_000;

async function runRampTest(): Promise<void> {
  const requiredMinutes = RAMP_STAGES.length * (RAMP_STAGE_SECONDS / 60 + RAMP_DRAIN_DEADLINE_MS / 60_000) + 2;
  const ctx = await prepareLoadRun(requiredMinutes);

  const rampSessions = ctx.sessions.slice(RAMP_BOT_OFFSET, RAMP_BOT_OFFSET + RAMP_BOT_COUNT);
  if (rampSessions.length < RAMP_BOT_COUNT) {
    throw new Error(
      `--ramp needs ${RAMP_BOT_COUNT} bots at offset ${RAMP_BOT_OFFSET} (bot${RAMP_BOT_OFFSET + 1}..) — ` +
        `only ${rampSessions.length} available in ${BOT_TOKENS_PATH}. Register more via scripts/seed-bots.ts ` +
        `(BOT_COUNT=${RAMP_BOT_OFFSET + RAMP_BOT_COUNT}).`,
    );
  }

  const queueProbe = openQueueDepthProbe();

  const results: LoadWindowResult[] = [];
  for (const stage of RAMP_STAGES) {
    const result = await runLoadWindow({
      label: `ramp stage ${results.length + 1} (${rampSessions.length} bots × ${stage.perBotCap} in-flight)`,
      sessions: rampSessions,
      problems: ctx.problems,
      solutions: ctx.solutions,
      contestId: ctx.contestId,
      durationMs: RAMP_STAGE_SECONDS * 1000,
      maxInFlightPerBot: stage.perBotCap,
      queueProbe,
      waitForDrain: true, // stage isolation — never start the next stage on top of this one's backlog
      drainDeadlineMs: RAMP_DRAIN_DEADLINE_MS,
    });
    results.push(result);
    printWindowSummary(result);
  }

  await queueProbe.close();
  for (const s of ctx.sockets) s.disconnect();

  console.log('\n=== Ramp test report ===');
  console.log('Stage | Applied concurrency | Throughput (verdicts/min) | Queue depth at stage end | Judge p50 (s) | Judge p95 (s) | POST p95 (ms)');
  for (const r of results) {
    console.log(
      `${r.label.match(/^ramp stage (\d+)/)?.[1] ?? '?'} | ${r.appliedConcurrency} | ${r.throughputPerMin.toFixed(1)} | ` +
        `${r.queueDepthAtWindowEnd ?? 'n/a'} (peak ${r.peakQueueDepth ?? 'n/a'}) | ${r.judgeP50Ms != null ? (r.judgeP50Ms / 1000).toFixed(1) : 'n/a'} | ` +
        `${r.judgeP95Ms != null ? (r.judgeP95Ms / 1000).toFixed(1) : 'n/a'} | ${r.submitP95Ms ?? 'n/a'}`,
    );
  }

  // "Max sustainable" = the last stage whose throughput meaningfully increased (>10% relative)
  // over the previous stage. The first stage that fails this test is where the system stopped
  // converting more applied concurrency into more verdicts/min and started just growing queue
  // depth/latency instead — see worker/src/index.ts's single BullMQ Worker concurrency (no
  // `concurrency` option set, so it defaults to 1) for why this is expected to plateau early.
  let plateauIndex = results.length - 1;
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1].throughputPerMin;
    const curr = results[i].throughputPerMin;
    if (prev > 0 && (curr - prev) / prev < 0.1) {
      plateauIndex = i - 1;
      break;
    }
  }
  const plateau = results[plateauIndex];
  console.log(
    `\nMax sustainable throughput ≈ ${plateau.throughputPerMin.toFixed(1)} verdicts/min, reached at stage ` +
      `${plateauIndex + 1} (applied concurrency ${plateau.appliedConcurrency}). Beyond that, additional ` +
      `applied concurrency grew queue depth and judge latency without increasing throughput.`,
  );
}

async function main(): Promise<void> {
  if (CLEANUP) {
    await cleanup();
    return;
  }

  if (RAMP_MODE) {
    await runRampTest();
    return;
  }

  if (LOAD_MODE) {
    await runOfficialLoadTest();
    return;
  }

  // Direct Mongo access here is orchestration only (reading which problems this contest has,
  // so the script knows what to submit) — every actual bot ACTION below (register, contest
  // registration, submit, poll) goes through the real HTTP API, per this script's whole point.
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
  const contestDoc = await Contest.findOne({ slug: CONTEST_SLUG }).lean();
  if (!contestDoc) {
    await mongoose.disconnect();
    throw new Error(`contest "${CONTEST_SLUG}" not found — run "npm run seed" first`);
  }
  const problemDocs = await Problem.find({ _id: { $in: contestDoc.problemIds } })
    .select('_id slug title')
    .lean();
  const problemById = new Map(problemDocs.map((p) => [p._id.toString(), p]));
  const problems = contestDoc.problemIds.map((id) => problemById.get(id.toString())!).filter(Boolean);
  const contestId = contestDoc._id.toString();
  const startAt = new Date(contestDoc.startAt);
  await mongoose.disconnect();

  console.log(`target contest: "${CONTEST_SLUG}" (${problems.length} problems: ${problems.map((p) => p.slug).join(', ')})`);
  const solutions = loadSolutions(problems.map((p) => p.slug));

  console.log(`creating/logging in ${BOT_COUNT} bot accounts...`);
  const sessions = await createBots(BOT_HANDLE_PREFIX, BOT_PASSWORD, BOT_COUNT);

  console.log(`registering bots for contest ${contestId}...`);
  for (const session of sessions) {
    const res = await apiRequest('POST', `/api/contests/${contestId}/register`, { cookie: session.cookie });
    if (res.status !== 200 && res.status !== 204) {
      console.log(`  [warn] ${session.handle} failed to register: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  if (startAt.getTime() > Date.now()) {
    const waitMs = startAt.getTime() - Date.now() + 1000; // +1s margin past the exact boundary
    console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the contest to start...`);
    await sleep(waitMs);
  }

  console.log('contest running — submitting bot schedules...');
  const semaphore = new Semaphore(MAX_CONCURRENT);
  await Promise.all(
    sessions.map((session, i) =>
      runBotSchedule(session, PROFILE_CYCLE[i % PROFILE_CYCLE.length], problems, solutions, contestId, semaphore),
    ),
  );

  console.log('simulation complete — check the contest leaderboard.');
}

await main();
