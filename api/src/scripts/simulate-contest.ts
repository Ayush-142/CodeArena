// Bot-contest driver — exercises the REAL system end-to-end (real register/login/submit HTTP
// calls, real judging, real BullMQ/Docker pipeline), not DB inserts. Used to make a live demo
// contest's leaderboard reorder in real time (see DEMO.md), and separately (--load) to produce
// the measured performance numbers in README.md's "Measured performance" table.
//
//   npm run simulate-contest                 # drives the seeded live demo contest
//   npm run simulate-contest -- --contest=some-slug
//   npm run simulate-contest -- --cleanup    # removes bot AND load-test users + their submissions
//   npm run simulate-contest -- --load --contest=some-slug   # sustained load/acceptance test — see runLoadTest()
//
// Env: BASE_URL (default http://localhost:3001), SIMULATOR_BOT_COUNT (default 8),
// SIMULATOR_MAX_CONCURRENT (default 3), LOAD_MAX_CONCURRENT (default 3),
// LOAD_DURATION_MINUTES (default 5), LOAD_WARMUP_COUNT (default 3),
// REDIS_TUNNEL_URL (default redis://127.0.0.1:6379).
//
// --load is an acceptance-test tool, not a demo feature: it deliberately saturates the judge
// queue to measure throughput/latency/drain-time under sustained load. Never run it during a
// live audience demo — see DEMO.md's warning.
//
// --load talks to BASE_URL purely over HTTP + Socket.io (no Mongo connection — it's designed to
// run from an operator's own machine against a deployed VM, not just via `docker compose exec`
// on the VM itself). It resolves --contest=<slug> through the public contest API, discovers that
// contest's problems (and their real Mongo ids, needed to find scripts/solutions/<problemId>/)
// from GET /api/contests/:id once the contest is running, loads bot sessions from
// scripts/bot-tokens.json (written by scripts/seed-bots.ts), and pulls queue depth by talking to
// BullMQ directly over REDIS_TUNNEL_URL — GET /metrics is deliberately unreachable through the
// public domain in production (see DEPLOY.md), so this script never depends on it.
import 'dotenv/config'; // MUST be first — same ESM import-hoisting reason as seed.ts/reset-demo-contest.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const LOAD_MAX_CONCURRENT = Number(process.env.LOAD_MAX_CONCURRENT) || 3;
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

// Every call treats 429 RATE_LIMITED as retryable — sleeps retryAfterMs (from the AppError's
// `details`, same shape rateLimit.ts always throws) and retries, so a live demo can't crash or
// abort mid-run on a rate-limit hit. Never throws on 429; only network-level failures escape.
async function apiRequest(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<ApiResult> {
  for (;;) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const body = text.length > 0 ? JSON.parse(text) : null;

    if (res.status === 429) {
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
  const bots = await User.find({ handle: { $regex: `^(${BOT_HANDLE_PREFIX}|${LOAD_HANDLE_PREFIX})` } })
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

// Races the Socket.io verdict event against a REST poll fallback (same 30s deadline/1s cadence
// as the demo-mode submitAndWait above) so a dropped WS message never hangs a bot forever. Both
// paths measure latency from the same enqueueTs (recorded right after POST returns 202, i.e.
// as close to "the job was enqueued" as an external client can observe).
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
        resolve(result);
      },
    });
  });
  const viaPoll = (async (): Promise<{ verdict: string; latencyMs: number } | null> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !settled) {
      await sleep(1000);
      if (settled) break;
      const poll = await apiRequest('GET', `/api/submissions/${submissionId}`, { cookie: session.cookie });
      const status: string | undefined = poll.body?.status;
      if (status && status !== 'queued' && status !== 'running') {
        settled = true;
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

// Acceptance/load test — NOT a demo feature (see file header). Measures exactly the metrics
// README.md's "Measured performance" table expects, so filling that table in is copy-paste from
// this script's own summary output. Submits WITH contestId against a real, running, admin-created
// contest (--contest=<slug>) — the bots must already be (or must still be able to become)
// registered before that contest's startAt.
async function runLoadTest(): Promise<void> {
  console.log(`--load: resolving contest "${CONTEST_SLUG}" via ${BASE_URL}...`);
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
  if (remainingMinutes < LOAD_DURATION_MINUTES + 1) {
    throw new Error(
      `contest ${contestId} only has ${remainingMinutes.toFixed(1)} minutes left — need at least ` +
        `${LOAD_DURATION_MINUTES + 1} for a ${LOAD_DURATION_MINUTES}-minute load test plus warm-up`,
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

  // --- Warm-up: a few real AC submissions against these same problems before the timed window,
  // so Docker/compile-layer caches are hot before measurement starts (not counted in any stat). ---
  console.log(`\n=== warm-up (${LOAD_WARMUP_COUNT} submissions) ===`);
  const warmupBot = sessions[0];
  for (let i = 0; i < LOAD_WARMUP_COUNT; i++) {
    const problem = problems[i % problems.length];
    const code = solutions[problem.slug]?.ac;
    if (!code) {
      console.log(`  [warn] no AC solution for warm-up problem "${problem.slug}" — skipping`);
      continue;
    }
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
    await sleep(2000);
  }

  console.log(
    `\n=== load test window: ${sessions.length} bots, ${LOAD_MAX_CONCURRENT} max in-flight, ` +
      `${LOAD_DURATION_MINUTES}-minute sustained run, ~70% AC / 20% WA / 10% TLE mix ===`,
  );

  const submitLatenciesMs: number[] = [];
  const judgeLatenciesMs: number[] = [];
  let completedCount = 0;
  const semaphore = new Semaphore(LOAD_MAX_CONCURRENT);
  const stopAt = Date.now() + LOAD_DURATION_MINUTES * 60_000;

  const queueProbe = openQueueDepthProbe();
  let peakQueueDepth = 0;
  let lastQueueDepth = 0;
  let keepPollingQueue = true;
  const queueDepthPoller = (async () => {
    while (keepPollingQueue) {
      try {
        lastQueueDepth = await currentQueueDepth(queueProbe);
        if (lastQueueDepth > peakQueueDepth) peakQueueDepth = lastQueueDepth;
      } catch (err) {
        console.log(`  [warn] queue depth poll failed: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(1000); // per the load-test plan: poll BullMQ waiting+active every 1s
    }
  })();

  async function botLoadLoop(session: LoadSession): Promise<void> {
    while (Date.now() < stopAt) {
      const problem = problems[Math.floor(Math.random() * problems.length)];
      const kind = pickWeightedKind();
      const code = solutions[problem.slug]?.[kind];
      if (!code) continue;

      const release = await semaphore.acquire();
      try {
        const submitStart = Date.now();
        const res = await apiRequest('POST', '/api/submissions', {
          cookie: session.cookie,
          body: { problemSlug: problem.slug, language: 'cpp', code, contestId },
        });
        submitLatenciesMs.push(Date.now() - submitStart);

        if (res.status === 202) {
          const enqueueTs = Date.now(); // as close to "job enqueued" as an external client can observe
          const result = await waitForVerdict(session, res.body.id as string, enqueueTs);
          if (result) {
            judgeLatenciesMs.push(result.latencyMs);
            completedCount += 1;
          } else {
            console.log(`  [warn] ${session.handle} · ${problem.slug} · no verdict within 30s`);
          }
        } else {
          console.log(`  [warn] ${session.handle} · ${problem.slug} · submit failed: ${res.status}`);
        }
      } finally {
        release();
      }
      await sleep(11_000 + Math.random() * 4000); // same rl:sub-respecting pacing as the demo mode
    }
  }

  await Promise.all(sessions.map(botLoadLoop));
  const loadStoppedAt = Date.now();

  console.log('load window complete — waiting for the queue to drain...');
  const drainDeadlineMs = 120_000;
  const drainWaitStart = Date.now();
  let drained = false;
  while (Date.now() - drainWaitStart < drainDeadlineMs) {
    if (lastQueueDepth === 0) {
      drained = true;
      break;
    }
    await sleep(500);
  }
  const drainTimeSeconds = (Date.now() - loadStoppedAt) / 1000;

  keepPollingQueue = false;
  await queueDepthPoller;
  await queueProbe.close();
  for (const s of sockets) s.disconnect();

  submitLatenciesMs.sort((a, b) => a - b);
  judgeLatenciesMs.sort((a, b) => a - b);
  const submitP95 = percentile(submitLatenciesMs, 0.95);
  const submitMean =
    submitLatenciesMs.length > 0
      ? Math.round(submitLatenciesMs.reduce((sum, v) => sum + v, 0) / submitLatenciesMs.length)
      : null;
  const judgeP50 = percentile(judgeLatenciesMs, 0.5);
  const judgeP95 = percentile(judgeLatenciesMs, 0.95);
  const throughputPerMin = completedCount / LOAD_DURATION_MINUTES;

  console.log('\n=== Load test summary ===');
  console.log(
    `Test conditions: ${sessions.length} bots, ${LOAD_MAX_CONCURRENT} max in-flight submissions, ` +
      `${LOAD_DURATION_MINUTES}-minute sustained run against the deployed VM (contest ${contestId}), ` +
      `solution mix ~70% AC / 20% WA / 10% TLE. ${completedCount} verdicts observed.`,
  );
  console.log('Metric                                          | Measured');
  console.log(`Sustained judge throughput (verdicts/min)       | ${throughputPerMin.toFixed(1)}`);
  console.log(`Peak queue depth (jobs)                         | ${peakQueueDepth}`);
  console.log(`Judge latency p95, enqueue→verdict (s)          | ${judgeP95 != null ? (judgeP95 / 1000).toFixed(1) : 'n/a'}`);
  console.log(`Judge latency p50, enqueue→verdict (s)          | ${judgeP50 != null ? (judgeP50 / 1000).toFixed(1) : 'n/a'}`);
  console.log(`POST /api/submissions p95 during peak (ms)      | ${submitP95 ?? 'n/a'}`);
  console.log(`Mean POST /api/submissions latency (ms)         | ${submitMean ?? 'n/a'}`);
  console.log(`Queue drain time after load stopped (s)         | ${drained ? drainTimeSeconds.toFixed(1) : `>${drainDeadlineMs / 1000} (timed out)`}`);

  // Deliberately no bot cleanup here — these are scripts/seed-bots.ts's persistent accounts
  // (bot01..bot15), not a throwaway set this script created, so they're left in place for reuse
  // by a future run. Use `--cleanup` explicitly if they should be removed.
}

async function main(): Promise<void> {
  if (CLEANUP) {
    await cleanup();
    return;
  }

  if (LOAD_MODE) {
    await runLoadTest();
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
