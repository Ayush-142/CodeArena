'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useSocket } from '@/components/SocketProvider';
import { MarkdownStatement } from '@/components/MarkdownStatement';
import { MonacoEditorPanel } from '@/components/MonacoEditorPanel';
import { VerdictBadge } from '@/components/VerdictBadge';
import { SubmissionHistory } from '@/components/SubmissionHistory';
import { ApiError, createSubmission, getProblem, getRetryAfterSeconds, getSubmission } from '@/lib/api';
import type { ProblemDetail, SubmissionStatus, VerdictClientEvent } from '@/lib/types';

const TERMINAL_STATUSES: SubmissionStatus[] = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];

interface SubmissionView {
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
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

  if (problemError) return <main className="p-4">{problemError}</main>;
  if (!problem) return <main className="p-4">Loading…</main>;

  return (
    <main className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-xl font-semibold">{problem.title}</h1>
        <p className="text-sm text-slate-400">
          {problem.difficulty} · time limit {problem.timeLimitMs}ms · memory limit {problem.memoryLimitMb}MB
        </p>
      </div>

      <MarkdownStatement statementMd={problem.statementMd} />

      <div>
        <h2 className="mb-2 font-semibold">Samples</h2>
        {problem.samples.map((sample, i) => (
          <div key={i} className="mb-2 grid grid-cols-2 gap-2">
            <pre className="whitespace-pre-wrap bg-slate-800 p-2">{sample.input}</pre>
            <pre className="whitespace-pre-wrap bg-slate-800 p-2">{sample.output}</pre>
          </div>
        ))}
      </div>

      <MonacoEditorPanel code={code} onChange={setCode} />

      <div>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="border border-slate-600 p-2"
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
        {submitError ? <p className="mt-2 text-red-400">{submitError}</p> : null}
        {submissionView ? (
          <p className="mt-2">
            <VerdictBadge
              status={submissionView.status}
              failedTestIndex={submissionView.failedTestIndex}
              execTimeMs={submissionView.execTimeMs}
            />
          </p>
        ) : null}
      </div>

      <div>
        <h2 className="mb-2 font-semibold">My Submissions</h2>
        <SubmissionHistory slug={slug} refreshKey={historyRefreshKey} />
      </div>
    </main>
  );
}
