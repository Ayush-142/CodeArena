import { Router } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Submission } from '../models/Submission.js';
import { Problem } from '../models/Problem.js';
import { submissionsQueue } from '../queue.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { AppError, asyncHandler, isMongoDuplicateKeyError } from '../middleware/errors.js';
import { SUBMISSION_RATE_WINDOWS } from '../config/rateLimits.js';

export const submissionsRouter = Router();

const submissionRateLimiter = rateLimit({
  keyPrefix: 'rl:sub',
  windows: SUBMISSION_RATE_WINDOWS,
  identify: (req) => req.user!.userId, // safe: requireAuth always runs first in the chain below
});

// Short-circuits exact retries BEFORE they hit the rate limiter. If this ran after the rate
// limiter instead, a fast retry with the same Idempotency-Key (exactly the case idempotency
// keys exist to handle — network timeout, double-click) would get rejected by the 1-per-10s
// submission limit instead of returning the original submissionId, breaking "a retry must be
// indistinguishable to the client".
const idempotencyShortCircuit = asyncHandler(async (req, res, next) => {
  const headerKey = req.get('Idempotency-Key');
  // TODO(frontend): once the frontend always sends Idempotency-Key, make the header required
  // and reject requests missing it instead of generating one server-side.
  req.idempotencyKey = headerKey && headerKey.trim().length > 0 ? headerKey.trim() : randomUUID();

  const existing = await Submission.findOne({ userId: req.user!.userId, idempotencyKey: req.idempotencyKey }).lean();
  if (existing) {
    res.status(202).json({ id: existing._id.toString() });
    return;
  }
  next();
});

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

submissionsRouter.post(
  '/',
  requireAuth,
  idempotencyShortCircuit,
  submissionRateLimiter,
  asyncHandler(async (req, res) => {
    const { problemSlug, code, language } = (req.body ?? {}) as {
      problemSlug?: unknown;
      code?: unknown;
      language?: unknown;
    };

    if (typeof problemSlug !== 'string' || problemSlug.trim().length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'problemSlug must be a non-empty string');
    }
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'code must be a non-empty string');
    }
    if (language !== 'cpp') {
      throw new AppError(400, 'VALIDATION_ERROR', "language must be 'cpp'");
    }

    const problem = await Problem.findOne({ slug: problemSlug, isPublished: true });
    if (!problem) {
      throw new AppError(404, 'NOT_FOUND', 'problem not found');
    }

    const userId = req.user!.userId;
    const idempotencyKey = req.idempotencyKey!;

    let submission;
    try {
      submission = await Submission.create({
        userId,
        problemId: problem._id,
        code,
        language,
        status: 'queued',
        idempotencyKey,
      });
    } catch (err) {
      // Race: two concurrent identical retries can both pass idempotencyShortCircuit's
      // findOne and both attempt this create. The {userId, idempotencyKey} unique index makes
      // the loser throw E11000 — re-fetch and return the winner's id instead of erroring, so
      // idempotency semantics hold even under concurrency.
      if (isMongoDuplicateKeyError(err)) {
        const winner = await Submission.findOne({ userId, idempotencyKey }).lean();
        if (winner) {
          res.status(202).json({ id: winner._id.toString() });
          return;
        }
      }
      throw err;
    }

    await submissionsQueue.add('judge', { submissionId: submission._id.toString() });
    res.status(202).json({ id: submission._id.toString() });
  }),
);

submissionsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid id');
    }
    const submission = await Submission.findById(id);
    // 404 (not 403) for both "doesn't exist" and "exists but isn't yours" so a submission id
    // can't be probed/enumerated via a 403-vs-404 status-code oracle.
    if (!submission || submission.userId.toString() !== req.user!.userId) {
      throw new AppError(404, 'NOT_FOUND', 'not found');
    }
    res.json(submission);
  }),
);
