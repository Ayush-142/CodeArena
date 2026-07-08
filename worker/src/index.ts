import 'dotenv/config'; // MUST be first: loads .env before redis.ts reads process.env.REDIS_URL
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { Submission } from './models/Submission.js';
import { Problem } from './models/Problem.js';
import { judge } from './judge.js';
import { redisUrl, redisClient } from './redis.js';
import { scoreContestSubmission } from './scoring.js';

interface SubmissionJobData {
  submissionId: string;
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

console.log('Worker started');
