import 'dotenv/config'; // MUST be first: loads .env before redis.ts reads process.env.REDIS_URL
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { Submission } from './models/Submission.js';
import { Problem } from './models/Problem.js';
import { judge } from './judge.js';
import { redisUrl, redisClient } from './redis.js';
import { scoreContestSubmission } from './scoring.js';
import { runSamples } from './run.js';
import { writeRunRecord } from './runStore.js';
import { recordVerdict, recordRun, recordJudgeLatency, startWorkerHeartbeat } from './metrics.js';
import { logger } from './logger.js';

interface SubmissionJobData {
  submissionId: string;
}

// No submissionId — a run never creates a Submission document, so there's nothing to
// re-read from Mongo except the Problem itself. Mirrors api/src/queue.ts's RunJobData.
interface RunJobData {
  runId: string;
  userId: string;
  problemId: string;
  code: string;
  language: 'cpp';
}

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

// Phase 6: dynamic import (not a static one alongside the imports above) so
// its module-level `new Worker(...)` call - which immediately starts
// consuming the `integrity` queue - only runs after mongoose has connected,
// matching the execution order the submissions/runs workers below get for
// free by being defined textually after the same await.
await import('./integrity.js');

const worker = new Worker<SubmissionJobData>(
  'submissions',
  async (job) => {
    // Bound once per job — every log line below carries submissionId, the correlation id
    // threaded across api/worker/socket logs for this submission (ARCHITECTURE.md §13).
    const log = logger.child({ submissionId: job.data.submissionId });

    const submission = await Submission.findById(job.data.submissionId);
    if (!submission) {
      throw new Error(`submission ${job.data.submissionId} not found`);
    }

    submission.status = 'running';
    await submission.save();

    const problem = await Problem.findById(submission.problemId);
    if (!problem) {
      throw new Error(`problem ${submission.problemId} not found`);
    }

    const result = await judge(submission.code, problem);

    submission.status = result.verdict;
    submission.failedTestIndex = result.failedTestIndex;
    submission.execTimeMs = result.execTimeMs;
    submission.output = result.output;
    submission.compileError = result.compileError;
    await submission.save();

    await redisClient.publish(
      'ch:verdicts',
      JSON.stringify({
        submissionId: job.data.submissionId,
        userId: submission.userId.toString(),
        verdict: result.verdict,
      }),
    );

    log.info({ verdict: result.verdict, execTimeMs: result.execTimeMs }, 'verdict recorded');

    // Metrics must never fail the judge job — same posture as contest scoring below.
    try {
      await recordVerdict(result.verdict);
      await recordJudgeLatency(job.timestamp);
    } catch (err) {
      log.error({ err }, 'metrics recording failed');
    }

    // Contest scoring must never fail the judge job — a scoring bug shouldn't cause
    // BullMQ to re-run compile+sandbox+run for something that already has a verdict.
    // Any missed increment self-heals at the next leaderboard rebuild/finalization.
    try {
      await scoreContestSubmission(submission);
    } catch (err) {
      log.error({ err }, 'contest scoring failed');
    }

    return { verdict: result.verdict };
  },
  { connection: { url: redisUrl }, prefix: 'queue' },
);

worker.on('ready', () => {
  logger.info('Worker ready');
});

worker.on('failed', (job, err) => {
  logger.error({ submissionId: job?.data.submissionId, err: err.message }, 'judge job failed');
});

// Separate queue from `submissions` so a burst of Run requests can never delay real judging
// (or vice versa) — see ARCHITECTURE.md §5, "Run on samples". No `attempts` option is passed
// here or at the producer (api/src/routes/run.ts), so this defaults to BullMQ's attempts:1 —
// deliberately fail-fast rather than silently retrying; a re-click is the retry mechanism.
const runsWorker = new Worker<RunJobData>(
  'runs',
  async (job) => {
    const { runId, userId, problemId, code } = job.data;
    // Bound once per job — mirrors the judge worker's submissionId-scoped child logger above.
    const log = logger.child({ runId });

    await writeRunRecord({ runId, userId, status: 'running', samples: [] });

    const problem = await Problem.findById(problemId);
    if (!problem) {
      throw new Error(`problem ${problemId} not found`);
    }

    const result = await runSamples(code, problem);

    await writeRunRecord({
      runId,
      userId,
      status: 'done',
      compileError: result.compileError,
      samples: result.samples,
    });

    await redisClient.publish('ch:run', JSON.stringify({ runId, userId }));

    log.info('run completed');

    try {
      await recordRun();
    } catch (err) {
      log.error({ err }, 'metrics recording failed');
    }

    return { runId };
  },
  { connection: { url: redisUrl }, prefix: 'queue' },
);

runsWorker.on('ready', () => {
  logger.info('Runs worker ready');
});

// Writes a terminal `failed` status so a client polling GET /api/run/:runId gets an answer
// instead of hanging in `running` until the 10-minute Redis TTL silently expires.
runsWorker.on('failed', (job, err) => {
  logger.error({ runId: job?.data.runId, err: err.message }, 'run job failed');
  if (!job?.data) return;
  const { runId, userId } = job.data;
  writeRunRecord({ runId, userId, status: 'failed', samples: [] })
    .then(() => redisClient.publish('ch:run', JSON.stringify({ runId, userId })))
    .catch((writeErr) => logger.error({ runId, err: writeErr }, 'failed to write failed-run record'));
});

startWorkerHeartbeat();

logger.info('Worker started');
