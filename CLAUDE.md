# CodeArena — Online Judge Platform

## Architecture (do not deviate without asking)
- Next.js frontend (App Router, TS, Tailwind) in /frontend
- Express API (stateless, JWT auth) in /api
- Judge workers (BullMQ consumers) in /worker — run code
  in Docker sandboxes (--network=none, memory/CPU limits,
  non-root, wall-clock timeout)
- Redis: BullMQ queue, Pub/Sub (worker→socket bridge),
  ZSET leaderboard, rate limits, caching
- MongoDB: users, problems, submissions (referenced, never
  embedded), contests
- Socket.io with Redis adapter for verdicts/leaderboard

## Conventions
- TypeScript strict mode, no `any`
- API never executes code directly — always via queue
- All Redis keys namespaced: `queue:`, `lb:`, `rl:`, `cache:`

## Commands
- (fill in as you set up: dev, test, lint)