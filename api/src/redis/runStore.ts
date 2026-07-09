import { redisClient } from './client.js';

export type RunSampleVerdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE';

export interface RunSampleResult {
  index: number;
  verdict: RunSampleVerdict;
  actualOutput: string; // truncated to 4KB by the worker
  expectedOutput: string;
  execTimeMs?: number;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RunRecord {
  runId: string;
  userId: string; // owner — checked by GET /api/run/:runId, never trusted from the client
  status: RunStatus;
  compileError?: string; // present only on CE; samples is [] when present
  samples: RunSampleResult[];
}

// Ephemeral by design — mirrors the rl:*/rl:hint-daily:* self-expiring-key convention
// (redisClient.expire(...) on every write) already used elsewhere in this codebase, extended
// from "counter" to "small JSON result blob". No Mongo document is ever created for a run —
// that's what makes "never appears in history / never scores / never unlocks hints" true by
// construction rather than by an added filter (see ARCHITECTURE.md §5, "Run on samples").
const RUN_TTL_SECONDS = 600;

function key(runId: string): string {
  return `run:${runId}`;
}

export async function writeRunRecord(record: RunRecord): Promise<void> {
  await redisClient.set(key(record.runId), JSON.stringify(record), { EX: RUN_TTL_SECONDS });
}

export async function readRunRecord(runId: string): Promise<RunRecord | null> {
  const raw = await redisClient.get(key(runId));
  if (raw === null) return null;
  return JSON.parse(raw) as RunRecord;
}
