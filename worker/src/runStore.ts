import { redisClient } from './redis.js';

// Mirrors api/src/redis/runStore.ts — duplicated rather than shared, following this
// codebase's established API/worker model-duplication convention (no /shared package).
export type RunSampleVerdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE';

export interface RunSampleResult {
  index: number;
  verdict: RunSampleVerdict;
  actualOutput: string;
  expectedOutput: string;
  execTimeMs?: number;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RunRecord {
  runId: string;
  userId: string;
  status: RunStatus;
  compileError?: string;
  samples: RunSampleResult[];
}

const RUN_TTL_SECONDS = 600;

export async function writeRunRecord(record: RunRecord): Promise<void> {
  await redisClient.set(`run:${record.runId}`, JSON.stringify(record), { EX: RUN_TTL_SECONDS });
}
