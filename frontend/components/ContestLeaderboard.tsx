'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './SocketProvider';
import { getContestLeaderboard, getContestLeaderboardUserCells } from '@/lib/api';
import type { ContestAnnouncementEvent, LeaderboardCell as LeaderboardCellData, LeaderboardClientEvent, LeaderboardResponse } from '@/lib/types';
import { LeaderboardCell } from './LeaderboardCell';
import { Skeleton } from './ui/Skeleton';
import { ErrorState } from './ui/ErrorState';
import { EmptyState } from './ui/EmptyState';

const RANK_STYLES: Record<number, string> = {
  1: 'text-verdict-ac font-bold',
  2: 'text-ink font-bold',
  3: 'text-verdict-tle font-bold',
};

type CellsState = LeaderboardCellData[] | 'loading' | 'error';

export function ContestLeaderboard({ contestId }: { contestId: string }) {
  const socket = useSocket();
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  // Live-contest, per-user per-problem cells — fetched on demand when a row is
  // clicked; cached per userId for the session. Finalized rows already carry `cells`
  // inline on the row itself and never touch this.
  const [expandedCells, setExpandedCells] = useState<Record<string, CellsState>>({});

  const refetch = useCallback(() => {
    getContestLeaderboard(contestId)
      .then(setData)
      .catch(() => setError('Failed to load leaderboard'));
  }, [contestId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Joins the contest room for as long as this component is mounted; leaderboard:update is
  // treated purely as a "go refetch REST" signal, never rendered directly — same philosophy
  // as the problem-solving page's verdict handling (REST is truth, sockets are notifications).
  useEffect(() => {
    if (!socket) return;
    socket.emit('contest:join', { contestId });

    function handleUpdate(payload: LeaderboardClientEvent) {
      if (payload.contestId === contestId) void refetch();
    }
    function handleAnnouncement(payload: ContestAnnouncementEvent) {
      if (payload.contestId === contestId) setAnnouncement(payload.message);
    }
    socket.on('leaderboard:update', handleUpdate);
    socket.on('contest:announcement', handleAnnouncement);
    return () => {
      socket.emit('contest:leave', { contestId });
      socket.off('leaderboard:update', handleUpdate);
      socket.off('contest:announcement', handleAnnouncement);
    };
  }, [socket, contestId, refetch]);

  function toggleRow(userId: string) {
    if (expandedCells[userId] !== undefined) {
      setExpandedCells((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      return;
    }
    setExpandedCells((prev) => ({ ...prev, [userId]: 'loading' }));
    getContestLeaderboardUserCells(contestId, userId)
      .then((res) => setExpandedCells((prev) => ({ ...prev, [userId]: res.cells })))
      .catch(() => setExpandedCells((prev) => ({ ...prev, [userId]: 'error' })));
  }

  if (error) return <ErrorState message={error} />;
  if (!data) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }
  if (data.rows.length === 0) return <EmptyState message="No standings yet." />;

  const cellOf = (row: LeaderboardResponse['rows'][number], problemId: string): LeaderboardCellData | undefined => {
    if (row.cells) return row.cells.find((c) => c.problemId === problemId);
    const expanded = expandedCells[row.userId];
    if (Array.isArray(expanded)) return expanded.find((c) => c.problemId === problemId);
    return undefined;
  };

  return (
    <div className="flex flex-col gap-2">
      {announcement ? <p className="font-mono text-sm text-verdict-ac">{announcement}</p> : null}
      {data.isFinalized ? <p className="font-mono text-xs uppercase tracking-wide text-ink/50">Final standings</p> : null}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-left font-mono text-sm">
          <thead>
            <tr className="border-b border-line bg-surface">
              <th className="sticky left-0 z-10 min-w-[3rem] border-r border-line bg-surface px-2 py-2 text-ink/70">
                #
              </th>
              <th className="sticky left-[3rem] z-10 min-w-[9rem] border-r border-line bg-surface px-2 py-2 text-ink/70">
                Handle
              </th>
              <th className="min-w-[4rem] px-2 py-2 text-ink/70">Solved</th>
              <th className="min-w-[4rem] px-2 py-2 text-ink/70">Penalty</th>
              {data.problems.map((col) => (
                <th key={col.problemId} className="min-w-[3.5rem] px-2 py-2 text-center text-ink/70">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => {
              const expandable = !data.isFinalized;
              const expanded = expandedCells[row.userId];
              return (
                <tr
                  key={row.userId}
                  onClick={expandable ? () => toggleRow(row.userId) : undefined}
                  className={`border-b border-line ${i % 2 === 1 ? 'bg-surface/40' : ''} ${
                    expandable ? 'cursor-pointer hover:bg-surface/70' : ''
                  }`}
                >
                  <td className={`sticky left-0 z-10 border-r border-line bg-canvas px-2 py-2 ${RANK_STYLES[row.rank] ?? 'text-ink'}`}>
                    {row.rank}
                  </td>
                  <td className="sticky left-[3rem] z-10 border-r border-line bg-canvas px-2 py-2 text-ink">
                    {row.handle}
                  </td>
                  <td className="px-2 py-2 text-ink">{row.solvedCount}</td>
                  <td className="px-2 py-2 text-ink">{row.penaltyMinutes}</td>
                  {data.problems.map((col) => (
                    <td key={col.problemId} className="px-2 py-2 text-center">
                      {expandable && expanded === 'loading' ? (
                        <Skeleton className="mx-auto h-4 w-8" />
                      ) : expandable && expanded === 'error' ? (
                        <span className="text-verdict-wa">!</span>
                      ) : (
                        <LeaderboardCell cell={cellOf(row, col.problemId)} />
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-xs text-ink/50">
        Showing top {data.rows.length} of {data.total}
      </p>

      {data.me ? (
        <p className="font-mono text-sm text-ink/60">
          Your rank: {data.me.rank} · solved {data.me.solvedCount} · penalty {data.me.penaltyMinutes}
        </p>
      ) : null}
    </div>
  );
}
