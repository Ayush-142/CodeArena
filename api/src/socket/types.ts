import type { AuthUser } from '../middleware/auth.js';

/**
 * Client contract for the `verdict` event. Phase 4b (frontend) will consume this exact
 * shape over its socket connection — do not add/rename fields here without updating the
 * frontend contract in the same change.
 */
export interface VerdictClientEvent {
  submissionId: string;
  verdict: string; // one of VERDICTS in api/src/models/Submission.ts: queued|running|AC|WA|TLE|MLE|RE|CE
}

/**
 * Raw message shape published by the worker to Redis channel `verdicts` (worker/src/index.ts).
 * Internal to the socket module only — userId is stripped before anything is emitted to a
 * client; a client never sees this shape (room membership implies userId instead).
 */
export interface VerdictPubSubMessage {
  submissionId: string;
  userId: string;
  verdict: string;
}

// Socket.io generic type params (Server<ListenEvents, EmitEvents, ServerSideEvents, SocketData>)
// — scoped to this module only, no `declare module 'socket.io'` global augmentation.
export interface ServerToClientEvents {
  verdict: (payload: VerdictClientEvent) => void;
}

// No client→server business events in this phase — all mutations go through REST.
export type ClientToServerEvents = Record<string, never>;

export interface SocketData {
  user: AuthUser;
}
