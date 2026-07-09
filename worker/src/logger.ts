import pino from 'pino';

// Mirrors api/src/logger.ts — duplicated per this repo's established api/worker convention
// rather than a shared package. submissionId/runId bound as child-logger fields at the call
// sites in index.ts, so a single id greps every line across this process's log output.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
});
