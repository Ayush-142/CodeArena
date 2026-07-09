import type { ProblemDoc } from './models/Problem.js';
import { compileCode, runTest } from './sandbox.js';
import type { RunSampleResult, RunSampleVerdict } from './runStore.js';
import { compareOutput } from './compare.js';

// Post-hoc string slice on the already-captured stdout — not a change to sandbox.ts's
// capture behavior, so real judging's (separately pre-existing) unbounded capture is
// untouched. See ARCHITECTURE.md §5, "Run on samples".
const MAX_ACTUAL_OUTPUT_CHARS = 4096;

export interface RunSamplesResult {
  compileError?: string;
  samples: RunSampleResult[];
}

// Unlike judge() in judge.ts, this never short-circuits — every sample is run so the caller
// sees every outcome, not just the first failure. Same runTest() call, same per-problem
// timeLimitMs/memoryLimitMb, same sandbox.ts primitives as real judging — nothing new to keep
// in sync. Reads problem.samples (embedded in Mongo already) — never problem.testcases, so a
// run never touches the private, object-storage-backed hidden test files.
export async function runSamples(code: string, problem: ProblemDoc): Promise<RunSamplesResult> {
  const compiled = await compileCode(code);
  if (!compiled.ok) {
    return { compileError: compiled.compileError, samples: [] };
  }

  const samples: RunSampleResult[] = [];
  for (let i = 0; i < problem.samples.length; i++) {
    const sample = problem.samples[i];
    const start = Date.now();
    const result = await runTest(compiled.binaryTar, sample.input, {
      timeLimitMs: problem.timeLimitMs,
      memoryLimitMb: problem.memoryLimitMb,
    });
    const execTimeMs = Date.now() - start;

    let verdict: RunSampleVerdict;
    let actualOutput = '';
    if (result.kind === 'timeout') {
      verdict = 'TLE';
    } else if (result.kind === 'oom') {
      verdict = 'MLE';
    } else if (result.exitCode !== 0) {
      verdict = 'RE';
      actualOutput = result.stdout;
    } else if (!compareOutput(result.stdout, sample.output)) {
      verdict = 'WA';
      actualOutput = result.stdout;
    } else {
      verdict = 'AC';
      actualOutput = result.stdout;
    }

    samples.push({
      index: i,
      verdict,
      actualOutput: actualOutput.slice(0, MAX_ACTUAL_OUTPUT_CHARS),
      expectedOutput: sample.output,
      execTimeMs,
    });
  }

  return { samples };
}
