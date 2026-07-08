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

export interface StandingsRow {
  userId: string;
  solvedCount: number;
  penaltyMinutes: number;
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

// Single linear pass over submissions sorted by (userId, problemId, createdAt) —
// deliberately not a Mongo aggregation pipeline, to stay simple/explainable. Walks
// consecutive (userId, problemId) runs, finds each group's first AC and counts
// qualifying wrong attempts (WA/TLE/MLE/RE, not CE) before it. Submissions still
// `queued`/`running` at read time simply match neither the AC nor wrong-attempt
// status sets, so they're silently skipped — no special-casing needed for in-flight
// jobs (this is what lets tryFinalizeContest finalize past its grace window even with
// a permanently-stuck job: that submission just contributes nothing here).
function scoreGroup(
  entries: { status: string; createdAt: Date }[],
  startAt: Date,
): { solved: boolean; penaltyMinutes: number } {
  let wrongCount = 0;
  for (const entry of entries) {
    if (entry.status === 'AC') {
      const minutes = Math.floor((entry.createdAt.getTime() - startAt.getTime()) / 60000);
      return { solved: true, penaltyMinutes: minutes + WRONG_ATTEMPT_PENALTY_MINUTES * wrongCount };
    }
    if (SCORED_WRONG_STATUSES.has(entry.status)) {
      wrongCount += 1;
    }
  }
  return { solved: false, penaltyMinutes: 0 };
}

export async function computeStandings(contestId: string, endAt: Date): Promise<StandingsRow[]> {
  const contest = await Contest.findById(contestId).select('startAt').lean();
  if (!contest) return [];

  const subs = await Submission.find({ contestId, createdAt: { $lte: endAt } })
    .sort({ userId: 1, problemId: 1, createdAt: 1 })
    .select('userId problemId status createdAt')
    .lean();

  const perUser = new Map<string, { solvedCount: number; penaltyMinutes: number }>();
  let groupKey: string | null = null;
  let groupUserId = '';
  let groupEntries: { status: string; createdAt: Date }[] = [];

  const flushGroup = () => {
    if (groupEntries.length === 0) return;
    const { solved, penaltyMinutes } = scoreGroup(groupEntries, contest.startAt);
    if (solved) {
      const existing = perUser.get(groupUserId) ?? { solvedCount: 0, penaltyMinutes: 0 };
      existing.solvedCount += 1;
      existing.penaltyMinutes += penaltyMinutes;
      perUser.set(groupUserId, existing);
    }
    groupEntries = [];
  };

  for (const sub of subs) {
    const key = `${sub.userId.toString()}:${sub.problemId.toString()}`;
    if (key !== groupKey) {
      flushGroup();
      groupKey = key;
      groupUserId = sub.userId.toString();
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
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('handle').lean();
  const handleById = new Map(users.map((u) => [u._id.toString(), u.handle]));
  const finalStandings = rows.map((r, i) => ({
    userId: r.userId,
    handle: handleById.get(r.userId) ?? 'unknown',
    solvedCount: r.solvedCount,
    penaltyMinutes: r.penaltyMinutes,
    rank: i + 1,
  }));

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
