// Bot-contest driver — exercises the REAL system end-to-end (real register/login/submit HTTP
// calls, real judging, real BullMQ/Docker pipeline), not DB inserts. Used to make a live demo
// contest's leaderboard reorder in real time (see DEMO.md), and separately (--load) to produce
// the measured performance numbers in README.md's "Measured performance" table.
//
//   npm run simulate-contest                 # drives the seeded live demo contest
//   npm run simulate-contest -- --contest=some-slug
//   npm run simulate-contest -- --cleanup    # removes bot AND load-test users + their submissions
//   npm run simulate-contest -- --load       # sustained load/acceptance test — see runLoadTest()
//
// Env: BASE_URL (default http://localhost:3001), SIMULATOR_BOT_COUNT (default 8),
// SIMULATOR_MAX_CONCURRENT (default 3), LOAD_BOT_COUNT (default 15),
// LOAD_DURATION_MINUTES (default 5), LOAD_MAX_CONCURRENT (default 3).
//
// --load is an acceptance-test tool, not a demo feature: it deliberately saturates the judge
// queue to measure throughput/latency/drain-time under sustained load. Never run it during a
// live audience demo — see DEMO.md's warning.
import 'dotenv/config'; // MUST be first — same ESM import-hoisting reason as seed.ts/reset-demo-contest.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { Contest } from '../models/Contest.js';
import { Problem } from '../models/Problem.js';
import { User } from '../models/User.js';
import { Submission } from '../models/Submission.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLUTIONS_DIR = join(__dirname, '../../../scripts/solutions');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const BOT_COUNT = Number(process.env.SIMULATOR_BOT_COUNT) || 8;
const MAX_CONCURRENT = Number(process.env.SIMULATOR_MAX_CONCURRENT) || 3;
const LOAD_BOT_COUNT = Number(process.env.LOAD_BOT_COUNT) || 15;
const LOAD_DURATION_MINUTES = Number(process.env.LOAD_DURATION_MINUTES) || 5;
const LOAD_MAX_CONCURRENT = Number(process.env.LOAD_MAX_CONCURRENT) || 3;

// Must match reset-demo-contest.ts's BOT_HANDLE_PREFIX. Alphanumeric-only (api/src/routes/
// auth.ts's HANDLE_RE has no underscore) — "bot0001", not "bot_0001".
const BOT_HANDLE_PREFIX = 'bot';
const BOT_PASSWORD = 'BotPass123'; // fixed, documented in DEMO.md — bot accounts, not real users
// Separate prefix for --load mode so a load-test run and a contest-narrative run never collide
// on the same handle if both happen to be live at once; --cleanup removes both prefixes.
const LOAD_HANDLE_PREFIX = 'load';
const LOAD_PASSWORD = 'LoadPass123';
// The 3 problems that already have full ac/wa/tle solution sets (see scripts/solutions/) — used
// for --load regardless of --contest, since load testing cares about judge throughput, not
// contest semantics. Temporarily published for the run's duration (runLoadTest restores
// whatever isPublished state each one had beforehand) since --load submits as practice
// (no contestId), and these are normally kept private for the live demo contest's gating.
const LOAD_PROBLEM_SLUGS = ['is-prime', 'two-sum', 'longest-increasing-subsequence'];

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

interface LoadMetricsSnapshot {
  queueDepth: number;
  judgeLatencyMs: { avgMs: number | null; p50Ms: number | null; p95Ms: number | null; sampleCount: number };
}

async function fetchLoadMetrics(): Promise<LoadMetricsSnapshot> {
  const res = await apiRequest('GET', '/metrics');
  const q = res.body?.queueDepth?.submissions ?? {};
  return {
    queueDepth: (q.waiting ?? 0) + (q.active ?? 0),
    judgeLatencyMs: res.body?.judgeLatencyMs ?? { avgMs: null, p50Ms: null, p95Ms: null, sampleCount: 0 },
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

// Acceptance/load test — NOT a demo feature (see file header). Measures exactly the 6 rows
// README.md's "Measured performance" table expects, so filling that table in is copy-paste from
// this script's own summary output, not separate derivation. Submits as PRACTICE (no
// contestId) against LOAD_PROBLEM_SLUGS, temporarily published for the run.
async function runLoadTest(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
  const problemDocs = await Problem.find({ slug: { $in: LOAD_PROBLEM_SLUGS } })
    .select('_id slug isPublished')
    .lean();
  if (problemDocs.length !== LOAD_PROBLEM_SLUGS.length) {
    await mongoose.disconnect();
    throw new Error(`expected all of ${LOAD_PROBLEM_SLUGS.join(', ')} to exist — run "npm run seed" first`);
  }
  const originalPublishState = new Map(problemDocs.map((p) => [p._id.toString(), p.isPublished]));
  await Problem.updateMany({ _id: { $in: problemDocs.map((p) => p._id) } }, { $set: { isPublished: true } });
  await mongoose.disconnect();

  console.log(
    `--load: ${LOAD_BOT_COUNT} bots, ${LOAD_MAX_CONCURRENT} max in-flight, ${LOAD_DURATION_MINUTES}-minute ` +
      `sustained run, ~70% AC / 20% WA / 10% TLE mix against ${LOAD_PROBLEM_SLUGS.join(', ')}`,
  );

  const solutions = loadSolutions(LOAD_PROBLEM_SLUGS);
  console.log(`creating/logging in ${LOAD_BOT_COUNT} load-test bot accounts...`);
  const sessions = await createBots(LOAD_HANDLE_PREFIX, LOAD_PASSWORD, LOAD_BOT_COUNT);

  const submitLatenciesMs: number[] = [];
  let completedCount = 0;
  let peakQueueDepth = 0;
  const semaphore = new Semaphore(LOAD_MAX_CONCURRENT);
  const stopAt = Date.now() + LOAD_DURATION_MINUTES * 60_000;

  let keepPolling = true;
  const queuePoller = (async () => {
    while (keepPolling) {
      try {
        const snap = await fetchLoadMetrics();
        if (snap.queueDepth > peakQueueDepth) peakQueueDepth = snap.queueDepth;
      } catch (err) {
        console.log(`  [warn] /metrics poll failed: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(3000);
    }
  })();

  async function botLoadLoop(session: Session): Promise<void> {
    while (Date.now() < stopAt) {
      const slug = LOAD_PROBLEM_SLUGS[Math.floor(Math.random() * LOAD_PROBLEM_SLUGS.length)];
      const kind = pickWeightedKind();
      const code = solutions[slug]?.[kind];
      if (!code) continue;

      const release = await semaphore.acquire();
      try {
        const submitStart = Date.now();
        const res = await apiRequest('POST', '/api/submissions', {
          cookie: session.cookie,
          body: { problemSlug: slug, language: 'cpp', code },
        });
        submitLatenciesMs.push(Date.now() - submitStart);

        if (res.status === 202) {
          const submissionId = res.body.id as string;
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await sleep(1000);
            const poll = await apiRequest('GET', `/api/submissions/${submissionId}`, { cookie: session.cookie });
            const status: string | undefined = poll.body?.status;
            if (status && status !== 'queued' && status !== 'running') {
              completedCount += 1;
              break;
            }
          }
        } else {
          console.log(`  [warn] ${session.handle} · ${slug} · submit failed: ${res.status}`);
        }
      } finally {
        release();
      }
      await sleep(11_000 + Math.random() * 4000); // same rl:sub-respecting pacing as the contest mode
    }
  }

  await Promise.all(sessions.map(botLoadLoop));
  const loadStoppedAt = Date.now();
  keepPolling = false;
  await queuePoller;

  console.log('load window complete — waiting for the queue to drain...');
  const drainDeadlineMs = 120_000;
  const drainStart = Date.now();
  let drained = false;
  while (Date.now() - drainStart < drainDeadlineMs) {
    const snap = await fetchLoadMetrics();
    if (snap.queueDepth === 0) {
      drained = true;
      break;
    }
    await sleep(2000);
  }
  const drainTimeSeconds = (Date.now() - loadStoppedAt) / 1000;

  const finalSnap = await fetchLoadMetrics();
  submitLatenciesMs.sort((a, b) => a - b);
  const submitP95 = percentile(submitLatenciesMs, 0.95);
  const throughputPerMin = completedCount / LOAD_DURATION_MINUTES;

  console.log('\n=== Load test summary ===');
  console.log(
    `Test conditions: ${LOAD_BOT_COUNT} bots, ${LOAD_MAX_CONCURRENT} max in-flight submissions, ` +
      `${LOAD_DURATION_MINUTES}-minute sustained run against the deployed VM, solution mix ~70% AC / 20% WA / 10% TLE.`,
  );
  console.log('Metric                                          | Measured');
  console.log(`Sustained judge throughput (verdicts/min)       | ${throughputPerMin.toFixed(1)}`);
  console.log(`Peak queue depth (jobs)                         | ${peakQueueDepth}`);
  console.log(
    `Judge latency p95, enqueue→verdict (s)          | ${finalSnap.judgeLatencyMs.p95Ms != null ? (finalSnap.judgeLatencyMs.p95Ms / 1000).toFixed(1) : 'n/a'}`,
  );
  console.log(
    `Judge latency p50, enqueue→verdict (s)          | ${finalSnap.judgeLatencyMs.p50Ms != null ? (finalSnap.judgeLatencyMs.p50Ms / 1000).toFixed(1) : 'n/a'}`,
  );
  console.log(`POST /api/submissions p95 during peak (ms)      | ${submitP95 ?? 'n/a'}`);
  console.log(`Queue drain time after load stopped (s)         | ${drained ? drainTimeSeconds.toFixed(1) : `>${drainDeadlineMs / 1000} (timed out)`}`);

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
  for (const [id, wasPublished] of originalPublishState) {
    await Problem.updateOne({ _id: id }, { $set: { isPublished: wasPublished } });
  }
  await mongoose.disconnect();
  console.log('\nrestored original problem publish state.');

  await cleanup();
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
