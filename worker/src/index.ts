import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { createClient } from 'redis';
import { Submission } from './models/Submission.js';
import { Problem } from './models/Problem.js';
import { judge } from './judge.js';

dotenv.config();

interface SubmissionJobData {
  submissionId: string;
}

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

const publisher = createClient({ url: redisUrl });
await publisher.connect();

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

    await publisher.publish(
      'verdicts',
      JSON.stringify({ submissionId: job.data.submissionId, verdict: result.verdict }),
    );

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
