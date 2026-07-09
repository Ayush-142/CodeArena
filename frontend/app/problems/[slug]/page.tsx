'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useSocket } from '@/components/SocketProvider';
import { MarkdownStatement } from '@/components/MarkdownStatement';
import { MonacoEditorPanel } from '@/components/MonacoEditorPanel';
import { VerdictBadge } from '@/components/VerdictBadge';
import { HintPanel } from '@/components/HintPanel';
import { SubmissionHistory } from '@/components/SubmissionHistory';
import { ResizableSplit } from '@/components/ResizableSplit';
import { RunConsole } from '@/components/RunConsole';
import { ApiError, createSubmission, getProblem, getRetryAfterSeconds, getSubmission } from '@/lib/api';
import type { ProblemDetail, SubmissionStatus, VerdictClientEvent } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useRunOnSamples } from '@/lib/useRunOnSamples';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

const TERMINAL_STATUSES: SubmissionStatus[] = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];
// Mirrors api/src/routes/hints.ts ELIGIBLE_VERDICTS exactly — hints unlock only for
// these; CE is a different failure class (nothing ran) and stays out of scope.
const HINT_ELIGIBLE_STATUSES: SubmissionStatus[] = ['WA', 'TLE', 'RE', 'MLE'];

type LeftTab = 'description' | 'submissions';

const DIFFICULTY_LABELS: Record<ProblemDetail['difficulty'], string> = {
  easy: '🟢',
  medium: '🏆',
  hard: '🔥',
};

interface SubmissionView {
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1 font-mono text-sm font-bold uppercase tracking-wide ${
        active ? 'bg-canvas text-ink shadow-emboss' : 'text-ink/50 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

export default function ProblemSolvingPage() {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { status: authStatus } = useAuth();
  const socket = useSocket();

  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const [currentSubmissionId, setCurrentSubmissionId] = useState<string | null>(null);
  const [submissionView, setSubmissionView] = useState<SubmissionView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [leftTab, setLeftTab] = useState<LeftTab>('description');

  const { run, submitting: running, error: runError, stalled: runStalled, startRun } = useRunOnSamples();

  useDocumentTitle(problem?.title ?? 'Problem');

  // Mirrors currentSubmissionId for use inside async callbacks/timers, which otherwise close
  // over a stale value from whichever render scheduled them.
  const currentSubmissionIdRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const oneShotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch the problem on mount/slug change, and reset per-page submission tracking — this
  // page never persists "current submission" across navigations; the history section (below)
  // is what recovers state on revisit/refresh.
  useEffect(() => {
    setProblem(null);
    setProblemError(null);
    setCurrentSubmissionId(null);
    currentSubmissionIdRef.current = null;
    setSubmissionView(null);
    setSubmitError(null);
    setLeftTab('description');

    getProblem(slug)
      .then(setProblem)
      .catch(() => setProblemError('Failed to load problem'));
  }, [slug]);

  const refetchSubmission = useCallback(async (id: string) => {
    if (id !== currentSubmissionIdRef.current) return; // stale — a newer submission is tracked
    try {
      const data = await getSubmission(id);
      if (id !== currentSubmissionIdRef.current) return; // stale after the await too
      setSubmissionView({ status: data.status, failedTestIndex: data.failedTestIndex, execTimeMs: data.execTimeMs });
      if (TERMINAL_STATUSES.includes(data.status)) {
        setHistoryRefreshKey((k) => k + 1);
        if (data.status === 'AC') {
          setProblem((p) => (p ? { ...p, solved: true } : p));
        }
        if (oneShotTimerRef.current) {
          clearTimeout(oneShotTimerRef.current);
          oneShotTimerRef.current = null;
        }
      }
    } catch {
      // Transient fetch failure — the socket event or the next trigger will retry; no need
      // to surface an error over what may still be a perfectly healthy in-flight submission.
    }
  }, []);

  // Re-subscribes whenever the tracked submission changes, so navigating away (or submitting
  // again) detaches the old listener before a new one can be misattributed.
  useEffect(() => {
    if (!socket || !currentSubmissionId) return;
    function handleVerdict(payload: VerdictClientEvent) {
      // REST is truth, the socket is only a notification to refetch — never render
      // payload.verdict directly.
      if (payload.submissionId === currentSubmissionId) {
        void refetchSubmission(currentSubmissionId);
      }
    }
    socket.on('verdict', handleVerdict);
    return () => {
      socket.off('verdict', handleVerdict);
    };
  }, [socket, currentSubmissionId, refetchSubmission]);

  async function handleSubmit() {
    if (authStatus !== 'authenticated') {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    // Stable key across a rapid double-click: set synchronously before any await, so a
    // second click firing before this request settles reuses the same key rather than
    // minting a fresh one — see plan's decision 1 for why this matters.
    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    const key = idempotencyKeyRef.current;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await createSubmission(slug, code, 'cpp', key);
      currentSubmissionIdRef.current = res.id;
      setCurrentSubmissionId(res.id);
      setSubmissionView({ status: 'queued' });
      setLeftTab('submissions');

      if (oneShotTimerRef.current) clearTimeout(oneShotTimerRef.current);
      oneShotTimerRef.current = setTimeout(() => {
        void refetchSubmission(res.id);
      }, 800);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        const seconds = getRetryAfterSeconds(err);
        setSubmitError(`rate limited, try again in ${seconds ?? '?'}s`);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError('Submission failed');
      }
    } finally {
      idempotencyKeyRef.current = null;
      setSubmitting(false);
    }
  }

  function handleRun() {
    if (authStatus !== 'authenticated') {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    void startRun(slug, code);
  }

  if (problemError) return <main className="p-4"><ErrorState message={problemError} /></main>;
  if (!problem) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-4">
      <div>
        <h1 className="font-display text-xl font-bold text-ink">{problem.title}</h1>
        <div className="mt-2 flex flex-wrap gap-2 font-mono text-xs">
          <span className="chip">
            {DIFFICULTY_LABELS[problem.difficulty]} {problem.difficulty}
          </span>
          <span className="chip">⏱ time limit {problem.timeLimitMs}ms</span>
          <span className="chip">▤ memory limit {problem.memoryLimitMb}MB</span>
        </div>
      </div>

      <div className="flex justify-center gap-2">
        <button onClick={handleRun} disabled={running} className="btn-secondary">
          {running ? 'Running…' : 'Run'}
        </button>
        <button onClick={handleSubmit} disabled={submitting} className="btn-primary">
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>

      <ResizableSplit
        storageKey="codearena:solving-split-ratio"
        defaultRatio={50}
        left={
          <div className="panel flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between bg-surface2 border-b-2 border-line px-2 py-1.5">
              <div className="flex items-center gap-1">
                <TabButton active={leftTab === 'description'} onClick={() => setLeftTab('description')}>
                  Description
                </TabButton>
                <TabButton active={leftTab === 'submissions'} onClick={() => setLeftTab('submissions')}>
                  Submissions
                </TabButton>
              </div>
              {submissionView ? (
                <VerdictBadge
                  status={submissionView.status}
                  failedTestIndex={submissionView.failedTestIndex}
                  execTimeMs={submissionView.execTimeMs}
                />
              ) : null}
            </div>

            <div className="flex-1 overflow-auto p-4">
              {leftTab === 'description' ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-lg font-bold text-ink">{problem.title}</h2>
                    {problem.solved ? (
                      <span className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wide text-verdict-ac">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-verdict-ac">
                          ✓
                        </span>
                        Solved
                      </span>
                    ) : null}
                  </div>
                  <MarkdownStatement statementMd={problem.statementMd} />
                  <div>
                    <h2 className="mb-2 font-display font-bold text-ink">Samples</h2>
                    {problem.samples.map((sample, i) => (
                      <div key={i} className="mb-4 flex flex-col gap-2">
                        <div>
                          <div className="mb-1 flex items-center gap-2">
                            <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">Input</span>
                            <span className="flex h-5 w-5 items-center justify-center rounded border border-line text-[10px] font-bold">
                              {i + 1}
                            </span>
                          </div>
                          <pre className="whitespace-pre-wrap font-mono text-sm text-ink">{sample.input}</pre>
                        </div>
                        <div>
                          <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">Output</span>
                          <pre className="whitespace-pre-wrap font-mono text-sm text-ink">{sample.output}</pre>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <h2 className="mb-2 font-display font-bold text-ink">My Submissions</h2>
                  <SubmissionHistory slug={slug} refreshKey={historyRefreshKey} />
                </div>
              )}
            </div>
          </div>
        }
        right={
          <div className="flex h-full flex-col gap-4 pl-0 md:pl-4">
            <MonacoEditorPanel code={code} onChange={setCode} />

            <div className="flex flex-col gap-2">
              {runError ? <ErrorState message={runError} /> : null}
              {run ? <RunConsole run={run} stalled={runStalled} /> : null}
              {submitError ? <ErrorState message={submitError} /> : null}
            </div>

            {submissionView && currentSubmissionId && HINT_ELIGIBLE_STATUSES.includes(submissionView.status) ? (
              <HintPanel submissionId={currentSubmissionId} problemSlug={slug} />
            ) : null}
          </div>
        }
      />
    </main>
  );
}
