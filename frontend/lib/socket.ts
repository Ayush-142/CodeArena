import { io, Socket } from 'socket.io-client';
import type { ContestAnnouncementEvent, HintClientEvent, LeaderboardClientEvent, VerdictClientEvent } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ServerToClientEvents {
  verdict: (payload: VerdictClientEvent) => void;
  'leaderboard:update': (payload: LeaderboardClientEvent) => void;
  'contest:announcement': (payload: ContestAnnouncementEvent) => void;
  'hint:chunk': (payload: HintClientEvent) => void;
  'hint:done': (payload: { submissionId: string; level: 1 | 2 | 3 }) => void;
  'hint:error': (payload: { submissionId: string; level: 1 | 2 | 3 }) => void;
}

// First client→server events in this app — contest-room membership isn't derivable from
// the auth cookie the way user:{userId} is, so pages must ask explicitly on mount/unmount.
export interface ClientToServerEvents {
  'contest:join': (payload: { contestId: string }) => void;
  'contest:leave': (payload: { contestId: string }) => void;
}

// autoConnect:false — SocketProvider owns the connect/disconnect lifecycle, tied to auth
// status. withCredentials:true is required so the httpOnly auth cookie rides the handshake
// (the server never accepts auth.token — see api/src/socket/index.ts).
export function createSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  return io(API_BASE_URL, {
    withCredentials: true,
    autoConnect: false,
  });
}
