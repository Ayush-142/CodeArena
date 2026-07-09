'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useSocket } from '@/components/SocketProvider';
import { MarkdownStatement } from '@/components/MarkdownStatement';
import { MonacoEditorPanel } from '@/components/MonacoEditorPanel';
import { VerdictBadge } from '@/components/VerdictBadge';
import { CountdownTimer } from '@/components/CountdownTimer';
import { RunConsole } from '@/components/RunConsole';
import {
  ApiError,
  createSubmission,
  getContest,
  getRetryAfterSeconds,
  getSubmission,
  registerForContest,
} from '@/lib/api';
import type { ContestDetailResponse, ProblemDetail, SubmissionStatus, VerdictClientEvent } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useRunOnSamples } from '@/lib/useRunOnSamples';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

const TERMINAL_STATUSES: SubmissionStatus[] = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];

interface SubmissionView {
  status: SubmissionStatus;
  failedTestIndex?: number;
  execTimeMs?: number;
}

export default function ContestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { status: authStatus } = useAuth();
  const socket = useSocket();

  const [data, setData] = useState<ContestDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [selectedProblem, setSelectedProblem] = useState<ProblemDetail | null>(null);
  const [code, setCode] = useState('');
  const [currentSubmissionId, setCurrentSubmissionId] = useState<string | null>(null);
  const [submissionView, setSubmissionView] = useState<SubmissionView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { run, submitting: running, error: runError, stalled: runStalled, startRun, reset: resetRun } = useRunOnSamples();

  useDocumentTitle(data?.contest.title ?? 'Contest');

  const currentSubmissionIdRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const oneShotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchContest = useCallback(() => {
    getContest(id)
      .then(setData)
      .catch(() => setError('Failed to load contest'));
  }, [id]);

  useEffect(() => {
    setData(null);
    setError(null);
    setSelectedProblem(null);
    refetchContest();
  }, [id, refetchContest]);

  const refetchSubmission = useCallback(async (submissionId: string) => {
    if (submissionId !== currentSubmissionIdRef.current) return;
    try {
      const sub = await getSubmission(submissionId);
      if (submissionId !== currentSubmissionIdRef.current) return;
      setSubmissionView({ status: sub.status, failedTestIndex: sub.failedTestIndex, execTimeMs: sub.execTimeMs });
      if (TERMINAL_STATUSES.includes(sub.status) && oneShotTimerRef.current) {
        clearTimeout(oneShotTimerRef.current);
        oneShotTimerRef.current = null;
      }
    } catch {
      // Transient — the socket event or the next trigger retries.
    }
  }, []);

  useEffect(() => {
    if (!socket || !currentSubmissionId) return;
    function handleVerdict(payload: VerdictClientEvent) {
      // REST is truth, the socket is only a notification to refetch.
      if (payload.submissionId === currentSubmissionId) {
        void refetchSubmission(currentSubmissionId);
      }
    }
    socket.on('verdict', handleVerdict);
    return () => {
      socket.off('verdict', handleVerdict);
    };
  }, [socket, currentSubmissionId, refetchSubmission]);

  function selectProblem(problem: ProblemDetail) {
    setSelectedProblem(problem);
    setCode('');
    setCurrentSubmissionId(null);
    currentSubmissionIdRef.current = null;
    setSubmissionView(null);
    setSubmitError(null);
    resetRun();
  }

  async function handleRegister() {
    if (authStatus !== 'authenticated') {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setRegistering(true);
    setRegisterError(null);
    try {
      await registerForContest(id);
      refetchContest();
    } catch (err) {
      setRegisterError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setRegistering(false);
    }
  }

  async function handleSubmit() {
    if (!selectedProblem) return;
    if (authStatus !== 'authenticated') {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    const key = idempotencyKeyRef.current;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await createSubmission(selectedProblem.slug, code, 'cpp', key, id);
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

  function handleRun() {
    if (!selectedProblem) return;
    if (authStatus !== 'authenticated') {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    void startRun(selectedProblem.slug, code, id);
  }

  if (error) return <main className="p-4"><ErrorState message={error} /></main>;
  if (!data) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </main>
    );
  }

  const { contest, phase, isRegistered, problems } = data;

  return (
    <main className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="font-display text-xl font-bold text-ink">{contest.title}</h1>
        {phase === 'upcoming' ? (
          <p className="font-mono text-sm text-ink/80">
            starts in <CountdownTimer targetTime={contest.startAt} serverTime={data.serverTime} />
          </p>
        ) : phase === 'running' ? (
          <p className="font-mono text-sm text-accent">
            running · ends in <CountdownTimer targetTime={contest.endAt} serverTime={data.serverTime} />
          </p>
        ) : (
          <p className="font-mono text-sm text-ink/50">ended</p>
        )}
      </div>

      {phase === 'upcoming' && !isRegistered ? (
        <div>
          <button
            onClick={handleRegister}
            disabled={registering}
            className="border border-accent bg-accent/10 px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wide text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            {registering ? 'Registering…' : 'Register'}
          </button>
          {registerError ? (
            <div className="mt-2">
              <ErrorState message={registerError} />
            </div>
          ) : null}
        </div>
      ) : phase === 'upcoming' && isRegistered ? (
        <p className="font-mono text-sm text-verdict-ac">You&apos;re registered.</p>
      ) : null}

      {phase !== 'upcoming' ? (
        <Link href={`/contests/${id}/leaderboard`} className="font-mono text-sm text-accent underline">
          View leaderboard
        </Link>
      ) : null}

      {phase === 'running' ? (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="mb-2 font-display font-bold text-ink">Problems</h2>
            <ul className="flex flex-wrap gap-2">
              {problems.map((p) => (
                <li key={p.slug}>
                  <button
                    onClick={() => selectProblem(p)}
                    className={`border px-3 py-2 font-mono text-sm ${
                      selectedProblem?.slug === p.slug
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-line text-ink hover:border-ink'
                    }`}
                  >
                    {p.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {selectedProblem ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <MarkdownStatement statementMd={selectedProblem.statementMd} />
              <div className="flex flex-col gap-4">
                <MonacoEditorPanel code={code} onChange={setCode} />
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <button
                      onClick={handleRun}
                      disabled={running}
                      className="self-start border border-line px-4 py-2 font-mono text-sm uppercase tracking-wide text-ink hover:border-ink disabled:opacity-40"
                    >
                      {running ? 'Running…' : 'Run'}
                    </button>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting}
                      className="self-start border border-accent bg-accent/10 px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wide text-accent hover:bg-accent/20 disabled:opacity-40"
                    >
                      {submitting ? 'Submitting…' : 'Submit'}
                    </button>
                  </div>
                  {runError ? <ErrorState message={runError} /> : null}
                  {run ? <RunConsole run={run} stalled={runStalled} /> : null}
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
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === 'ended' ? (
        <div>
          <h2 className="mb-2 font-display font-bold text-ink">Problems (now public practice)</h2>
          <ul className="flex flex-col gap-2">
            {problems.map((p) => (
              <li key={p.slug}>
                <Link href={`/problems/${p.slug}`} className="font-body text-accent underline">
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
