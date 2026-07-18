import { Worker } from 'bullmq';
import { Contest } from './models/Contest.js';
import { redisUrl } from './redis.js';
import { logger } from './logger.js';

// Mirrors api/src/queue.ts's IntegrityJobData - duplicated per this repo's established
// api/worker model-duplication convention (see contests/rebuild.ts's MULTIPLIER comment).
interface IntegrityJobData {
  contestId: string;
}

const nakalchiApiBaseUrl = process.env.NAKALCHI_API_BASE_URL;
const nakalchiApiKey = process.env.NAKALCHI_API_KEY;
const internalWebhookCallbackUrl = process.env.INTERNAL_WEBHOOK_CALLBACK_URL;

/**
 * Phase 6 adapter: consumes the `integrity` queue (enqueued from
 * contests/rebuild.ts's tryFinalizeContest) and calls Nakalchi's
 * POST /analyses in pull mode.
 *
 * Duplicate-analysis guard: if a previous attempt of THIS job already got as
 * far as recording an analysisId (whether pending, completed, or failed),
 * skip re-POSTing - BullMQ retries reuse the same job, so without this guard
 * a crash between receiving the 202 and saving `integrityAnalysis` would
 * cause the next retry to create a second, orphaned analysis on Nakalchi.
 * This closes the race for any retry after a full success OR after the
 * fetch itself failed; it does not eliminate the sub-millisecond window
 * between the 202 response and `contest.save()` completing - accepted as a
 * known, narrow, documented edge case (see README's failure-isolation
 * section), consistent with this system's existing at-least-once posture
 * (e.g. scoring.ts's own "must never fail the job, self-heals" comment).
 */
export const integrityWorker = new Worker<IntegrityJobData>(
  'integrity',
  async (job) => {
    const log = logger.child({ contestId: job.data.contestId });

    if (!nakalchiApiBaseUrl || !nakalchiApiKey || !internalWebhookCallbackUrl) {
      // Mirrors api/src/config/env.ts's fail-fast check - this job should
      // never be enqueued with INTEGRITY_ANALYSIS_ENABLED off, but guard
      // here too in case the worker process has a stale/partial config.
      throw new Error('NAKALCHI_API_BASE_URL / NAKALCHI_API_KEY / INTERNAL_WEBHOOK_CALLBACK_URL not configured');
    }

    const contest = await Contest.findById(job.data.contestId);
    if (!contest) {
      throw new Error(`contest ${job.data.contestId} not found`);
    }

    if (contest.integrityAnalysis?.analysisId) {
      log.info({ analysisId: contest.integrityAnalysis.analysisId }, 'integrity analysis already recorded, skipping re-POST');
      return;
    }

    const res = await fetch(`${nakalchiApiBaseUrl}/api/v1/analyses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': nakalchiApiKey },
      body: JSON.stringify({
        source: 'codearena',
        contestId: contest._id.toString(),
        problemIds: contest.problemIds.map((id) => id.toString()),
        callbackUrl: internalWebhookCallbackUrl,
      }),
    });
    if (!res.ok) {
      throw new Error(`Nakalchi POST /analyses failed: ${res.status}`);
    }
    const { analysisId } = (await res.json()) as { analysisId: string };

    // Written immediately, no intervening awaits - narrows the crash window
    // described above to essentially zero without eliminating it.
    contest.integrityAnalysis = { analysisId, status: 'pending', updatedAt: new Date() };
    await contest.save();

    log.info({ analysisId }, 'submitted contest for integrity analysis');
  },
  { connection: { url: redisUrl }, prefix: 'queue' },
);

integrityWorker.on('ready', () => {
  logger.info('Integrity worker ready');
});

integrityWorker.on('failed', (job, err) => {
  logger.error({ contestId: job?.data.contestId, err: err.message }, 'integrity analyze job failed');
});
