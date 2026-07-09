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
 * Raw message shape published by the worker to Redis channel `ch:verdicts` (worker/src/index.ts).
 * Internal to the socket module only — userId is stripped before anything is emitted to a
 * client; a client never sees this shape (room membership implies userId instead).
 */
export interface VerdictPubSubMessage {
  submissionId: string;
  userId: string;
  verdict: string;
}

/**
 * Raw message shape published to Redis channel `ch:leaderboard` by both the worker
 * (worker/src/scoring.ts, on each scored AC) and the API (api/src/contests/rebuild.ts,
 * on finalization). `finalized` is only ever true on the finalization publish.
 */
export interface LeaderboardPubSubMessage {
  contestId: string;
  finalized?: boolean;
}

/** Client-facing leaderboard-change notification — a "go refetch REST" signal only,
 * never a source of truth (same philosophy as VerdictClientEvent). */
export interface LeaderboardClientEvent {
  contestId: string;
  finalized?: boolean;
}

/**
 * Raw message shape published to Redis channel `ch:hints` by the API's hint route
 * (api/src/hints/llm.ts), as each Gemini stream chunk arrives. Internal to the
 * socket module only — userId is stripped before anything is emitted to a client.
 */
export interface HintPubSubMessage {
  type: 'chunk' | 'done' | 'error';
  userId: string;
  submissionId: string;
  level: 1 | 2 | 3;
  chunk?: string;
}

/** Client-facing hint-stream event — a live-typing effect only. The awaited
 * POST /api/hints response (not this stream) is the source of truth, same
 * "REST is truth" philosophy as VerdictClientEvent. */
export interface HintClientEvent {
  submissionId: string;
  level: 1 | 2 | 3;
  chunk?: string;
}

/**
 * Raw message shape published to Redis channel `ch:run` by the worker's `runs` queue
 * processor, on both success and the `'failed'` event path. Internal to the socket module
 * only — userId is stripped before anything is emitted to a client.
 */
export interface RunPubSubMessage {
  runId: string;
  userId: string;
}

/** Client-facing run-result notification — a "go refetch REST" signal only, same
 * "REST is truth" philosophy as VerdictClientEvent. GET /api/run/:runId is the source
 * of truth; this event never carries the actual result payload. */
export interface RunClientEvent {
  runId: string;
}

// Socket.io generic type params (Server<ListenEvents, EmitEvents, ServerSideEvents, SocketData>)
// — scoped to this module only, no `declare module 'socket.io'` global augmentation.
export interface ServerToClientEvents {
  verdict: (payload: VerdictClientEvent) => void;
  'leaderboard:update': (payload: LeaderboardClientEvent) => void;
  'contest:announcement': (payload: { contestId: string; message: string }) => void;
  'hint:chunk': (payload: HintClientEvent) => void;
  'hint:done': (payload: { submissionId: string; level: 1 | 2 | 3 }) => void;
  'hint:error': (payload: { submissionId: string; level: 1 | 2 | 3 }) => void;
  'run:result': (payload: RunClientEvent) => void;
}

// First client→server events in this codebase — contest-room membership isn't derivable
// from the JWT the way `user:{userId}` is, so the client has to ask to join/leave. Still
// no business actions over sockets: joining a room isn't a mutation, all writes remain REST.
export interface ClientToServerEvents {
  'contest:join': (payload: { contestId: string }) => void;
  'contest:leave': (payload: { contestId: string }) => void;
}

export interface SocketData {
  user: AuthUser;
}
