import type { HydratedDocument } from 'mongoose';
import { Submission, SubmissionDoc } from './models/Submission.js';
import { Contest } from './models/Contest.js';
import { redisClient } from './redis.js';

// ZSET score packing (see ARCHITECTURE.md §7 / Phase 5 plan decision #2):
//   score = solvedCount * MULTIPLIER - penaltyMinutes
// Additive per solved problem because the total is linear in per-problem contributions:
// each first-AC event applies one ZINCRBY of (MULTIPLIER - penaltyForThatProblem), and
// summing those across a user's solved problems reconstructs the formula above exactly.
// Decode (done on the read side, api/src/contests/rebuild.ts unpackScore):
//   solvedCount = Math.ceil(score / MULTIPLIER)  — NOT Math.floor; see unpackScore's
//   comment for why floor silently under-counts solvedCount by 1 whenever penalty > 0.
//   penaltyMinutes = solvedCount * MULTIPLIER - score
// Assumption, safe for any real contest: total penalty stays under MULTIPLIER minutes.
const MULTIPLIER = 1e7;

// Wrong-attempt penalty per ICPC/Codeforces convention. CE deliberately excluded —
// a compile error isn't a "wrong answer attempt" under this scoring scheme.
const SCORED_WRONG_STATUSES = ['WA', 'TLE', 'MLE', 'RE'];
const WRONG_ATTEMPT_PENALTY_MINUTES = 20;

// Called once per judged submission, right after the worker writes the verdict.
// Only ever acts on contest submissions whose verdict is AC — everything else is a
// no-op by design (wrong attempts are folded into the eventual AC's penalty, not
// scored individually; see the plan's scoring-formula decision).
export async function scoreContestSubmission(submission: HydratedDocument<SubmissionDoc>): Promise<void> {
  if (!submission.contestId || submission.status !== 'AC') return;

  // Idempotency guard against BullMQ retry / stalled-job re-pickup: claims this
  // submission for scoring exactly once. If a retry lands here after a prior attempt
  // already flipped this flag, this update matches nothing and we skip — no double
  // ZINCRBY. (Known gap: a crash between this claim succeeding and the ZINCRBY below
  // would under-count once; accepted, self-heals at the next rebuild/finalization,
  // which recompute standings from final on-disk submission statuses, not from this
  // flag or live Redis state.)
  const claimed = await Submission.findOneAndUpdate(
    { _id: submission._id, contestScored: { $ne: true } },
    { $set: { contestScored: true } },
  );
  if (!claimed) return;

  const contest = await Contest.findById(submission.contestId).select('startAt endAt isFinalized').lean();
  if (!contest) return;
  // Defensive belt-and-suspenders: the API's gating check (routes/submissions.ts)
  // already refuses to create a contest submission once the contest isn't "running",
  // so createdAt should never exceed endAt in practice. Kept here in case that
  // invariant is ever violated by a future code path.
  if (submission.createdAt.getTime() > contest.endAt.getTime()) return;
  if (contest.isFinalized) return;

  // Known race, not fixed here: if two ACs for the same (user, problem) are judged
  // concurrently by two workers, this check can run for the later one while the
  // earlier one is still `status:"running"` (not yet AC), find nothing, and score —
  // then the earlier one lands and scores too, transiently double-counting
  // solvedCount on the live ZSET. Accepted: self-heals at the next rebuild/finalize
  // pass, since computeStandings always recomputes "first AC" from final on-disk
  // statuses, not from live ZINCRBY history. See the plan's edge-case table.
  const earlierAc = await Submission.exists({
    contestId: submission.contestId,
    userId: submission.userId,
    problemId: submission.problemId,
    status: 'AC',
    createdAt: { $lt: submission.createdAt },
  });
  if (earlierAc) return; // not the first AC for this (user, problem) — no-op

  const wrongCount = await Submission.countDocuments({
    contestId: submission.contestId,
    userId: submission.userId,
    problemId: submission.problemId,
    status: { $in: SCORED_WRONG_STATUSES },
    createdAt: { $lt: submission.createdAt },
  });

  const minutes = Math.floor((submission.createdAt.getTime() - contest.startAt.getTime()) / 60000);
  const penaltyMinutes = minutes + WRONG_ATTEMPT_PENALTY_MINUTES * wrongCount;
  const scoreDelta = MULTIPLIER - penaltyMinutes;

  await redisClient.zIncrBy(`lb:${submission.contestId.toString()}`, scoreDelta, submission.userId.toString());
  await redisClient.publish('ch:leaderboard', JSON.stringify({ contestId: submission.contestId.toString() }));
}
