import { Router } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { runsQueue } from '../queue.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { AppError, asyncHandler } from '../middleware/errors.js';
import { RUN_RATE_WINDOWS } from '../config/rateLimits.js';
import { validateCodeSubmission } from '../validation.js';
import { resolveGatedProblem } from '../contests/resolveGatedProblem.js';
import { writeRunRecord, readRunRecord } from '../redis/runStore.js';

export const runRouter = Router();

const runRateLimiter = rateLimit({
  keyPrefix: 'rl:run',
  windows: RUN_RATE_WINDOWS,
  identify: (req) => req.user!.userId, // safe: requireAuth always runs first in the chain below
});

runRouter.post(
  '/',
  requireAuth,
  runRateLimiter,
  asyncHandler(async (req, res) => {
    const { problemSlug, code, language, contestId } = (req.body ?? {}) as {
      problemSlug?: unknown;
      code?: unknown;
      language?: unknown;
      contestId?: unknown;
    };

    if (typeof problemSlug !== 'string' || problemSlug.trim().length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'problemSlug must be a non-empty string');
    }
    if (contestId !== undefined && (typeof contestId !== 'string' || !mongoose.isValidObjectId(contestId))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'contestId must be a valid id');
    }
    const validated = validateCodeSubmission({ code, language });

    const userId = req.user!.userId;
    // Same gating as POST /api/submissions — a contest problem stays unpublished until
    // finalization; the only legitimate path to it is registration + the running phase.
    const problem = await resolveGatedProblem(problemSlug, contestId, userId);

    const runId = randomUUID(); // deliberately not an ObjectId — never confusable with a submission id
    await writeRunRecord({ runId, userId, status: 'queued', samples: [] });

    await runsQueue.add('run', {
      runId,
      userId,
      problemId: problem._id.toString(),
      code: validated.code,
      language: validated.language,
    });

    res.status(202).json({ runId });
  }),
);

runRouter.get(
  '/:runId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const runId = String(req.params.runId);
    const record = await readRunRecord(runId);
    // 404 (not 403) for both "doesn't exist/expired" and "exists but isn't yours" — same
    // anti-enumeration posture as GET /api/submissions/:id.
    if (!record || record.userId !== req.user!.userId) {
      throw new AppError(404, 'NOT_FOUND', 'not found');
    }
    res.json({
      runId: record.runId,
      status: record.status,
      compileError: record.compileError,
      samples: record.samples,
    });
  }),
);
