// Types below mirror the API's actual response shapes field-for-field (api/src/routes/*,
// api/src/models/*). Duplicated deliberately rather than imported across workspaces, per
// this repo's established convention for cross-service type drift (see ARCHITECTURE.md §3).

// api/src/routes/auth.ts — register/login/me response shape
export interface AuthUser {
  id: string;
  handle: string;
  email: string;
  isAdmin: boolean;
}

// api/src/routes/problems.ts GET / — bare array, no wrapper
export interface ProblemSummary {
  _id: string;
  title: string;
  slug: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
}

export interface ProblemSample {
  input: string;
  output: string;
  explanation?: string;
}

// api/src/routes/problems.ts GET /:slug
export interface ProblemDetail {
  _id: string;
  slug: string;
  title: string;
  statementMd: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  samples: ProblemSample[];
}

// api/src/models/Submission.ts VERDICTS
export type SubmissionStatus = 'queued' | 'running' | 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE';

// api/src/routes/problems.ts GET /:slug/submissions
export interface SubmissionHistoryItem {
  _id: string;
  status: SubmissionStatus;
  createdAt: string;
  execTimeMs: number | null;
  language: 'cpp';
}

// api/src/routes/submissions.ts GET /:id — full raw doc
export interface SubmissionDetail {
  _id: string;
  userId: string;
  problemId: string;
  code: string;
  language: 'cpp';
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
  output?: string;
  compileError?: string;
  idempotencyKey: string;
  contestId?: string;
  contestScored?: boolean;
  createdAt: string;
  updatedAt: string;
}

// api/src/routes/contests.ts GET / — wrapped (not a bare array) so serverTime can ride
// along for the clock-skew offset (see CountdownTimer)
export interface ContestSummary {
  _id: string;
  slug: string;
  title: string;
  startAt: string;
  endAt: string;
  problemCount: number;
  isRegistered: boolean;
}

export interface ContestListResponse {
  serverTime: number;
  contests: ContestSummary[];
}

export type ContestPhase = 'upcoming' | 'running' | 'ended';

export interface ContestMeta {
  _id: string;
  slug: string;
  title: string;
  startAt: string;
  endAt: string;
  isFinalized: boolean;
}

// api/src/routes/contests.ts GET /:id — problems is [] unless phase is running (and the
// caller is registered) or ended
export interface ContestDetailResponse {
  serverTime: number;
  contest: ContestMeta;
  phase: ContestPhase;
  isRegistered: boolean;
  problems: ProblemDetail[];
}

export interface RegisterContestResponse {
  registered: boolean;
}

// api/src/routes/contests.ts GET /:id/leaderboard — one column per contest problem,
// in contest.problemIds order, labeled A/B/C.. for the standings grid header.
export interface LeaderboardProblemColumn {
  problemId: string;
  label: string;
}

// ICPC-style per-problem cell: solved (with solve time + any wrong attempts before
// it), attempted-but-unsolved (wrongAttempts > 0, solved: false), or the problem is
// simply absent from a row's `cells` (untouched — render empty).
export interface LeaderboardCell {
  problemId: string;
  solved: boolean;
  solvedAtMinutes?: number;
  wrongAttempts: number;
}

// api/src/routes/contests.ts GET /:id/leaderboard
export interface LeaderboardRow {
  rank: number;
  userId: string;
  handle: string;
  solvedCount: number;
  penaltyMinutes: number;
  // Present (possibly empty) when isFinalized; absent on live rows until fetched via
  // getContestLeaderboardUserCells (GET /:id/leaderboard/:userId).
  cells?: LeaderboardCell[];
}

// Deliberately has no userId/handle/cells — see the "me" row design note in the UI
// redesign plan: the current user's own row, when present in `rows[]`, is rendered
// identically to any other row (same inline-cells-if-finalized /
// click-to-expand-if-live behavior). This summary line only covers the case where
// the user's rank falls outside the current page.
export interface LeaderboardMeRow {
  rank: number;
  solvedCount: number;
  penaltyMinutes: number;
}

export interface LeaderboardResponse {
  serverTime: number;
  isFinalized: boolean;
  total: number;
  problems: LeaderboardProblemColumn[];
  rows: LeaderboardRow[];
  me: LeaderboardMeRow | null;
}

// api/src/routes/contests.ts GET /:id/leaderboard/:userId — live-contest, single-user
// per-problem breakdown; never called for finalized contests (their rows already
// embed `cells`).
export interface LeaderboardUserCellsResponse {
  cells: LeaderboardCell[];
}

// Mirrors api/src/socket/types.ts LeaderboardClientEvent — a "go refetch" signal only,
// same contract discipline as VerdictClientEvent below.
export interface LeaderboardClientEvent {
  contestId: string;
  finalized?: boolean;
}

export interface ContestAnnouncementEvent {
  contestId: string;
  message: string;
}

// api/src/routes/submissions.ts POST / — field is `id`, not `submissionId`, on every
// response path (create, idempotent short-circuit, race recovery)
export interface CreateSubmissionResponse {
  id: string;
}

// api/src/middleware/errors.ts errorHandler
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// api/src/middleware/rateLimit.ts — nested under error.details, not top-level
export interface RateLimitDetails {
  retryAfterMs: number;
}

// Mirrors api/src/socket/types.ts VerdictClientEvent exactly — this is the client contract,
// do not extend it or read any other field off the socket payload (REST is truth).
export interface VerdictClientEvent {
  submissionId: string;
  verdict: string;
}

// api/src/routes/run.ts — "Run on samples": executes against the problem's public samples
// only, never a real submission (no history entry, no contest scoring, no hint eligibility —
// see ARCHITECTURE.md §5). A subset of SubmissionStatus; CE is whole-run, not per-sample.
export type RunSampleVerdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE';

export interface RunSampleResult {
  index: number;
  verdict: RunSampleVerdict;
  actualOutput: string; // truncated by the worker
  expectedOutput: string;
  execTimeMs?: number;
}

export interface RunResponse {
  runId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  compileError?: string; // present only on CE; samples is [] when present
  samples: RunSampleResult[];
}

// Mirrors api/src/socket/types.ts RunClientEvent exactly — a "go refetch" signal only,
// same "REST is truth" discipline as VerdictClientEvent. GET /api/run/:runId is the source
// of truth; this event never carries the actual result payload.
export interface RunClientEvent {
  runId: string;
}

// api/src/routes/hints.ts POST / — a discriminated union: the degraded path (LLM
// timeout/outage, global quota exhausted) is a 200, not an error, per the "never a
// 5xx, judging path unaffected" design.
export interface HintAvailableResponse {
  available: true;
  level: 1 | 2 | 3;
  hintText: string;
  tokensUsed: number;
  hintsRemainingToday: number;
}
export interface HintUnavailableResponse {
  available: false;
  message: string;
}
export type HintResponse = HintAvailableResponse | HintUnavailableResponse;

// api/src/routes/problems.ts GET /:slug/hints
export interface HintSummary {
  level: 1 | 2 | 3;
  hintText: string;
}

// Mirrors api/src/socket/types.ts HintClientEvent — a live-typing signal only, same
// "REST is truth" discipline as VerdictClientEvent; the awaited POST /api/hints
// response is what actually unlocks a level, not this stream.
export interface HintClientEvent {
  submissionId: string;
  level: 1 | 2 | 3;
  chunk?: string;
}
