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

Three independent load tests against the deployed B2s VM (2 vCPU / 4 GB): the judge pipeline
under sustained submission load, the C++ compile step in isolation, and the read path (pages +
API) pushed to its breaking point. Raw output for every number below is saved under
`scripts/results/` — nothing here is derived or estimated.

#### 1. Judge pipeline (submit → verdict)

**15 bots, 3 max in-flight submissions per bot (45 applied concurrency), 5-minute sustained run**,
solution mix ~70% AC / 20% WA / 10% TLE (`simulate-contest.ts --load` — see DEPLOY.md's
"Acceptance / load test" section).

| Metric | Measured |
|---|---|
| Sustained judge throughput | 19.1 verdicts/min |
| Peak queue depth | 45 jobs |
| Judge latency (enqueue→verdict) — p50 | 140.7 s |
| Judge latency (enqueue→verdict) — p95 | 144.3 s |
| `POST /api/submissions` latency — mean | 159 ms |
| `POST /api/submissions` latency — p95 | 416 ms |
| Queue drain time after load stopped | 140.1 s |

- **API stays fast, judging queues up.** `POST /api/submissions` is O(1) work (write the Mongo
  doc, enqueue the job) that never blocks on queue depth — exactly as designed (ARCHITECTURE.md
  §2's queue-decoupling principle). The 140s+ judge latency comes entirely from a single BullMQ
  worker processing one job at a time (`worker/src/index.ts`) behind a 45-deep queue.
- **Throughput ceiling is judge-worker CPU** (19.1 verdicts/min here), which scales horizontally
  on queue depth (§12) — a separate ramp test found ~19 verdicts/min sustained capacity
  independently, consistent with this run.

Raw output: `scripts/results/load-test-2026-07-15.txt`

#### 2. C++ compile time (precompiled header)

Precompiling `<bits/stdc++.h>` into the judge image (`worker/judge/Dockerfile`) — 5 timed
compiles per sample directly against the deployed judge container, median of the last 4 after a
warm-up discard.

| Sample | Compile time reduction |
|---|---|
| short (is-prime, 22 lines) | 75.9% |
| medium (two-sum, 22 lines) | 74.9% |
| long (~150 lines: segment tree, BFS, DSU) | 56.1% |
| **Average** | **~70%** |

Compile is only **~8% of total judge latency** even with the fix (~3.2s typical judge wall time
is dominated by BullMQ pickup and sequential per-test container spin-up) — a compile-time win
specifically, not a proportional judge-latency win.

Raw output: `scripts/results/pch-compile-benchmark-2026-07-15.txt`

#### 3. Read-path ceiling (k6)

`scripts/k6-pages.js` ramps 250 → 500 → 750 → 1000 concurrent virtual users against a 50/50 mix
of page routes (`/problems`, `/problems/:slug`, `/contests/:id`, `/contests/:id/leaderboard`) and
their JSON API equivalents, run from an operator's own machine against the deployed VM.

First pass found the deployed Caddy reverse proxy repeatedly **OOM-killed under load** — its
`mem_limit` was 64m, confirmed via the VM's own kernel log (`sudo journalctl -k`), not just
inferred. Raised to 512m; re-measured clean:

| VUs | API p95 | Page p95 | Errors |
|---|---|---|---|
| 250 | 119 - 125 ms | 230 - 257 ms | 0 |
| 500 | 128 - 134 ms | 326 - 607 ms | 0 |
| 750 | 150 - 162 ms | 2.28 - 2.65 s | 0 |
| 1000 | 132 - 141 ms | 13.6 - 14.3 s | 0 |

- **500 VUs is fully clean.** API endpoints stay flat around ~140ms p95 all the way through
  1000 VUs — never the bottleneck.
- **Page latency queues past 750 VUs** (Next.js SSR rendering contending for the VM's 2 shared
  vCPUs) — but with **zero failures at every VU count tested**: a pure latency ceiling, not a
  crash.

Raw output: `scripts/results/k6-ceiling-2026-07-15.txt` (the OOM diagnosis) and
`scripts/results/k6-ceiling-v2-2026-07-15.txt` (the post-fix re-measurement).

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
