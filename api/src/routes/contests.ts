import { Router } from 'express';
import mongoose from 'mongoose';
import { Contest } from '../models/Contest.js';
import { Problem } from '../models/Problem.js';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError, asyncHandler } from '../middleware/errors.js';
import { redisClient } from '../redis/client.js';
import { unpackScore, rebuildRedisLeaderboard, tryFinalizeContest } from '../contests/rebuild.js';

export const contestsRouter = Router();

type Phase = 'upcoming' | 'running' | 'ended';

function computePhase(startAt: Date, endAt: Date, now: number): Phase {
  if (now < startAt.getTime()) return 'upcoming';
  if (now <= endAt.getTime()) return 'running';
  return 'ended';
}

const PROBLEM_DETAIL_FIELDS = 'slug title statementMd difficulty tags timeLimitMs memoryLimitMb samples';

contestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const contests = await Contest.find({})
      .sort({ startAt: 1 })
      .select('title slug startAt endAt problemIds registeredUserIds')
      .lean();
    const userId = req.user?.userId;

    res.json({
      serverTime: Date.now(),
      contests: contests.map((c) => ({
        _id: c._id.toString(),
        slug: c.slug,
        title: c.title,
        startAt: c.startAt,
        endAt: c.endAt,
        problemCount: c.problemIds.length,
        isRegistered: userId ? c.registeredUserIds.some((rid) => rid.toString() === userId) : false,
      })),
    });
  }),
);

contestsRouter.post(
  '/:id/register',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid id');
    }
    const contest = await Contest.findById(id).select('startAt').lean();
    if (!contest) {
      throw new AppError(404, 'NOT_FOUND', 'contest not found');
    }
    if (Date.now() >= contest.startAt.getTime()) {
      throw new AppError(409, 'CONTEST_ALREADY_STARTED', 'registration closes once the contest starts');
    }

    // $addToSet makes this idempotent under a double-click/retry, same philosophy as
    // submission idempotency keys elsewhere in this codebase.
    await Contest.updateOne(
      { _id: id, registeredUserIds: { $ne: req.user!.userId } },
      { $addToSet: { registeredUserIds: req.user!.userId } },
    );
    res.json({ registered: true });
  }),
);

contestsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid id');
    }
    const contest = await Contest.findById(id).lean();
    if (!contest) {
      throw new AppError(404, 'NOT_FOUND', 'contest not found');
    }

    const now = Date.now();
    const phase = computePhase(contest.startAt, contest.endAt, now);
    const userId = req.user?.userId;
    const isRegistered = userId ? contest.registeredUserIds.some((rid) => rid.toString() === userId) : false;

    let problems: unknown[] = [];
    if (phase === 'running') {
      // Gating happens here, not on /api/problems/:slug — contest problems stay
      // isPublished:false until finalization, so the only path to their statements
      // during the contest is this denormalized embed, checked against registration.
      if (!req.user) {
        throw new AppError(401, 'UNAUTHENTICATED', 'authentication required to view a running contest');
      }
      if (!isRegistered) {
        throw new AppError(403, 'CONTEST_NOT_REGISTERED', 'you must register before the contest starts');
      }
      problems = await Problem.find({ _id: { $in: contest.problemIds } }).select(PROBLEM_DETAIL_FIELDS).lean();
    } else if (phase === 'ended') {
      // No registration check post-contest — problems are (or are becoming) public practice.
      problems = await Problem.find({ _id: { $in: contest.problemIds } }).select(PROBLEM_DETAIL_FIELDS).lean();
    }

    res.json({
      serverTime: now,
      contest: {
        _id: contest._id.toString(),
        slug: contest.slug,
        title: contest.title,
        startAt: contest.startAt,
        endAt: contest.endAt,
        isFinalized: contest.isFinalized,
      },
      phase,
      isRegistered,
      problems,
    });
  }),
);

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 100;

contestsRouter.get(
  '/:id/leaderboard',
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'invalid id');
    }
    const id = String(req.params.id);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(MAX_LEADERBOARD_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LEADERBOARD_LIMIT));

    let contest = await Contest.findById(id).lean();
    if (!contest) {
      throw new AppError(404, 'NOT_FOUND', 'contest not found');
    }

    const now = Date.now();
    if (now < contest.startAt.getTime()) {
      throw new AppError(400, 'CONTEST_NOT_STARTED', 'this contest has not started yet');
    }

    const userId = req.user?.userId;

    // Lazily finalize on first read after endAt (decision #6) — may flip isFinalized
    // mid-request, so re-read the contest doc if it just happened.
    if (!contest.isFinalized && now > contest.endAt.getTime()) {
      const justFinalized = await tryFinalizeContest(id);
      if (justFinalized) {
        contest = await Contest.findById(id).lean();
      }
    }

    if (contest!.isFinalized) {
      const standings = contest!.finalStandings;
      const rows = standings.slice(offset, offset + limit).map((s) => ({
        rank: s.rank,
        userId: s.userId.toString(),
        handle: s.handle,
        solvedCount: s.solvedCount,
        penaltyMinutes: s.penaltyMinutes,
      }));
      const mine = userId ? standings.find((s) => s.userId.toString() === userId) : undefined;
      res.json({
        serverTime: now,
        isFinalized: true,
        total: standings.length,
        rows,
        me: mine
          ? { rank: mine.rank, solvedCount: mine.solvedCount, penaltyMinutes: mine.penaltyMinutes }
          : null,
      });
      return;
    }

    const key = `lb:${id}`;
    // Self-healing Redis-flush recovery (decision #7): if the ZSET is missing, rebuild
    // it from Mongo via the same algorithm finalization uses, before serving this read.
    const exists = await redisClient.exists(key);
    if (!exists) {
      await rebuildRedisLeaderboard(id, contest!.endAt);
    }

    const total = await redisClient.zCard(key);
    const entries = await redisClient.zRangeWithScores(key, offset, offset + limit - 1, { REV: true });
    const userIds = entries.map((e) => String(e.value));
    const users = await User.find({ _id: { $in: userIds } }).select('handle').lean();
    const handleById = new Map(users.map((u) => [u._id.toString(), u.handle]));
    const rows = entries.map((e, i) => {
      const { solvedCount, penaltyMinutes } = unpackScore(e.score);
      return {
        rank: offset + i + 1,
        userId: String(e.value),
        handle: handleById.get(String(e.value)) ?? 'unknown',
        solvedCount,
        penaltyMinutes,
      };
    });

    let me = null;
    if (userId) {
      const rank = await redisClient.zRevRank(key, userId);
      const score = await redisClient.zScore(key, userId);
      if (rank !== null && score !== null) {
        const { solvedCount, penaltyMinutes } = unpackScore(score);
        me = { rank: rank + 1, solvedCount, penaltyMinutes };
      }
    }

    res.json({ serverTime: now, isFinalized: false, total, rows, me });
  }),
);
