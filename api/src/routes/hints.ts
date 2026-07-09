import { Router } from 'express';
import mongoose from 'mongoose';
import { ApiError } from '@google/genai';
import { Submission } from '../models/Submission.js';
import { Problem } from '../models/Problem.js';
import { Contest } from '../models/Contest.js';
import { Hint } from '../models/Hint.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { AppError, asyncHandler, isMongoDuplicateKeyError } from '../middleware/errors.js';
import { HINT_ANTI_SPAM_WINDOWS } from '../config/rateLimits.js';
import { computePhase } from './contests.js';
import { env } from '../config/env.js';
import { redisClient } from '../redis/client.js';
import { getObjectText } from '../storage.js';
import { generateHint, computeFailureSignature } from '../hints/llm.js';
import {
  tryConsumeDailyHint,
  refundDailyHint,
  hintsRemainingToday,
  tryConsumeGlobalHintSlot,
  refundGlobalHintSlot,
  tryConsumeGlobalDailyHintSlot,
  refundGlobalDailyHintSlot,
} from '../hints/quota.js';
import { recordHintTokens, recordHintCacheHit, recordHintCacheMiss } from '../metrics.js';
import { logger } from '../logger.js';

export const hintsRouter = Router();

const ELIGIBLE_VERDICTS = ['WA', 'TLE', 'RE', 'MLE'];
const MAX_TEST_INPUT_BYTES = 500;

const hintAntiSpamLimiter = rateLimit({
  keyPrefix: 'rl:hint',
  windows: HINT_ANTI_SPAM_WINDOWS,
  // Safe: requireAuth + body validation already ran by the time this middleware executes.
  identify: (req) => `${req.user!.userId}:${req.body?.submissionId}:${req.body?.level}`,
});

hintsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { submissionId, level } = (req.body ?? {}) as { submissionId?: unknown; level?: unknown };

    if (typeof submissionId !== 'string' || !mongoose.isValidObjectId(submissionId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'submissionId must be a valid id');
    }
    if (level !== 1 && level !== 2 && level !== 3) {
      throw new AppError(400, 'VALIDATION_ERROR', 'level must be 1, 2, or 3');
    }
    const userId = req.user!.userId;

    const submission = await Submission.findById(submissionId);
    // 404 (not 403) for both "doesn't exist" and "exists but isn't yours" — same
    // id-oracle-avoidance rule as GET /api/submissions/:id.
    if (!submission || submission.userId.toString() !== userId) {
      throw new AppError(404, 'NOT_FOUND', 'submission not found');
    }

    if (!ELIGIBLE_VERDICTS.includes(submission.status)) {
      throw new AppError(400, 'HINT_VERDICT_NOT_ELIGIBLE', 'hints are only available for WA/TLE/RE/MLE submissions');
    }

    if (submission.contestId) {
      const contest = await Contest.findById(submission.contestId).select('startAt endAt').lean();
      if (contest && computePhase(contest.startAt, contest.endAt, Date.now()) === 'running') {
        throw new AppError(403, 'HINT_DISABLED_DURING_CONTEST', 'hints are disabled while the contest is running');
      }
    }

    const problemId = submission.problemId;

    if (level > 1) {
      const hasPrevious = await Hint.exists({ userId, problemId, level: level - 1 });
      if (!hasPrevious) {
        throw new AppError(409, 'HINT_LEVEL_LOCKED', `reveal level ${level - 1} before requesting level ${level}`);
      }
    }

    const existing = await Hint.findOne({ userId, problemId, level });
    if (existing) {
      res.json({ available: true, ...existing.toObject(), hintsRemainingToday: await hintsRemainingToday(userId) });
      return;
    }

    // Invoked directly (not mounted in the route's middleware chain) so the
    // idempotent short-circuit above can skip rate-limiting entirely — a normal
    // Express middleware chain has no way to conditionally skip a later middleware.
    // On rejection this throws an AppError, which the surrounding asyncHandler
    // forwards to the real Express `next` via its .catch(next), reaching
    // errorHandler exactly as if the middleware had been mounted normally.
    await new Promise<void>((resolve, reject) => {
      hintAntiSpamLimiter(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
    });

    // Per-user daily cap is consumed regardless of cache hit/miss below — it's a fair-use
    // control on the USER's unlock count, unrelated to protecting Gemini's own quota.
    const dailyToken = await tryConsumeDailyHint(userId);
    if (!dailyToken) {
      throw new AppError(429, 'RATE_LIMITED', 'daily hint limit reached', { retryAfterMs: 24 * 60 * 60 * 1000 });
    }

    const problem = await Problem.findById(problemId);
    if (!problem) {
      await refundDailyHint(userId, dailyToken);
      throw new AppError(404, 'NOT_FOUND', 'problem not found');
    }

    const failureSig = computeFailureSignature(
      submission.status,
      submission.failedTestIndex ?? undefined,
      submission.code,
    );
    const cacheKey = `cache:hint:${problemId}:${level}:${failureSig}`;

    let hintText: string;
    let tokensUsed: number;

    const cached = await redisClient.get(cacheKey);
    if (cached) {
      // Cache hit calls Gemini zero times — deliberately does NOT touch the global RPM/daily
      // quotas below, which exist only to protect actual Gemini calls. Wasting scarce global
      // daily quota (confirmed at just 20/day/project) on a cache hit would be a real bug now
      // that the true limit is known.
      hintText = cached;
      tokensUsed = 0; // no LLM tokens spent producing this record — see decision 19
      await recordHintCacheHit();
    } else {
      await recordHintCacheMiss();
      const globalToken = await tryConsumeGlobalHintSlot(env.hintGlobalRpmLimit);
      if (!globalToken) {
        await refundDailyHint(userId, dailyToken);
        res.json({ available: false, message: 'hints are unavailable right now' });
        return;
      }

      // Confirmed via a live 429 during testing: Google's actual free-tier cap for
      // gemini-2.5-flash-lite is 20 requests/day/project — the per-minute check above does
      // nothing to protect that. Checked last among the quota gates since it's the tightest.
      const globalDailyToken = await tryConsumeGlobalDailyHintSlot(env.hintGlobalDailyLimit);
      if (!globalDailyToken) {
        await refundDailyHint(userId, dailyToken);
        await refundGlobalHintSlot(globalToken);
        res.json({ available: false, message: 'hints are unavailable right now' });
        return;
      }

      let failedTestInput: string | null = null;
      const testcase =
        typeof submission.failedTestIndex === 'number' ? problem.testcases[submission.failedTestIndex] : undefined;
      if (testcase) {
        try {
          const raw = await getObjectText(testcase.inputKey);
          failedTestInput = Buffer.byteLength(raw, 'utf8') <= MAX_TEST_INPUT_BYTES ? raw : null;
        } catch {
          failedTestInput = null; // unavailable — degrade to omitted, not a hard failure
        }
      }

      try {
        const result = await generateHint({
          userId,
          submissionId,
          problemId: problemId.toString(),
          level,
          problemStatement: problem.statementMd,
          code: submission.code,
          verdict: submission.status,
          failedTestInput,
        });
        hintText = result.hintText;
        tokensUsed = result.tokensUsed;
        await redisClient.set(cacheKey, hintText); // content-addressed — no TTL needed
        await recordHintTokens(tokensUsed);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          logger.error(
            { submissionId, err: err.message },
            '[hints] Gemini RESOURCE_EXHAUSTED — global limiter may be set too high',
          );
        } else {
          logger.error({ submissionId, err }, '[hints] generateHint failed');
        }
        await refundDailyHint(userId, dailyToken);
        await refundGlobalHintSlot(globalToken);
        await refundGlobalDailyHintSlot(globalDailyToken);
        res.json({ available: false, message: 'hints are unavailable right now' });
        return;
      }
    }

    let hint;
    try {
      hint = await Hint.create({
        userId,
        problemId,
        submissionId,
        level,
        promptContextHash: failureSig,
        hintText,
        tokensUsed,
      });
    } catch (err) {
      // Race: a concurrent first-time request for the same level won. Re-fetch and
      // serve the winner's doc — same idempotency-race pattern as submissions.ts.
      if (isMongoDuplicateKeyError(err)) {
        const winner = await Hint.findOne({ userId, problemId, level });
        if (winner) {
          res.json({ available: true, ...winner.toObject(), hintsRemainingToday: await hintsRemainingToday(userId) });
          return;
        }
      }
      throw err;
    }

    res.status(201).json({ available: true, ...hint.toObject(), hintsRemainingToday: await hintsRemainingToday(userId) });
  }),
);
