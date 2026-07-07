import type { ProblemDoc } from './models/Problem.js';
import type { Verdict } from './models/Submission.js';
import { compileCode, runTest } from './sandbox.js';
import { getTestFile } from './testcases.js';

export interface JudgeResult {
  verdict: Verdict;
  failedTestIndex?: number;
  execTimeMs?: number;
  output?: string;
  compileError?: string;
}

export async function judge(
  code: string,
  problem: ProblemDoc & { slug: string },
): Promise<JudgeResult> {
  const compiled = await compileCode(code);
  if (!compiled.ok) {
    return { verdict: 'CE', compileError: compiled.compileError };
  }

  let maxExecTimeMs = 0;

  for (let i = 0; i < problem.testcases.length; i++) {
    const testcase = problem.testcases[i];
    const [input, expectedOutput] = await Promise.all([
      getTestFile(problem.slug, `${testcase.key}.in`, testcase.inputKey),
      getTestFile(problem.slug, `${testcase.key}.out`, testcase.outputKey),
    ]);

    const start = Date.now();
    const result = await runTest(compiled.binaryTar, input, {
      timeLimitMs: problem.timeLimitMs,
      memoryLimitMb: problem.memoryLimitMb,
    });
    maxExecTimeMs = Math.max(maxExecTimeMs, Date.now() - start);

    if (result.kind === 'timeout') {
      return { verdict: 'TLE', failedTestIndex: i, execTimeMs: maxExecTimeMs };
    }
    if (result.kind === 'oom') {
      return { verdict: 'MLE', failedTestIndex: i, execTimeMs: maxExecTimeMs };
    }
    if (result.exitCode !== 0) {
      return {
        verdict: 'RE',
        failedTestIndex: i,
        execTimeMs: maxExecTimeMs,
        output: result.stdout,
      };
    }
    if (result.stdout.trim() !== expectedOutput.trim()) {
      return {
        verdict: 'WA',
        failedTestIndex: i,
        execTimeMs: maxExecTimeMs,
        output: result.stdout,
      };
    }
  }

  return { verdict: 'AC', execTimeMs: maxExecTimeMs };
}
