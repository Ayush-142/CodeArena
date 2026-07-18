import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

// Phase 6: copied structurally from Nakalchi's auth/apiKey.ts (this repo has
// no constant-time-compare pattern of its own - the only existing auth
// mechanism is JWT-in-cookie, which is a signature check, not a string
// compare). Header name X-Internal-Token is deliberately distinct from
// Nakalchi's client-facing X-Api-Key, to keep the two trust boundaries
// (external API consumers vs. service-to-service) visually distinct.
function safeCompare(candidate: string, configured: string): boolean {
  const candidateBuf = Buffer.from(candidate);
  const configuredBuf = Buffer.from(configured);
  if (candidateBuf.length !== configuredBuf.length) return false;
  return timingSafeEqual(candidateBuf, configuredBuf);
}

/**
 * Protects internal, service-to-service endpoints (currently only
 * GET /internal/contests/:id/submissions, consumed by Nakalchi's
 * integrations/codearena.ts). Single scalar token, not a comma-separated
 * list like X-Api-Key would be - only one caller uses this endpoint. If
 * INTERNAL_SERVICE_TOKEN isn't configured (e.g. INTEGRITY_ANALYSIS_ENABLED
 * is off), every request fails closed rather than silently allowing access.
 */
export function requireInternalToken(req: Request, _res: Response, next: NextFunction): void {
  const configured = env.internalServiceToken;
  const header = req.header('X-Internal-Token');

  if (typeof header !== 'string' || header.length === 0) {
    next(new AppError(401, 'UNAUTHORIZED', 'Missing X-Internal-Token header.'));
    return;
  }
  if (!configured || !safeCompare(header, configured)) {
    next(new AppError(401, 'UNAUTHORIZED', 'Invalid internal service token.'));
    return;
  }
  next();
}
