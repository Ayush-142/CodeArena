import { Contest } from '../models/Contest.js';
import { Problem, type ProblemDoc } from '../models/Problem.js';
import { AppError } from '../middleware/errors.js';
import type { HydratedDocument } from 'mongoose';

// Extracted verbatim from the submissions route (behavior-preserving) so it can be shared
// with POST /api/run without the two routes drifting on this security-sensitive gating.
// Contest problems stay isPublished:false until finalization (see contests/rebuild.ts) — the
// only legitimate path to one during a running contest is registration + the contest actually
// being in its running window, checked here.
export async function resolveGatedProblem(
  problemSlug: string,
  contestId: string | undefined,
  userId: string,
): Promise<HydratedDocument<ProblemDoc>> {
  if (contestId) {
    const contest = await Contest.findById(contestId).select('startAt endAt registeredUserIds problemIds').lean();
    if (!contest) {
      throw new AppError(404, 'NOT_FOUND', 'contest not found');
    }
    const now = Date.now();
    if (now < contest.startAt.getTime() || now > contest.endAt.getTime()) {
      throw new AppError(409, 'CONTEST_NOT_RUNNING', 'this contest is not currently running');
    }
    if (!contest.registeredUserIds.some((rid) => rid.toString() === userId)) {
      throw new AppError(403, 'CONTEST_NOT_REGISTERED', 'you must be registered for this contest');
    }
    // Deliberately not filtered by isPublished:true — contest problems stay
    // unpublished until finalization (see api/src/contests/rebuild.ts).
    const problem = await Problem.findOne({ slug: problemSlug, _id: { $in: contest.problemIds } });
    if (!problem) {
      throw new AppError(404, 'NOT_FOUND', 'problem not found');
    }
    return problem;
  }

  const problem = await Problem.findOne({ slug: problemSlug, isPublished: true });
  if (!problem) {
    throw new AppError(404, 'NOT_FOUND', 'problem not found');
  }
  return problem;
}
