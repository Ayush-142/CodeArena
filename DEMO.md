# CodeArena — Demo Script

A scripted ~10-minute walkthrough for an interviewer, following the deployed instance
(`DEPLOY.md`). Every step below has been run against the real deployed stack — nothing here is
aspirational.

**Gemini budget for this whole demo: ≤4 of the platform's shared 20/day requests** (see
ARCHITECTURE.md §9 — the 20/day cap is confirmed live, shared across every user of the deployed
app, not per-user). Request at most 1–2 real hints during the walkthrough; the quota-exhaustion
chapter deliberately does **not** burn real quota to demonstrate (see that section).

---

## 0. Before you start

```bash
# On the VM, shifts the live demo contest to "starts in 2 minutes" and resets its state —
# see DEPLOY.md's "Running the live demo" section.
docker compose -f docker-compose.prod.yml --env-file .env.production exec api node api/dist/scripts/reset-demo-contest.js
```

## 1. The solving page (2 min)

Open the deployed URL → **Problems** → any easy problem. Point out:
- Monaco editor, C++ only (deliberate — a real judge needs sandboxed execution per language;
  one well-hardened language beats three half-hardened ones for a v1).
- **Run** — executes against the public samples only, through the *exact* same Docker sandbox
  pipeline as a real submission, but never creates a `Submission` document (ARCHITECTURE.md §5)
  — no history entry, no contest score, no hint unlock. Submit a deliberately wrong answer via
  Run first, show the actual-vs-expected diff.
- **Submit** the correct solution — watch it go `queued` → `running` → **AC** live over the
  socket, no page refresh. Mention the push/pull split: the socket event is just a "go refetch"
  nudge, the `GET /api/submissions/:id` response is the actual source of truth (§8).

## 2. AI hints (1–2 min, spends 1 real Gemini request)

Submit an intentionally buggy solution → **WA**. Request the Level 1 hint — watch it stream in
live (`ch:hints` → socket, §9). Point out what it does *not* say: no full solution, no corrected
code, no algorithm name at Level 1. Mention the four-gate quota system without necessarily
demoing it live here (next section covers that explicitly).

## 3. Live contest — the simulator (3 min)

The reset in step 0 already shifted the demo contest to start in ~2 minutes. In a second
terminal, kick off the bots:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec \
  -e BASE_URL=http://localhost:3001 api node api/dist/scripts/simulate-contest.js
```

While it registers bots and waits for the contest window, narrate: real `POST /api/auth/register`
calls, real contest registration, real submissions once the window opens — not database inserts
(`ARCHITECTURE.md` calls this out explicitly: "exercises the REAL system end-to-end"). Switch to
the contest leaderboard tab and **watch it reorder live** as bots with different skill profiles
(ace / steady / grinder / rookie) solve at different speeds. Open the per-problem ICPC grid —
point out the `+N` wrong-attempt notation and sticky rank/handle columns at 100-row scale.

## 4. Deliberate failures (3 min)

Three real failure scenarios, staged live.

### 4a. Kill Redis mid-submission

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production stop redis
```

Submit a solution — it still returns `202` and a real submission id (not a 500). Show it sitting
at `queued` in submission history — Redis being down doesn't corrupt anything, it just means
nothing's judging yet (ARCHITECTURE.md §11). Bring Redis back:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production start redis
docker compose -f docker-compose.prod.yml --env-file .env.production exec api node api/dist/scripts/recover-stalled-submissions.js
```

Refresh — the stuck submission finishes judging normally. This is the one chapter worth stating
plainly what it *used* to do: this exact path used to hang the request for minutes instead of
degrading (both Redis clients the API uses now fail fast when disconnected rather than buffer
and wait) — a real bug found and fixed while preparing this demo, not a hypothetical.

### 4b. Sandbox containment — a fork bomb

Submit this to any problem:
```cpp
#include <unistd.h>
int main() { while (1) fork(); }
```
The sandbox's `--pids-limit=64` stops it from consuming host resources — `fork()` starts failing
once the cap is hit, so the loop spins on failed forks until the worker's wall-clock timeout kills
the container. Verdict comes back TLE or RE depending on exact timing — the point isn't which one,
it's that **the worker process itself is never at risk**: this is a fresh, network-isolated,
non-root, memory/CPU/pids-capped container every time (§6), not the host.

### 4c. Hint quota exhaustion (no real quota spent)

Don't actually burn the shared 20/day budget live — instead, open `api/src/hints/quota.ts` and
walk through the four gates in order (anti-spam → per-user daily cap of 3 → global per-minute →
global daily cap of 18), and show the graceful-degradation response shape
(`{available:false, message:"hints are unavailable right now"}`) from the route code
(`routes/hints.ts`) — never a 5xx, judging is completely unaffected either way. If you want to
demonstrate it live and have quota to spare, request 4 hints in a row for different problems as
the same user — the 4th hits the per-user 3/day cap and degrades gracefully, at zero additional
Gemini cost (the per-user gate is checked before any Gemini call is made).

## 5. Scaling & measured performance (1 min)

Point to README.md's "Measured performance" table — real numbers from `simulate-contest.ts
--load` run against this exact VM (see DEPLOY.md's "Acceptance / load test" section). Narrate the
takeaway: API response time stays flat while queue depth absorbs the burst — the throughput
ceiling is judge-worker CPU, which is a horizontal-scaling problem (add workers, watch queue
depth), not an API-redesign problem (ARCHITECTURE.md §12).

**Never run `--load` during this demo** — it deliberately saturates the judge queue for several
minutes to produce those numbers and will make everything above visibly sluggish for anyone else
touching the box while it runs. It's an acceptance-test tool, run once after deploy, not a demo
feature.

## Afterward

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec \
  -e BASE_URL=http://localhost:3001 api node api/dist/scripts/simulate-contest.js --cleanup
```
