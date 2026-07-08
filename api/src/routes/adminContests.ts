import { Router } from 'express';
import mongoose from 'mongoose';
import { Contest } from '../models/Contest.js';
import { Problem } from '../models/Problem.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { AppError, asyncHandler, isMongoDuplicateKeyError } from '../middleware/errors.js';

export const adminContestsRouter = Router();

function parseProblemIds(problemIds: unknown): string[] {
  if (!Array.isArray(problemIds) || problemIds.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'problemIds must be a non-empty array');
  }
  for (const id of problemIds) {
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'problemIds must all be valid ids');
    }
  }
  return problemIds as string[];
}

async function assertProblemsUsable(problemIds: string[]): Promise<void> {
  const problems = await Problem.find({ _id: { $in: problemIds } }).select('isPublished').lean();
  if (problems.length !== problemIds.length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'one or more problemIds do not exist');
  }
  // A practice problem that's already public shouldn't silently become contest-gated —
  // the finalize-time isPublished:true flip (see contests/rebuild.ts) would then be a
  // confusing no-op for it.
  if (problems.some((p) => p.isPublished)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'problemIds must not include already-published problems');
  }
}

adminContestsRouter.post(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { title, slug, startAt, endAt, problemIds } = (req.body ?? {}) as {
      title?: unknown;
      slug?: unknown;
      startAt?: unknown;
      endAt?: unknown;
      problemIds?: unknown;
    };

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'title must be a non-empty string');
    }
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'slug must be a non-empty string');
    }
    const startDate = new Date(startAt as string);
    const endDate = new Date(endAt as string);
    if (typeof startAt !== 'string' || Number.isNaN(startDate.getTime())) {
      throw new AppError(400, 'VALIDATION_ERROR', 'startAt must be a parseable date');
    }
    if (typeof endAt !== 'string' || Number.isNaN(endDate.getTime())) {
      throw new AppError(400, 'VALIDATION_ERROR', 'endAt must be a parseable date');
    }
    if (endDate.getTime() <= startDate.getTime()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'endAt must be after startAt');
    }
    const ids = parseProblemIds(problemIds);
    await assertProblemsUsable(ids);

    let contest;
    try {
      contest = await Contest.create({
        title,
        slug,
        startAt: startDate,
        endAt: endDate,
        problemIds: ids,
        registeredUserIds: [],
      });
    } catch (err) {
      if (isMongoDuplicateKeyError(err)) {
        throw new AppError(409, 'CONFLICT', 'a contest with this slug already exists');
      }
      throw err;
    }

    res.status(201).json({ id: contest._id.toString() });
  }),
);

adminContestsRouter.put(
  '/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid id');
    }
    const contest = await Contest.findById(id);
    if (!contest) {
      throw new AppError(404, 'NOT_FOUND', 'contest not found');
    }
    if (contest.isFinalized) {
      throw new AppError(409, 'CONTEST_FINALIZED', 'a finalized contest cannot be edited');
    }

    const { title, startAt, endAt, problemIds } = (req.body ?? {}) as {
      title?: unknown;
      startAt?: unknown;
      endAt?: unknown;
      problemIds?: unknown;
    };

    const contestHasStarted = Date.now() >= contest.startAt.getTime();

    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim().length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'title must be a non-empty string');
      }
      contest.title = title;
    }

    if (startAt !== undefined) {
      if (contestHasStarted) {
        throw new AppError(409, 'CONTEST_ALREADY_STARTED', 'startAt is only editable before the contest starts');
      }
      const startDate = new Date(startAt as string);
      if (typeof startAt !== 'string' || Number.isNaN(startDate.getTime())) {
        throw new AppError(400, 'VALIDATION_ERROR', 'startAt must be a parseable date');
      }
      contest.startAt = startDate;
    }

    if (problemIds !== undefined) {
      if (contestHasStarted) {
        throw new AppError(409, 'CONTEST_ALREADY_STARTED', 'problemIds is only editable before the contest starts');
      }
      const ids = parseProblemIds(problemIds);
      await assertProblemsUsable(ids);
      contest.problemIds = ids as unknown as typeof contest.problemIds;
    }

    if (endAt !== undefined) {
      const endDate = new Date(endAt as string);
      if (typeof endAt !== 'string' || Number.isNaN(endDate.getTime())) {
        throw new AppError(400, 'VALIDATION_ERROR', 'endAt must be a parseable date');
      }
      if (endDate.getTime() <= contest.startAt.getTime()) {
        throw new AppError(400, 'VALIDATION_ERROR', 'endAt must be after startAt');
      }
      contest.endAt = endDate;
    }

    await contest.save();
    res.json(contest);
  }),
);
