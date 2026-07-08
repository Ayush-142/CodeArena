import { Router } from 'express';
import { Problem } from '../models/Problem.js';
import { Submission } from '../models/Submission.js';
import { Hint } from '../models/Hint.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError, asyncHandler } from '../middleware/errors.js';

export const problemsRouter = Router();

problemsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const problems = await Problem.find({ isPublished: true })
      .select('title slug difficulty tags')
      .lean();
    res.json(problems);
  }),
);

// "My submissions for a problem" — scoped implicitly to req.user, so there's no other user's
// id in the URL to probe; unauthenticated correctly gets 401 (not 404) via requireAuth, since
// there's no existence-of-a-resource-by-id leak possible here (unlike GET /submissions/:id,
// where the 404-not-403 rule applies to avoid an id-oracle).
problemsRouter.get(
  '/:slug/submissions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const problem = await Problem.findOne({ slug: req.params.slug, isPublished: true }).select('_id').lean();
    if (!problem) {
      throw new AppError(404, 'NOT_FOUND', 'problem not found');
    }
    const submissions = await Submission.find({ userId: req.user!.userId, problemId: problem._id })
      .sort({ createdAt: -1 })
      .select('status createdAt execTimeMs language')
      .lean();
    res.json(submissions);
  }),
);

// "My hints for a problem" — unlock state is tracked per (userId, problemId), not
// per-submission (see hints/quota.ts and routes/hints.ts), so this is scoped by
// problem exactly like the neighboring /submissions route above, not by a specific
// submission id.
problemsRouter.get(
  '/:slug/hints',
  requireAuth,
  asyncHandler(async (req, res) => {
    const problem = await Problem.findOne({ slug: req.params.slug }).select('_id').lean();
    if (!problem) {
      throw new AppError(404, 'NOT_FOUND', 'problem not found');
    }
    const hints = await Hint.find({ userId: req.user!.userId, problemId: problem._id })
      .sort({ level: 1 })
      .select('level hintText')
      .lean();
    res.json(hints);
  }),
);

problemsRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const problem = await Problem.findOne({ slug: req.params.slug, isPublished: true })
      .select('slug title statementMd difficulty tags timeLimitMs memoryLimitMb samples')
      .lean();
    if (!problem) {
      throw new AppError(404, 'NOT_FOUND', 'not found');
    }
    res.json(problem);
  }),
);
