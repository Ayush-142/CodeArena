import { Queue } from 'bullmq';

export interface SubmissionJobData {
  submissionId: string;
}

// No submissionId — a run never creates a Submission document (see ARCHITECTURE.md §5's
// "Run on samples" subsection), so the worker has nothing to re-read from Mongo and the job
// must carry code/language inline instead. A deliberate, scoped exception to "job payload
// carries only an id", not a precedent for the judge queue.
export interface RunJobData {
  runId: string;
  userId: string;
  problemId: string;
  code: string;
  language: 'cpp';
}

// enableOfflineQueue:false makes ioredis reject a command immediately when the connection is
// down, instead of its default behavior (buffer the command in memory and wait indefinitely for
// reconnection before sending it) — confirmed empirically: without this, submissionsQueue.add()
// hung for minutes with Redis stopped, rather than rejecting, defeating the try/catch fallback
// in routes/submissions.ts that's supposed to degrade gracefully (ARCHITECTURE.md §11). Only
// affects behavior while disconnected; no effect on the healthy-connection path.
const connection = { url: process.env.REDIS_URL || 'redis://127.0.0.1:6379', enableOfflineQueue: false };

export const submissionsQueue = new Queue<SubmissionJobData>('submissions', {
  connection,
  prefix: 'queue',
});

// Separate from `submissions` so a burst of Run requests can never delay real judging (or vice
// versa) — see the Run-on-samples plan's Transport section for the full rationale.
export const runsQueue = new Queue<RunJobData>('runs', {
  connection,
  prefix: 'queue',
});

export interface IntegrityJobData {
  contestId: string;
}

// Phase 6 (Nakalchi integration): "the enqueue is fire-and-forget with its own
// retry" (ARCHITECTURE.md §5 Phase 6 item 3). Verified against the actually-
// installed bullmq package (node_modules/bullmq/dist/esm/classes/job.js's
// shouldRetryJob: `this.attemptsMade + 1 < this.opts.attempts` — `1 < undefined`
// is false, so BullMQ does NOT retry by default) — attempts/backoff must be
// explicit here or there is no retry at all. 5s base matches Nakalchi's own
// JOB_BACKOFF_BASE_MS (packages/service/src/queue/queues.ts) — same kind of
// workload (an HTTP call to a service that might be transiently down).
export const integrityQueue = new Queue<IntegrityJobData>('integrity', {
  connection,
  prefix: 'queue',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  },
});
