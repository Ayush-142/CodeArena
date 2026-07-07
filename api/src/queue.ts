import { Queue } from 'bullmq';

export interface SubmissionJobData {
  submissionId: string;
}

const connection = { url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' };

export const submissionsQueue = new Queue<SubmissionJobData>('submissions', {
  connection,
  prefix: 'queue',
});
