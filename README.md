# CodeArena

An online judge and contest platform — Codeforces/LeetCode-style problem solving with a live
verdict pipeline, ICPC-style contests, and a graduated AI hint system that reads your actual
failing code. Built as a portfolio project; see [ARCHITECTURE.md](ARCHITECTURE.md) for the full
design rationale behind every decision below.

**Live demo:** https://changeme.duckdns.org _(update once deployed — see [DEPLOY.md](DEPLOY.md))_
**Design system:** https://changeme.duckdns.org/styleguide

---

## Screenshots

| Solving page — live judging | Contest leaderboard — per-problem ICPC grid | A verdict landing |
|---|---|---|
| ![Solving page](docs/screenshots/solving-page.png) | ![Leaderboard](docs/screenshots/leaderboard.png) | ![Verdict](docs/screenshots/verdict-stamp.png) |

_(Drop the three PNGs above into `docs/screenshots/` — filenames matter, everything else is
already wired up.)_

---

## Architecture

```
                        ┌─────────────┐
                        │   Client     │  Next.js + Tailwind + Monaco
                        └──────┬───────┘
               HTTPS (REST)    │    WSS (Socket.io)
                    ┌──────────┴──────────┐
                    │       Caddy          │  reverse proxy, automatic HTTPS
                    └──┬───────────────┬───┘
             ┌─────────┴────┐   ┌──────┴────────┐
             │  API (Express)│   │ Socket.io      │  same process as the API
             │  stateless    │   │ (Redis adapter)│  in this single-VM deploy —
             └──┬───────┬───┘   └──────┬─────────┘  see ARCHITECTURE.md §12
                │       ▼              ▼
                │   ┌────────────────────────────┐
                │   │           REDIS             │
                │   │ 1. BullMQ queue (submit/run)│
                │   │ 2. Pub/Sub (ch:verdicts,    │
                │   │    ch:run, ch:leaderboard,  │
                │   │    ch:hints)                │
                │   │ 3. ZSET (live leaderboards) │
                │   │ 4. Rate limits              │
                │   │ 5. Cache (hints)            │
                │   │ 6. Metrics (Phase 7)        │
                │   └──────┬─────────────────────┘
                │          │ consume jobs
                │          ▼
                │   ┌──────────────────┐     ┌──────────────┐
                │   │  Judge Worker     │────▶│ Docker       │
                │   │                   │     │ Sandbox      │
                │   └──────┬───────────┘     │ (per submit) │
                │          │                 └──────┬───────┘
                ▼          ▼                        │ reads
         ┌─────────────────────┐          ┌────────────────┐
         │      MongoDB         │          │   MinIO (S3)   │
         │  users, problems,    │          │ test case files│
         │  submissions,        │          └────────────────┘
         │  contests, hints     │
         └─────────────────────┘
                                  ┌─────────────────┐
         API (hint endpoint) ────▶│  Google Gemini   │
                                  │  (free tier)     │
                                  └─────────────────┘
```

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind CSS |
| API | Node.js + Express + TypeScript (strict) |
| Judge worker | Node.js + TypeScript, BullMQ consumer, dockerode |
| Sandbox | Docker containers, one per compile/run step |
| Database | MongoDB + Mongoose |
| Coordination | Redis (queue, pub/sub, leaderboards, rate limits, cache, metrics) |
| Real-time | Socket.io + Redis adapter |
| LLM | Google Gemini API (`gemini-2.5-flash-lite`, free tier) |
| Editor | Monaco |
| Logging | pino (structured JSON) |
| Reverse proxy | Caddy (automatic HTTPS) |
| CI | GitHub Actions |

## Key design decisions

Each of these is a deliberate tradeoff, not a default — see the linked ARCHITECTURE.md section
for the full reasoning and the alternative that was rejected.

- **Queue decoupling** (§2, §5) — the API never runs user code; it only enqueues a job and
  returns `202` immediately. Judging throughput and API responsiveness scale independently.
- **Sandbox flags are non-negotiable** (§6) — `--network=none`, memory/CPU/pids caps, read-only
  root + tmpfs scratch, non-root, worker-enforced wall-clock timeout. Never weakened for
  convenience, including in CI.
- **Redis's six jobs, kept distinct** (§7) — queue, pub/sub, leaderboards, rate limits, cache,
  and (as of Phase 7) metrics. Each is a separate interview answer, not one blob of "Redis does
  stuff."
- **Push for speed, pull for correctness** (§8) — every socket event is a "go refetch" nudge; the
  REST response is always the source of truth. A dropped WebSocket message never corrupts state.
- **Scoring idempotency via `ZINCRBY`** (§5, §7) — a worker-side idempotency flag
  (`contestScored`) plus an atomic Redis increment means a BullMQ retry can never double-count a
  contest score.
- **Hint quota is a four-gate, refundable budget** (§9) — the entire deployed app shares a
  confirmed 20-requests/day Gemini quota; per-user, per-minute, and per-day gates all provisionally
  consume and refund on failure, and a content-addressed cache serves repeat failures for free.
- **Run vs. Submit are structurally separate** (§5) — Run-on-samples uses its own BullMQ queue and
  never creates a `Submission` document, so it is *incapable* of scoring a contest or unlocking
  hints — not prevented by a check, prevented by having nothing to check.

## Scaling & performance

The architecture is deliberately built so scaling out is a deployment change, not a code change
— see [ARCHITECTURE.md §12](ARCHITECTURE.md#12-scaling-story-deploy-level-not-code-level) for the
full 10x/100x/beyond story. Deployed today as a single Azure B2s VM (2 vCPU / 4GB RAM) running
every service via Docker Compose — see [DEPLOY.md](DEPLOY.md).

### Measured performance

Load test: **15 bots, 3 max in-flight submissions, 5-minute sustained run** against the deployed
B2s VM (2 vCPU / 4 GB), solution mix ~70% AC / 20% WA / 10% TLE (`simulate-contest.ts --load` —
see DEPLOY.md's "Acceptance / load test" section; its own summary output is copy-pasted directly
into this table, no derivation needed).

| Metric | Measured |
|---|---|
| Sustained judge throughput (verdicts/min) | TODO (measured post-deploy) |
| Peak queue depth (jobs) | TODO (measured post-deploy) |
| Judge latency p95, enqueue→verdict (s) | TODO (measured post-deploy) |
| Judge latency p50, enqueue→verdict (s) | TODO (measured post-deploy) |
| POST /api/submissions p95 during peak (ms) | TODO (measured post-deploy) |
| Queue drain time after load stopped (s) | TODO (measured post-deploy) |

API response time stayed flat (~`TODO` ms) while queue depth grew to `TODO` — the queue absorbed
the burst as designed (ARCHITECTURE.md §2's queue-decoupling principle); the throughput ceiling
is judge-worker CPU, which scales horizontally on queue depth (§12).

## Run it locally

```bash
docker compose up -d          # Mongo, Redis, MinIO
npm install
npm run seed                  # 7 problems, demo users, 2 demo contests
```

Then, in three separate terminals:

```bash
npm run dev:api        # :3001
npm run dev:worker      # BullMQ consumer, no HTTP port
npm run dev:frontend    # :3000
```

Visit `http://localhost:3000`. `/styleguide` is the living design-system reference. See
`api/.env.example` / `worker/.env.example` / `frontend/.env.example` for the environment
variables each service reads (copy each to `.env` before starting).

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — the authoritative design reference, read this first
- [DEPLOY.md](DEPLOY.md) — the exact runbook used to deploy this to the live demo VM
- [DEMO.md](DEMO.md) — a scripted walkthrough of the live demo, including deliberate failure
  scenarios
- `/styleguide` — the design-system reference (ships to production)
