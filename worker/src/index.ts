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

const worker = new Worker<SubmissionJobData>(
  'submissions',
  async (job) => {
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
      'verdicts',
      JSON.stringify({
        submissionId: job.data.submissionId,
        userId: submission.userId.toString(),
        verdict: result.verdict,
      }),
    );

    // Contest scoring must never fail the judge job — a scoring bug shouldn't cause
    // BullMQ to re-run compile+sandbox+run for something that already has a verdict.
    // Any missed increment self-heals at the next leaderboard rebuild/finalization.
    try {
      await scoreContestSubmission(submission);
    } catch (err) {
      console.error(`[worker] contest scoring failed for submission ${submission._id.toString()}`, err);
    }

    return { verdict: result.verdict };
  },
  { connection: { url: redisUrl }, prefix: 'queue' },
);

worker.on('ready', () => {
  console.log('Worker ready');
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed`, err.message);
});

// Separate queue from `submissions` so a burst of Run requests can never delay real judging
// (or vice versa) — see ARCHITECTURE.md §5, "Run on samples". No `attempts` option is passed
// here or at the producer (api/src/routes/run.ts), so this defaults to BullMQ's attempts:1 —
// deliberately fail-fast rather than silently retrying; a re-click is the retry mechanism.
const runsWorker = new Worker<RunJobData>(
  'runs',
  async (job) => {
    const { runId, userId, problemId, code } = job.data;

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

    return { runId };
  },
  { connection: { url: redisUrl }, prefix: 'queue' },
);

runsWorker.on('ready', () => {
  console.log('Runs worker ready');
});

// Writes a terminal `failed` status so a client polling GET /api/run/:runId gets an answer
// instead of hanging in `running` until the 10-minute Redis TTL silently expires.
runsWorker.on('failed', (job, err) => {
  console.error(`Run job ${job?.id} failed`, err.message);
  if (!job?.data) return;
  const { runId, userId } = job.data;
  writeRunRecord({ runId, userId, status: 'failed', samples: [] })
    .then(() => redisClient.publish('ch:run', JSON.stringify({ runId, userId })))
    .catch((writeErr) => console.error(`[worker] failed to write failed-run record for ${runId}`, writeErr));
});

console.log('Worker started');
