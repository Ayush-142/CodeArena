import { Contest } from '../models/Contest.js';
import { Submission } from '../models/Submission.js';
import { Problem } from '../models/Problem.js';
import { User } from '../models/User.js';
import { redisClient } from '../redis/client.js';

// Must match worker/src/scoring.ts's MULTIPLIER exactly — duplicated rather than
// shared, following this codebase's established API/worker model-duplication
// convention (no /shared package). See ARCHITECTURE.md Phase 5 plan, decision #2.
export const MULTIPLIER = 1e7;

const SCORED_WRONG_STATUSES = new Set(['WA', 'TLE', 'MLE', 'RE']);
const WRONG_ATTEMPT_PENALTY_MINUTES = 20;

export interface StandingsCell {
  problemId: string;
  solved: boolean;
  solvedAtMinutes?: number;
  wrongAttempts: number;
}

export interface StandingsRow {
  userId: string;
  solvedCount: number;
  penaltyMinutes: number;
  cells: StandingsCell[];
}

export interface FinalStandingRow {
  userId: string;
  handle: string;
  solvedCount: number;
  penaltyMinutes: number;
  rank: number;
  cells: StandingsCell[];
}

export function packScore(solvedCount: number, penaltyMinutes: number): number {
  return solvedCount * MULTIPLIER - penaltyMinutes;
}

export function unpackScore(score: number): { solvedCount: number; penaltyMinutes: number } {
  // score = solvedCount*MULTIPLIER - penaltyMinutes, with 0 <= penaltyMinutes < MULTIPLIER,
  // so score/MULTIPLIER = solvedCount - penaltyMinutes/MULTIPLIER lands in
  // (solvedCount-1, solvedCount] — exactly solvedCount when penalty is 0, and strictly
  // between solvedCount-1 and solvedCount for any penalty in (0, MULTIPLIER). Math.ceil
  // recovers solvedCount exactly for every value in that range, needing only
  // penaltyMinutes < MULTIPLIER (not < MULTIPLIER/2, which Math.round would require and
  // which Math.floor gets wrong entirely — caught by runtime verification: a real
  // 1-solve/20-penalty score of 9999980 floored to 0 solves instead of 1).
  const solvedCount = Math.ceil(score / MULTIPLIER);
  const penaltyMinutes = solvedCount * MULTIPLIER - score;
  return { solvedCount, penaltyMinutes };
}

// Redis ZREVRANGE breaks equal-score ties by DESCENDING lexicographic (byte-wise)
// member order — not locale order. This tiebreak must match that exactly, or a tied
// pair can rank differently live (Redis-served) vs. finalized (this function). Plain
// `>`/`<` on the ObjectId hex string is byte-wise (ObjectId hex is plain ASCII), so it
// agrees with Redis; `localeCompare` would NOT be safe to use here in general.
function compareUserIdDescending(a: string, b: string): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

// Per-(userId, problemId) group: finds the first AC and counts qualifying wrong
// attempts (WA/TLE/MLE/RE, not CE) before it. wrongAttempts is now always returned
// (not just on the solved path) so callers can render an "attempted but unsolved"
// cell. Submissions still `queued`/`running` at read time simply match neither the
// AC nor wrong-attempt status sets, so they're silently skipped — no special-casing
// needed for in-flight jobs (this is what lets tryFinalizeContest finalize past its
// grace window even with a permanently-stuck job: that submission just contributes
// nothing here).
function scoreGroup(
  entries: { status: string; createdAt: Date }[],
  startAt: Date,
): { solved: boolean; solveMinutes?: number; wrongAttempts: number } {
  let wrongCount = 0;
  for (const entry of entries) {
    if (entry.status === 'AC') {
      const minutes = Math.floor((entry.createdAt.getTime() - startAt.getTime()) / 60000);
      return { solved: true, solveMinutes: minutes, wrongAttempts: wrongCount };
    }
    if (SCORED_WRONG_STATUSES.has(entry.status)) {
      wrongCount += 1;
    }
  }
  return { solved: false, wrongAttempts: wrongCount };
}

// Single linear pass over submissions sorted by (userId, problemId, createdAt) —
// deliberately not a Mongo aggregation pipeline, to stay simple/explainable. Walks
// consecutive (userId, problemId) runs via scoreGroup. Untouched problems are simply
// absent from a user's `cells` — callers reconcile against the contest's known
// problem list to render empty cells, rather than this function emitting placeholders
// for problems a user never submitted to.
export async function computeStandings(contestId: string, endAt: Date): Promise<StandingsRow[]> {
  const contest = await Contest.findById(contestId).select('startAt').lean();
  if (!contest) return [];

  const subs = await Submission.find({ contestId, createdAt: { $lte: endAt } })
    .sort({ userId: 1, problemId: 1, createdAt: 1 })
    .select('userId problemId status createdAt')
    .lean();

  const perUser = new Map<string, { solvedCount: number; penaltyMinutes: number; cells: StandingsCell[] }>();
  let groupKey: string | null = null;
  let groupUserId = '';
  let groupProblemId = '';
  let groupEntries: { status: string; createdAt: Date }[] = [];

  const flushGroup = () => {
    if (groupEntries.length === 0) return;
    const { solved, solveMinutes, wrongAttempts } = scoreGroup(groupEntries, contest.startAt);
    const existing = perUser.get(groupUserId) ?? { solvedCount: 0, penaltyMinutes: 0, cells: [] };
    if (solved) {
      existing.solvedCount += 1;
      existing.penaltyMinutes += solveMinutes! + WRONG_ATTEMPT_PENALTY_MINUTES * wrongAttempts;
    }
    if (solved || wrongAttempts > 0) {
      existing.cells.push({
        problemId: groupProblemId,
        solved,
        solvedAtMinutes: solved ? solveMinutes : undefined,
        wrongAttempts,
      });
    }
    perUser.set(groupUserId, existing);
    groupEntries = [];
  };

  for (const sub of subs) {
    const userId = sub.userId.toString();
    const problemId = sub.problemId.toString();
    const key = `${userId}:${problemId}`;
    if (key !== groupKey) {
      flushGroup();
      groupKey = key;
      groupUserId = userId;
      groupProblemId = problemId;
    }
    groupEntries.push({ status: sub.status, createdAt: sub.createdAt });
  }
  flushGroup();

  const rows: StandingsRow[] = Array.from(perUser.entries()).map(([userId, v]) => ({ userId, ...v }));
  return rows.sort(
    (a, b) =>
      b.solvedCount - a.solvedCount ||
      a.penaltyMinutes - b.penaltyMinutes ||
      compareUserIdDescending(a.userId, b.userId),
  );
}

// Live-contest, single-user per-problem breakdown — the on-demand path a leaderboard
// row expansion hits (never called for finalized contests, whose rows already embed
// `cells`). Scoped to one (contestId, userId) pair via the existing
// {contestId, userId, problemId, createdAt} index prefix, so this is a bounded point
// query, not a scan — deliberately separate from computeStandings rather than
// filtering its full-contest pass down, since that would still pay for every other
// user's submissions on every row-click.
export async function computeUserStandingsCells(
  contestId: string,
  userId: string,
  endAt: Date,
): Promise<StandingsCell[]> {
  const contest = await Contest.findById(contestId).select('startAt').lean();
  if (!contest) return [];

  const subs = await Submission.find({ contestId, userId, createdAt: { $lte: endAt } })
    .sort({ problemId: 1, createdAt: 1 })
    .select('problemId status createdAt')
    .lean();

  const cells: StandingsCell[] = [];
  let groupProblemId: string | null = null;
  let groupEntries: { status: string; createdAt: Date }[] = [];

  const flushGroup = () => {
    if (groupEntries.length === 0) return;
    const { solved, solveMinutes, wrongAttempts } = scoreGroup(groupEntries, contest.startAt);
    if (solved || wrongAttempts > 0) {
      cells.push({
        problemId: groupProblemId!,
        solved,
        solvedAtMinutes: solved ? solveMinutes : undefined,
        wrongAttempts,
      });
    }
    groupEntries = [];
  };

  for (const sub of subs) {
    const problemId = sub.problemId.toString();
    if (problemId !== groupProblemId) {
      flushGroup();
      groupProblemId = problemId;
    }
    groupEntries.push({ status: sub.status, createdAt: sub.createdAt });
  }
  flushGroup();

  return cells;
}

export async function rebuildRedisLeaderboard(contestId: string, endAt: Date): Promise<void> {
  const rows = await computeStandings(contestId, endAt);
  const key = `lb:${contestId}`;
  await redisClient.del(key);
  if (rows.length === 0) return;
  await redisClient.zAdd(
    key,
    rows.map((r) => ({ score: packScore(r.solvedCount, r.penaltyMinutes), value: r.userId })),
  );
}

// Shared by tryFinalizeContest and backfillFinalStandingsCells so both produce
// shape-identical rows (same rank math, same handle-resolution query) rather than
// two copies that can drift.
async function buildFinalStandingRows(rows: StandingsRow[]): Promise<FinalStandingRow[]> {
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('handle').lean();
  const handleById = new Map(users.map((u) => [u._id.toString(), u.handle]));
  return rows.map((r, i) => ({
    userId: r.userId,
    handle: handleById.get(r.userId) ?? 'unknown',
    solvedCount: r.solvedCount,
    penaltyMinutes: r.penaltyMinutes,
    rank: i + 1,
    cells: r.cells,
  }));
}

// A submission created before endAt whose job was permanently lost (e.g. a Redis
// flush ate the queue before the recovery scan re-enqueued it, or it re-enqueued to a
// since-decommissioned worker) must not block finalization forever. Past this grace
// window, finalize using whatever's on disk — a still-queued/running submission just
// doesn't contribute (see scoreGroup above).
const FINALIZE_GRACE_MS = 10 * 60 * 1000; // 10 minutes past endAt

export async function tryFinalizeContest(contestId: string): Promise<boolean> {
  const contest = await Contest.findById(contestId);
  if (!contest || contest.isFinalized) return true;

  const msPastEnd = Date.now() - contest.endAt.getTime();
  if (msPastEnd <= 0) return false;

  if (msPastEnd < FINALIZE_GRACE_MS) {
    const pending = await Submission.exists({
      contestId,
      createdAt: { $lte: contest.endAt },
      status: { $in: ['queued', 'running'] },
    });
    if (pending) return false; // still judging in-window submissions — retry on next read
  }
  // else: past the grace window — finalize regardless of any still-pending job.

  const rows = await computeStandings(contestId, contest.endAt);
  const finalStandings = await buildFinalStandingRows(rows);

  // Atomic guard: a concurrent second request racing the same finalization loses this update.
  const won = await Contest.findOneAndUpdate(
    { _id: contestId, isFinalized: false },
    { $set: { finalStandings, isFinalized: true } },
  );
  if (!won) return true; // someone else already finalized it

  await Problem.updateMany({ _id: { $in: contest.problemIds } }, { $set: { isPublished: true } });
  await redisClient.expire(`lb:${contestId}`, 86400); // kept briefly for continuity, not authoritative
  await redisClient.publish('ch:leaderboard', JSON.stringify({ contestId, finalized: true }));
  return true;
}

// Contests finalized before per-problem cells shipped have finalStandings rows where
// `cells` is absent (not just empty) — Mongoose's array default only applies to
// documents created after the schema changed, not to already-persisted embedded rows.
// Recomputes from each submission's CURRENT status, so a rejudge applied after the
// original finalization is reflected in the backfilled cells too — a finalized
// contest's numbers were never immutable against rejudges, and this keeps `cells`
// consistent with solvedCount/penaltyMinutes/rank instead of leaving it as the one
// field frozen at the old snapshot. Runs once per legacy contest, on first read after
// deploy; deliberately does not reuse tryFinalizeContest's grace-window/
// already-finalized guard, since that logic answers "should we finalize now?", a
// different question from "does this already-finalized doc need its cells backfilled?".
export async function backfillFinalStandingsCells(contestId: string): Promise<FinalStandingRow[]> {
  const contest = await Contest.findById(contestId).select('endAt').lean();
  if (!contest) return [];
  const rows = await computeStandings(contestId, contest.endAt);
  const finalStandings = await buildFinalStandingRows(rows);
  await Contest.updateOne({ _id: contestId, isFinalized: true }, { $set: { finalStandings } });
  return finalStandings;
}
