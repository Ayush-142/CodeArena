import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { createClient } from 'redis';
import { Submission } from './models/Submission.js';
import { runInSandbox } from './sandbox.js';
import { HARDCODED_TEST_CASE } from './testcase.js';

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

    const result = await runInSandbox(
      submission.code,
      HARDCODED_TEST_CASE.input,
      HARDCODED_TEST_CASE.expectedOutput,
    );

    submission.status = result.verdict;
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
