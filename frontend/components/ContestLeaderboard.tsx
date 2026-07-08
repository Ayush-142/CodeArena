'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './SocketProvider';
import { getContestLeaderboard } from '@/lib/api';
import type { ContestAnnouncementEvent, LeaderboardClientEvent, LeaderboardResponse } from '@/lib/types';

export function ContestLeaderboard({ contestId }: { contestId: string }) {
  const socket = useSocket();
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

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

  if (error) return <p className="text-red-400">{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <div className="flex flex-col gap-2">
      {announcement ? <p className="text-green-400">{announcement}</p> : null}
      {data.isFinalized ? <p className="text-sm text-slate-400">Final standings</p> : null}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="p-1">Rank</th>
            <th className="p-1">Handle</th>
            <th className="p-1">Solved</th>
            <th className="p-1">Penalty</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.userId} className="border-b border-slate-800">
              <td className="p-1">{row.rank}</td>
              <td className="p-1">{row.handle}</td>
              <td className="p-1">{row.solvedCount}</td>
              <td className="p-1">{row.penaltyMinutes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.me ? (
        <p className="text-sm text-slate-400">
          Your rank: {data.me.rank} · solved {data.me.solvedCount} · penalty {data.me.penaltyMinutes}
        </p>
      ) : null}
    </div>
  );
}
