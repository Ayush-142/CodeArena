import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { Contest } from '../models/Contest.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../middleware/errors.js';
import { logger } from '../logger.js';

export const internalWebhooksRouter = Router();

interface NakalchiWebhookPayload {
  analysisId: string;
  status: 'completed' | 'failed';
  flaggedPairs?: number;
  topSimilarity?: number;
  error?: string;
}

type RequestWithRawBody = Request & { rawBody?: Buffer };

// Matches Nakalchi's webhooks/notify.ts exactly: raw hex HMAC-SHA256 digest of
// the exact raw request body, no "sha256=" prefix, no timestamp component.
function verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature || !env.nakalchiWebhookSecret) return false;
  const expected = createHmac('sha256', env.nakalchiWebhookSecret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * Phase 6: receives Nakalchi's signed analysis-complete/failed callback.
 * Idempotent by analysisId - Nakalchi's delivery is at-least-once (see its
 * webhooks/notify.ts doc comment), so a re-delivered payload is just a
 * same-data overwrite here.
 *
 * 404-not-503 on no match is deliberate (plan review comment 5): Nakalchi's
 * notify.ts retries on ANY non-2xx response, not just 5xx (verified against
 * its source - `if (response.ok) {...return;}` is the only success branch,
 * everything else falls through to the retry loop, up to 3 attempts with
 * 2s/4s backoff between them - re-verified during Nakalchi's own Phase 7
 * pass against notify.ts's actual `BACKOFF_BASE_MS * 2 ** (attempt - 1)`,
 * only applied `if (attempt < MAX_ATTEMPTS)`: two delays between three
 * attempts (2s after #1, 4s after #2), not three delays - this comment
 * previously said "2s/4s/8s", which overstated it by one non-existent
 * backoff. Returning 404 here lets that retry close the race
 * where the webhook arrives before worker/src/integrity.ts's own
 * `contest.integrityAnalysis` write completes - which small, fast fixture-
 * corpus analyses can trigger. If integrity.ts never writes at all (e.g. it
 * crashed before its save()), all 3 retries eventually 404 and the result
 * stays unattached - a known, narrow, documented edge case (see README's
 * failure-isolation section), not silently swallowed.
 */
internalWebhooksRouter.post(
  '/webhooks/nakalchi',
  asyncHandler(async (req, res) => {
    const rawBody = (req as RequestWithRawBody).rawBody;
    const signature = req.header('X-Nakalchi-Signature');

    if (!verifySignature(rawBody, signature)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'invalid or missing X-Nakalchi-Signature' } });
      return;
    }

    const payload = req.body as Partial<NakalchiWebhookPayload>;
    if (typeof payload?.analysisId !== 'string' || payload.analysisId.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'missing analysisId' } });
      return;
    }

    const contest = await Contest.findOne({ 'integrityAnalysis.analysisId': payload.analysisId });
    if (!contest) {
      logger.warn({ analysisId: payload.analysisId }, 'nakalchi webhook: no contest pending this analysisId (yet)');
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no contest pending this analysisId (yet)' } });
      return;
    }

    contest.integrityAnalysis = {
      analysisId: payload.analysisId,
      status: payload.status === 'failed' ? 'failed' : 'completed',
      flaggedPairs: payload.flaggedPairs,
      topSimilarity: payload.topSimilarity,
      error: payload.error,
      updatedAt: new Date(),
    };
    await contest.save();

    res.status(200).json({ ok: true });
  }),
);
