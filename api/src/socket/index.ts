import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { parse as parseCookieHeader } from 'cookie';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AUTH_COOKIE_NAME, verifyAuthToken } from '../middleware/auth.js';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  VerdictClientEvent,
  VerdictPubSubMessage,
  LeaderboardClientEvent,
  LeaderboardPubSubMessage,
  HintClientEvent,
  HintPubSubMessage,
  RunClientEvent,
  RunPubSubMessage,
} from './types.js';

const VERDICTS_CHANNEL = 'verdicts';
// New channels, so unlike the legacy unprefixed `verdicts` (a documented pre-convention
// exception — see ARCHITECTURE.md §3/§7), these follow the general ch:*/scoped-key
// namespacing convention from the start.
const LEADERBOARD_CHANNEL = 'ch:leaderboard';
const HINTS_CHANNEL = 'ch:hints';
const RUN_CHANNEL = 'ch:run';

// Single entry point. Zero imports from routes/* — this module must stay movable to its own
// process/workspace later by changing only the bootstrap that calls initSocket(httpServer).
export async function initSocket(
  httpServer: HttpServer,
): Promise<SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>> {
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    {
      // Same allowlist + credentials mode as the REST API's cors() in index.ts — required so
      // the browser will send the httpOnly cookie on the WS upgrade request at all.
      cors: { origin: env.corsOrigins, credentials: true },
    },
  );

  // --- Redis adapter: wired from day one even with a single instance. ---
  // Two dedicated clients, NOT api/src/redis/client.ts's singleton: that client is used for
  // other Redis commands elsewhere (e.g. rate limiting) and node-redis v4 clients that enter
  // subscriber mode can no longer run arbitrary commands, so pub/sub clients must be isolated.
  const adapterPubClient = createClient({ url: env.redisUrl });
  adapterPubClient.on('error', (err) => console.error('[socket] adapter pub client error', err));
  const adapterSubClient = adapterPubClient.duplicate();
  adapterSubClient.on('error', (err) => console.error('[socket] adapter sub client error', err));
  await Promise.all([adapterPubClient.connect(), adapterSubClient.connect()]);
  io.adapter(createAdapter(adapterPubClient, adapterSubClient));

  // --- Auth middleware: runs once per handshake, before `connection` fires. ---
  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) {
      next(new Error('unauthenticated'));
      return;
    }
    const parsedCookies = parseCookieHeader(cookieHeader);
    const token = parsedCookies[AUTH_COOKIE_NAME];
    if (!token) {
      next(new Error('unauthenticated'));
      return;
    }
    try {
      // Verified ONCE, here, at handshake time. If the JWT expires later in the connection's
      // lifetime we do not re-verify or force-disconnect — the socket is simply left open
      // until the client's own reconnect logic runs (or it disconnects manually). Acceptable
      // for v1's 7-day cookie lifetime; REST calls (which DO re-verify per request, see
      // attachUser) remain the source of truth regardless.
      // TODO(refresh-token): once a refresh-token flow exists, re-verify on a timer (or force
      // socket.disconnect() close to JWT expiry and have the client re-handshake) instead of
      // trusting the handshake-time verification for the connection's entire lifetime.
      socket.data.user = verifyAuthToken(token);
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    const room = `user:${user.userId}`;
    socket.join(room);
    console.log(`[socket] ${socket.id} connected as ${user.handle} (${user.userId}), joined room ${room}`);

    // Contest-room membership isn't derivable from the JWT the way user:{userId} is, so
    // the client asks explicitly. No authorization check beyond a well-formed id — contest
    // leaderboards are effectively public reads once running/ended, matching the public
    // GET /api/contests/:id/leaderboard REST endpoint.
    socket.on('contest:join', ({ contestId }) => {
      if (typeof contestId !== 'string' || !mongoose.isValidObjectId(contestId)) return;
      socket.join(`contest:${contestId}`);
    });
    socket.on('contest:leave', ({ contestId }) => {
      if (typeof contestId !== 'string' || !mongoose.isValidObjectId(contestId)) return;
      socket.leave(`contest:${contestId}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket] ${socket.id} disconnected (${reason})`);
    });
  });

  // --- Dedicated 3rd Redis client: app-level subscriber for channel `verdicts`. ---
  // Deliberately separate from adapterPubClient/adapterSubClient above — those two are owned
  // by @socket.io/redis-adapter for its own internal cross-instance broadcast protocol; mixing
  // this app-level subscription onto them would conflate two different concerns, and node-redis
  // v4 clients in subscriber mode can't run other commands anyway.
  const verdictSubscriber = createClient({ url: env.redisUrl });
  verdictSubscriber.on('error', (err) => console.error('[socket] verdict subscriber error', err));
  await verdictSubscriber.connect();

  await verdictSubscriber.subscribe(VERDICTS_CHANNEL, (message) => {
    let parsed: VerdictPubSubMessage;
    try {
      parsed = JSON.parse(message) as VerdictPubSubMessage;
    } catch (err) {
      console.error('[socket] failed to parse verdicts message', err, message);
      return;
    }
    if (!parsed.userId) {
      console.error('[socket] verdicts message missing userId, dropping', parsed);
      return;
    }
    const room = `user:${parsed.userId}`;
    // Strip userId — client-facing payload is exactly { submissionId, verdict }. userId is
    // implied by which room received it; never broadcast, only io.to(room).
    const payload: VerdictClientEvent = { submissionId: parsed.submissionId, verdict: parsed.verdict };
    io.to(room).emit('verdict', payload);
    console.log(`[socket] emitted verdict (submission=${parsed.submissionId}) to room ${room}`);
  });

  // Same client, second subscription — node-redis v4 supports multiple channel
  // subscriptions per subscriber-mode client, so no 4th dedicated client is needed.
  await verdictSubscriber.subscribe(LEADERBOARD_CHANNEL, (message) => {
    let parsed: LeaderboardPubSubMessage;
    try {
      parsed = JSON.parse(message) as LeaderboardPubSubMessage;
    } catch (err) {
      console.error('[socket] failed to parse leaderboard message', err, message);
      return;
    }
    if (!parsed.contestId) {
      console.error('[socket] leaderboard message missing contestId, dropping', parsed);
      return;
    }
    const room = `contest:${parsed.contestId}`;
    const payload: LeaderboardClientEvent = { contestId: parsed.contestId, finalized: parsed.finalized };
    io.to(room).emit('leaderboard:update', payload);
    if (parsed.finalized) {
      // Only contest:announcement producer in this phase — no admin-authored
      // announcement endpoint exists (not in ARCHITECTURE.md's API surface).
      io.to(room).emit('contest:announcement', {
        contestId: parsed.contestId,
        message: 'Contest finalized — final standings are posted.',
      });
    }
    console.log(`[socket] emitted leaderboard:update (contest=${parsed.contestId}) to room ${room}`);
  });

  // Same client, third subscription — hints are private, so this always emits to a
  // user:{userId} room, never a contest room (unlike leaderboard updates above).
  await verdictSubscriber.subscribe(HINTS_CHANNEL, (message) => {
    let parsed: HintPubSubMessage;
    try {
      parsed = JSON.parse(message) as HintPubSubMessage;
    } catch (err) {
      console.error('[socket] failed to parse hints message', err, message);
      return;
    }
    if (!parsed.userId) {
      console.error('[socket] hints message missing userId, dropping', parsed);
      return;
    }
    const room = `user:${parsed.userId}`;
    if (parsed.type === 'chunk') {
      const payload: HintClientEvent = { submissionId: parsed.submissionId, level: parsed.level, chunk: parsed.chunk };
      io.to(room).emit('hint:chunk', payload);
    } else if (parsed.type === 'done') {
      io.to(room).emit('hint:done', { submissionId: parsed.submissionId, level: parsed.level });
    } else {
      io.to(room).emit('hint:error', { submissionId: parsed.submissionId, level: parsed.level });
    }
  });

  // Same client, fourth subscription — run results are private to the requester, so this
  // always emits to a user:{userId} room, same as verdicts/hints. Payload is deliberately
  // just { runId }: GET /api/run/:runId is the source of truth, this is a "go refetch" nudge.
  await verdictSubscriber.subscribe(RUN_CHANNEL, (message) => {
    let parsed: RunPubSubMessage;
    try {
      parsed = JSON.parse(message) as RunPubSubMessage;
    } catch (err) {
      console.error('[socket] failed to parse run message', err, message);
      return;
    }
    if (!parsed.userId) {
      console.error('[socket] run message missing userId, dropping', parsed);
      return;
    }
    const room = `user:${parsed.userId}`;
    const payload: RunClientEvent = { runId: parsed.runId };
    io.to(room).emit('run:result', payload);
    console.log(`[socket] emitted run:result (run=${parsed.runId}) to room ${room}`);
  });

  return io;
}
