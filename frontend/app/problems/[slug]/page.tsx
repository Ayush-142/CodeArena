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
import { ApiError, createSubmission, getProblem, getRetryAfterSeconds, getSubmission } from '@/lib/api';
import type { ProblemDetail, SubmissionStatus, VerdictClientEvent } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

const TERMINAL_STATUSES: SubmissionStatus[] = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];
// Mirrors api/src/routes/hints.ts ELIGIBLE_VERDICTS exactly — hints unlock only for
// these; CE is a different failure class (nothing ran) and stays out of scope.
const HINT_ELIGIBLE_STATUSES: SubmissionStatus[] = ['WA', 'TLE', 'RE', 'MLE'];

type LeftTab = 'description' | 'submissions';

const DIFFICULTY_STYLES: Record<ProblemDetail['difficulty'], string> = {
  easy: 'border-verdict-ac text-verdict-ac',
  medium: 'border-verdict-tle text-verdict-tle',
  hard: 'border-verdict-wa text-verdict-wa',
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
      className={`border-b-2 px-0.5 py-1.5 font-mono text-sm uppercase tracking-wide ${
        active ? 'border-accent text-ink' : 'border-transparent text-ink/50 hover:text-ink'
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
          <span className={`rounded-md border px-2 py-1 uppercase ${DIFFICULTY_STYLES[problem.difficulty]}`}>
            {problem.difficulty}
          </span>
          <span className="rounded-md border border-line px-2 py-1 text-ink/70">
            time limit {problem.timeLimitMs}ms
          </span>
          <span className="rounded-md border border-line px-2 py-1 text-ink/70">
            memory limit {problem.memoryLimitMb}MB
          </span>
        </div>
      </div>

      <ResizableSplit
        storageKey="codearena:solving-split-ratio"
        defaultRatio={50}
        left={
          <div className="flex h-full flex-col gap-4 pr-0 md:pr-4">
            <div className="flex gap-4 border-b border-line">
              <TabButton active={leftTab === 'description'} onClick={() => setLeftTab('description')}>
                Description
              </TabButton>
              <TabButton active={leftTab === 'submissions'} onClick={() => setLeftTab('submissions')}>
                Submissions
              </TabButton>
            </div>

            {leftTab === 'description' ? (
              <div className="flex flex-col gap-4">
                <MarkdownStatement statementMd={problem.statementMd} />
                <div>
                  <h2 className="mb-2 font-display font-bold text-ink">Samples</h2>
                  {problem.samples.map((sample, i) => (
                    <div key={i} className="mb-2 grid grid-cols-2 gap-2">
                      <div>
                        <p className="mb-1 font-mono text-xs uppercase tracking-wide text-ink/50">Input</p>
                        <pre className="whitespace-pre-wrap border border-line bg-surface p-2 font-mono text-sm text-ink">
                          {sample.input}
                        </pre>
                      </div>
                      <div>
                        <p className="mb-1 font-mono text-xs uppercase tracking-wide text-ink/50">Output</p>
                        <pre className="whitespace-pre-wrap border border-line bg-surface p-2 font-mono text-sm text-ink">
                          {sample.output}
                        </pre>
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
        }
        right={
          <div className="flex h-full flex-col gap-4 pl-0 md:pl-4">
            <MonacoEditorPanel code={code} onChange={setCode} />

            <div className="flex flex-col gap-2">
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="self-start border border-accent bg-accent/10 px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wide text-accent hover:bg-accent/20 disabled:opacity-40"
              >
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
              {submitError ? <ErrorState message={submitError} /> : null}
              {submissionView ? (
                <div>
                  <VerdictBadge
                    status={submissionView.status}
                    failedTestIndex={submissionView.failedTestIndex}
                    execTimeMs={submissionView.execTimeMs}
                  />
                </div>
              ) : null}
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
