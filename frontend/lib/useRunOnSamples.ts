'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '@/components/SocketProvider';
import { ApiError, createRun, getRun, getRetryAfterSeconds } from '@/lib/api';
import type { RunClientEvent, RunResponse } from '@/lib/types';

// Quiet retry affordance only — never auto-retries. Matches the backend's fail-fast/
// no-BullMQ-retry choice (see ARCHITECTURE.md §5, "Run on samples").
const STALL_MS = 30_000;

// Shared by the standalone solving page and the contest detail page's embedded editor —
// identical state machine to the submission flow (optimistic "queued" -> 800ms fallback
// poll -> socket-triggered refetch), entirely independent of submissionView so it can never
// leak into hint eligibility or the verdict stamp.
export function useRunOnSamples() {
  const socket = useSocket();
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);

  const currentRunIdRef = useRef<string | null>(null);
  const oneShotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (oneShotTimerRef.current) {
      clearTimeout(oneShotTimerRef.current);
      oneShotTimerRef.current = null;
    }
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const refetchRun = useCallback(
    async (runId: string) => {
      if (runId !== currentRunIdRef.current) return; // stale — a newer run is tracked
      try {
        const data = await getRun(runId);
        if (runId !== currentRunIdRef.current) return; // stale after the await too
        setRun(data);
        if (data.status === 'done' || data.status === 'failed') {
          setStalled(false);
          clearTimers();
        }
      } catch {
        // Transient fetch failure — the socket event or the next trigger will retry.
      }
    },
    [clearTimers],
  );

  useEffect(() => {
    if (!socket || !currentRunId) return;
    function handleRunResult(payload: RunClientEvent) {
      // REST is truth, the socket is only a notification to refetch.
      if (payload.runId === currentRunId) {
        void refetchRun(currentRunId);
      }
    }
    socket.on('run:result', handleRunResult);
    return () => {
      socket.off('run:result', handleRunResult);
    };
  }, [socket, currentRunId, refetchRun]);

  const startRun = useCallback(
    async (problemSlug: string, code: string, contestId?: string) => {
      setSubmitting(true);
      setError(null);
      setStalled(false);
      try {
        const res = await createRun(problemSlug, code, 'cpp', contestId);
        currentRunIdRef.current = res.runId;
        setCurrentRunId(res.runId);
        setRun({ runId: res.runId, status: 'queued', samples: [] });

        clearTimers();
        oneShotTimerRef.current = setTimeout(() => {
          void refetchRun(res.runId);
        }, 800);
        stallTimerRef.current = setTimeout(() => {
          if (currentRunIdRef.current === res.runId) setStalled(true);
        }, STALL_MS);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
          const seconds = getRetryAfterSeconds(err);
          setError(`rate limited, try again in ${seconds ?? '?'}s`);
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError('Run failed');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [clearTimers, refetchRun],
  );

  // Lets a host page clear Run state when switching problems (mirrors how the submission
  // state machine gets reset on the same trigger elsewhere in this app).
  const reset = useCallback(() => {
    currentRunIdRef.current = null;
    setCurrentRunId(null);
    setRun(null);
    setError(null);
    setStalled(false);
    clearTimers();
  }, [clearTimers]);

  return { run, submitting, error, stalled, startRun, reset };
}
