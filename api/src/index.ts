import 'dotenv/config'; // MUST be first: loads .env before any other module reads process.env
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { redisClient } from './redis/client.js';
import { attachUser } from './middleware/auth.js';
import { AppError, errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { submissionsRouter } from './routes/submissions.js';
import { problemsRouter } from './routes/problems.js';
import { contestsRouter } from './routes/contests.js';
import { adminContestsRouter } from './routes/adminContests.js';
import { hintsRouter } from './routes/hints.js';
import { initSocket } from './socket/index.js';

// Reproduced against @google/genai@2.10.0 (pinned "^2.10.0" in api/package.json; confirmed
// installed version via node_modules/@google/genai/package.json). Root cause (confirmed by a
// dedicated reproduction script, not guessed): our AbortController (api/src/hints/llm.ts's 8s
// hint timeout) aborts the underlying fetch mid-stream inside
// ApiClient.processStreamResponse's raw ReadableStream reader loop (ApiClient.streamApiCall /
// processStreamResponse, ~line 13503 of dist/node/index.mjs, ~line 13488 for streamApiCall).
// llm.ts's own try/catch around the exposed `for await` loop already handles the "public"
// rejection correctly; this is a second, separate promise created internally by the
// fetch/undici + ReadableStream + AbortSignal interaction that never gets a .catch() attached
// to it before Node's microtask queue flags it as unhandled.
//
// Upstream issue search (2026-07-08, googleapis/js-genai): no open issue matches this exact
// repro. Closest analog is googleapis/js-genai#487 ("sendMessageStream is causing unhandled
// promise rejections when it errors, even if the errors are caught by the caller") — same
// *shape* of bug (an internal derived promise not chained to the caller's try/catch) but a
// different code path (Chat.sendMessageStream's internal `.then(() => undefined)`), and
// already fixed in our installed 2.10.0 (verified: dist/node/index.mjs now chains
// `.catch(() => undefined)` after it). Our path never touches Chat — we call
// `ai.models.generateContentStream` directly, and with no `tools` configured, AFC is disabled
// (see `shouldDisableAfc`), so we go straight through `generateContentStreamInternal`, not
// `processAfcStream`. This also isn't unique to this SDK: the same class of "fetch +
// ReadableStream + AbortSignal produces an unhandled rejection that bypasses normal try/catch"
// shows up independently in nodejs/node#40120, vercel/ai#1445, and vercel/ai#5115 — it looks
// like a broader gap in how abort interacts with streamed fetch bodies generally, not an
// js-genai-specific defect. No issue has been filed yet for our specific repro; the reproduction
// script that proved this (api/src/scripts/_repro-abort-crash.ts) was deleted after use and
// would need to be rewritten before filing one.
//
// This does NOT surface via `process.on('unhandledRejection', ...)` — verified empirically
// that a bare unhandledRejection listener alone does NOT stop the crash. Node's default
// unhandled-rejection mode (`throw`, the default since Node 15) escalates straight to
// `uncaughtException` with `origin: 'unhandledRejection'`, bypassing the unhandledRejection
// event entirely. So the guard has to live here, on uncaughtException, narrowly scoped to
// this exact known condition — anything else still crashes the process on purpose, since an
// unknown uncaughtException leaves the process in an unreliable state Node's own guidance
// says should be restarted, not kept alive.
//
// Delete this guard once either (a) an upstream fix lands for the fetch/ReadableStream/
// AbortSignal unhandled-rejection gap described above, or (b) llm.ts stops using a manual
// AbortController-based timeout (e.g. if @google/genai adds a native per-call timeout that
// doesn't route through AbortSignal). No tracking issue number exists yet — re-run the search
// above before assuming one has landed.
process.on('uncaughtException', (err, origin) => {
  const isKnownGeminiAbortRace =
    origin === 'unhandledRejection' && err instanceof DOMException && err.name === 'AbortError';
  if (isKnownGeminiAbortRace) {
    console.error('[api] absorbed known Gemini SDK abort-race exception (see comment above)', err.message);
    return;
  }
  console.error('[api] FATAL uncaughtException, exiting', origin, err);
  process.exit(1);
});

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');

const app = express();
app.use(helmet());
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(attachUser); // after cookie-parser (needs req.cookies), before all routers

app.use('/api/auth', authRouter);
app.use('/api/problems', problemsRouter);
app.use('/api/submissions', submissionsRouter);
app.use('/api/contests', contestsRouter);
app.use('/api/admin/contests', adminContestsRouter);
app.use('/api/hints', hintsRouter);

// Dev-only static test client (api/public/socket-test.html) — never served in production.
// Placed before the 404 catch-all below so requests for it don't fall through to it.
if (process.env.NODE_ENV !== 'production') {
  // import.meta.dirname requires Node >=20.11 (see "engines" in package.json).
  app.use(express.static(path.join(import.meta.dirname, '../public')));
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'api' });
});

app.get('/ready', async (_req, res) => {
  const state = { mongo: false, redis: false };

  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codearena');
    state.mongo = true;
  } catch {
    state.mongo = false;
  }

  try {
    await redisClient.ping();
    state.redis = true;
  } catch {
    state.redis = false;
  }

  res.json(state);
});

app.use((req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `route not found: ${req.method} ${req.path}`));
});

app.use(errorHandler); // must be last — Express identifies error middleware by 4-arg signature

const httpServer = http.createServer(app);
await initSocket(httpServer);

const port = Number(process.env.PORT || 3001);
httpServer.listen(port, () => {
  console.log(`API listening on ${port}`);
});
