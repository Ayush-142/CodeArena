import pino from 'pino';

// Pretty-printed in dev (pino-pretty, a dev-only dependency), plain JSON in production — one
// line per lifecycle event. submissionId/runId are threaded through as bound child-logger
// fields at the call sites that have them (see socket/index.ts, routes/hints.ts), so a single
// id greps every line touching that submission/run across this process's log output.
// ARCHITECTURE.md §13.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
});
