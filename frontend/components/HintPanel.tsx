'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './SocketProvider';
import { MarkdownStatement } from './MarkdownStatement';
import { ApiError, getProblemHints, requestHint } from '@/lib/api';
import type { HintClientEvent } from '@/lib/types';

const LEVELS = [1, 2, 3] as const;
const LEVEL_LABELS: Record<1 | 2 | 3, string> = { 1: 'Nudge', 2: 'Approach', 3: 'Bug pinpoint' };

export function HintPanel({ submissionId, problemSlug }: { submissionId: string; problemSlug: string }) {
  const socket = useSocket();

  const [unlocked, setUnlocked] = useState<Partial<Record<1 | 2 | 3, string>>>({});
  const [streamingLevel, setStreamingLevel] = useState<1 | 2 | 3 | null>(null);
  const [streamingBuffer, setStreamingBuffer] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hintsRemainingToday, setHintsRemainingToday] = useState<number | null>(null);

  // Unlock state is tracked per (user, problem) on the server, not per-submission —
  // hydrate whichever levels this problem already has, regardless of which submission
  // originally triggered them. Reload/reconnect recovery.
  useEffect(() => {
    setUnlocked({});
    setErrorMessage(null);
    getProblemHints(problemSlug)
      .then((hints) => {
        setUnlocked(Object.fromEntries(hints.map((h) => [h.level, h.hintText])));
      })
      .catch(() => {
        // Non-fatal — the request button below still works; unlocked levels just
        // won't be pre-populated until the next successful fetch.
      });
  }, [problemSlug]);

  // Live-typing effect only, while a request for this exact level is in flight. The
  // awaited POST /api/hints response (in handleRequest below) is the source of truth —
  // never rendered as final from this stream, same discipline as the verdict flow.
  useEffect(() => {
    if (!socket || streamingLevel === null) return;
    function handleChunk(payload: HintClientEvent) {
      if (payload.submissionId === submissionId && payload.level === streamingLevel && payload.chunk) {
        setStreamingBuffer((buf) => buf + payload.chunk);
      }
    }
    socket.on('hint:chunk', handleChunk);
    return () => {
      socket.off('hint:chunk', handleChunk);
    };
  }, [socket, streamingLevel, submissionId]);

  const handleRequest = useCallback(
    async (level: 1 | 2 | 3) => {
      setStreamingLevel(level);
      setStreamingBuffer('');
      setErrorMessage(null);
      try {
        const res = await requestHint(submissionId, level);
        if (res.available) {
          setUnlocked((prev) => ({ ...prev, [res.level]: res.hintText }));
          setHintsRemainingToday(res.hintsRemainingToday);
        } else {
          setErrorMessage(res.message);
        }
      } catch (err) {
        setErrorMessage(err instanceof ApiError ? err.message : 'Failed to get hint');
      } finally {
        setStreamingLevel(null);
        setStreamingBuffer('');
      }
    },
    [submissionId],
  );

  const nextLevel = LEVELS.find((l) => unlocked[l] === undefined);

  return (
    <div className="mt-4 flex flex-col gap-3 border border-line bg-surface p-3">
      <h2 className="font-display font-bold text-ink">Hints</h2>
      {LEVELS.filter((l) => unlocked[l] !== undefined).map((l) => (
        <div key={l}>
          <p className="font-mono text-xs uppercase tracking-wide text-ink/50">
            Level {l} — {LEVEL_LABELS[l]}
          </p>
          <MarkdownStatement statementMd={unlocked[l]!} />
        </div>
      ))}

      {streamingLevel !== null ? (
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-ink/50">
            Level {streamingLevel} — {LEVEL_LABELS[streamingLevel]}
          </p>
          <p className="font-body text-sm text-ink">
            {streamingBuffer || 'Thinking…'}
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent align-middle motion-reduce:animate-none" />
          </p>
        </div>
      ) : null}

      {errorMessage ? <p className="font-mono text-sm text-verdict-tle">{errorMessage}</p> : null}

      {nextLevel && streamingLevel === null ? (
        <button
          onClick={() => handleRequest(nextLevel)}
          className="self-start border border-accent bg-accent/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent hover:bg-accent/20"
        >
          Get Level {nextLevel} Hint ({LEVEL_LABELS[nextLevel]})
        </button>
      ) : null}

      {hintsRemainingToday !== null ? (
        <p className="font-mono text-xs text-ink/40">{hintsRemainingToday} hints remaining today</p>
      ) : null}
    </div>
  );
}
