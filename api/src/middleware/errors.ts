import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isMongoDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

// MongoDB's E11000 error exposes which index it collided on via `keyPattern` (e.g.
// `{ handleLower: 1 }`) — lets a route return a field-specific 409 instead of a generic one.
// Only meaningful when isMongoDuplicateKeyError(err) is already true.
export function mongoDuplicateKeyField(err: unknown): string | undefined {
  const keyPattern = (err as { keyPattern?: unknown } | null)?.keyPattern;
  if (!keyPattern || typeof keyPattern !== 'object') return undefined;
  return Object.keys(keyPattern)[0];
}

// Express 4 does not auto-forward rejected promises from async handlers to error middleware
// (that's Express 5 behavior); every async route handler must be wrapped so a throw/rejection
// reaches errorHandler via next(err).
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction, // 4-arg signature required for Express to treat this as error middleware
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  if (isMongoDuplicateKeyError(err)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    return;
  }

  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
