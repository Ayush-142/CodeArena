import { Router } from 'express';
import mongoose, { Types, type PipelineStage } from 'mongoose';
import { Submission } from '../models/Submission.js';
import { requireInternalToken } from '../middleware/internalToken.js';
import { AppError, asyncHandler } from '../middleware/errors.js';

export const internalContestsRouter = Router();

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 200;

interface AggregatedSubmission {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  problemId: Types.ObjectId;
  language: string;
  code: string;
}

/**
 * Phase 6: consumed by Nakalchi's integrations/codearena.ts. Only the fields
 * Nakalchi actually needs cross the trust boundary - no output/execTimeMs/
 * compileError/etc.
 *
 * Self-pair dedupe (plan review comment 6): Nakalchi's core package has no
 * concept of "user" at all - SubmissionInput passed into analyzeCorpus only
 * carries { id, language, source } - so it structurally cannot filter
 * same-user pairs. Without this endpoint deduping to one submission per
 * (userId, problemId) - the earliest AC - a user with two accepted
 * submissions on the same problem would pair with themselves at similarity
 * ~1.0 and show up as a false "flagged" plagiarism pair. This endpoint is
 * the only place that can prevent that.
 */
internalContestsRouter.get(
  '/contests/:id/submissions',
  requireInternalToken,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid contest id');
    }

    const { problemId, cursor, limit: limitRaw } = req.query as { problemId?: string; cursor?: string; limit?: string };
    if (problemId !== undefined && !mongoose.isValidObjectId(problemId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid problemId');
    }
    if (cursor !== undefined && !mongoose.isValidObjectId(cursor)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid cursor');
    }
    const requestedLimit = Number(limitRaw);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

    // Cursor filter applied AFTER grouping, not before: filtering on the raw
    // submission _id before grouping would incorrectly exclude a
    // not-yet-surfaced (userId, problemId) group whose winning (earliest
    // AC) submission happens to have a small _id, breaking pagination
    // stability across pages.
    const pipeline: PipelineStage[] = [
      {
        $match: {
          contestId: new Types.ObjectId(id),
          status: 'AC',
          ...(problemId ? { problemId: new Types.ObjectId(problemId) } : {}),
        },
      },
      { $sort: { userId: 1, problemId: 1, createdAt: 1 } },
      { $group: { _id: { userId: '$userId', problemId: '$problemId' }, doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { _id: 1 } },
    ];
    if (cursor !== undefined) {
      pipeline.push({ $match: { _id: { $gt: new Types.ObjectId(cursor) } } });
    }
    pipeline.push({ $limit: limit + 1 });

    const rows = await Submission.aggregate<AggregatedSubmission>(pipeline);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? String(page[page.length - 1]!._id) : null;

    res.json({
      submissions: page.map((s) => ({
        externalId: String(s._id),
        userRef: String(s.userId),
        problemRef: String(s.problemId),
        language: s.language,
        source: s.code,
      })),
      nextCursor,
    });
  }),
);
