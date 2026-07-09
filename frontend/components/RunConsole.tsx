import { VerdictBadge } from './VerdictBadge';
import { ErrorState } from './ui/ErrorState';
import type { RunResponse } from '@/lib/types';

// Reuses VerdictBadge's chip variant (RunSampleVerdict is a subset of SubmissionStatus) — no
// stamp here, the stamp stays reserved for real verdicts.
export function RunConsole({ run, stalled }: { run: RunResponse; stalled: boolean }) {
  if (run.status === 'queued' || run.status === 'running') {
    return (
      <div className="flex items-center gap-2 font-mono text-sm text-accent">
        <VerdictBadge status="running" variant="chip" />
        {stalled ? <span className="text-ink/50">Taking longer than expected — try Run again?</span> : null}
      </div>
    );
  }

  if (run.status === 'failed') {
    return <ErrorState message="Run failed — try again." />;
  }

  if (run.compileError) {
    return (
      <div className="border border-verdict-ce bg-verdict-ce/10 p-2">
        <p className="mb-1 font-mono text-xs uppercase tracking-wide text-ink/50">Compile error</p>
        <pre className="whitespace-pre-wrap font-mono text-xs text-ink">{run.compileError}</pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {run.samples.map((sample) => (
        <div key={sample.index} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-ink/50">Sample {sample.index + 1}</span>
            <VerdictBadge status={sample.verdict} variant="chip" execTimeMs={sample.execTimeMs} />
          </div>
          {sample.verdict !== 'AC' ? (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 font-mono text-xs uppercase tracking-wide text-ink/50">Expected</p>
                <pre className="whitespace-pre-wrap border border-line bg-surface p-2 font-mono text-xs text-ink">
                  {sample.expectedOutput}
                </pre>
              </div>
              <div>
                <p className="mb-1 font-mono text-xs uppercase tracking-wide text-ink/50">Actual</p>
                <pre className="whitespace-pre-wrap border border-verdict-wa bg-verdict-wa/10 p-2 font-mono text-xs text-ink">
                  {sample.actualOutput}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
