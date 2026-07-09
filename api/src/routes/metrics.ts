import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { collectMetrics } from '../metrics.js';

export const metricsRouter = Router();

// Deliberately unauthenticated, matching /health and /ready's existing posture — and
// deliberately NOT proxied by Caddy in production (see docker-compose.prod.yml / Caddyfile),
// so it's reachable only inside the compose network or via localhost on the VM itself, never
// through the public domain.
metricsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await collectMetrics());
  }),
);
