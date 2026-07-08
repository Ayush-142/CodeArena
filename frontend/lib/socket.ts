import { io, Socket } from 'socket.io-client';
import type { VerdictClientEvent } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ServerToClientEvents {
  verdict: (payload: VerdictClientEvent) => void;
}

// autoConnect:false — SocketProvider owns the connect/disconnect lifecycle, tied to auth
// status. withCredentials:true is required so the httpOnly auth cookie rides the handshake
// (the server never accepts auth.token — see api/src/socket/index.ts).
export function createSocket(): Socket<ServerToClientEvents> {
  return io(API_BASE_URL, {
    withCredentials: true,
    autoConnect: false,
  });
}
