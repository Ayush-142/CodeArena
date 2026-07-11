# CodeArena — Deploy Runbook

A step-by-step runbook for taking a blank Azure for Students VM to a running CodeArena
deployment. Written to be executed **verbatim, in order**, over SSH — no step assumes access to
your Azure account or your VM's IP. Every value you need to
generate or look up is called out explicitly with the exact command to produce it.

**Target:** Azure B2s (2 vCPU / 4GB RAM), Ubuntu 24.04 LTS, amd64, public IP already provisioned.
Everything (frontend, api, worker, Redis, Mongo, MinIO, Caddy) runs on this one VM via Docker
Compose — see `docker-compose.prod.yml` and ARCHITECTURE.md §12 for why a single VM is the right
call at this scale, and what changes first if it stops being enough.

---

## Part A — Before you SSH in

Done from your own machine or the Azure/DuckDNS web consoles, not on the VM.

### A1. DuckDNS subdomain

1. Sign in at [duckdns.org](https://www.duckdns.org) (any of its OAuth providers works).
2. Create a subdomain, e.g. `codearena-<yourname>` → this gives you
   `codearena-<yourname>.duckdns.org`. DuckDNS is on the Public Suffix List, so this is its own
   registrable domain (eTLD+1) — required for the `SameSite=Strict` cookie to work correctly
   between the frontend and API, both served from this one domain (ARCHITECTURE.md §8).
3. Note your DuckDNS **token** (shown on the same page) — you'll use it once, from the VM, in
   Part B.4. Don't need to point the IP yet; you'll do that from the VM itself (simplest way to
   get the update to auto-detect the correct public IP).

### A2. Azure Network Security Group

In the Azure Portal, on your VM's Networking blade (or the NSG resource directly), confirm
**inbound** rules allow exactly:

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | TCP | Your IP only (not `Any`, if practical) | SSH |
| 80 | TCP | Any | HTTP (Caddy's ACME challenge + redirect to 443) |
| 443 | TCP | Any | HTTPS (the actual app) |

Remove or deny any other inbound rule Azure's default NSG may have created (e.g. a default
`Any`-source SSH rule) — tighten 22 to your current IP specifically if your ISP gives you a
stable-enough address; re-add if it changes and you get locked out.

No other ports need to be open — Mongo (27017), Redis (6379), MinIO (9000), the api (3001), and
the frontend (3000) are only reachable on the compose-internal Docker network, never the host's
public interface (see `docker-compose.prod.yml` — only the `caddy` service publishes ports).

---

## Part B — On the VM (via SSH)

SSH in first: `ssh <your-user>@<vm-public-ip>`. Every command below runs on the VM.

### B1. System update + swapfile

The B2s's 4GB RAM is enough for the whole stack (mem_limits sum to ~2.24GB, see
`docker-compose.prod.yml`'s comment) but a swapfile is cheap insurance against a burst of
concurrent judge-container spawns.

```bash
sudo apt-get update && sudo apt-get upgrade -y

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # sanity check — should now show 2.0G under Swap
```

### B2. Install Docker + Compose plugin

```bash
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker $USER
newgrp docker   # activates the new group membership in this shell without a full re-login

docker version           # confirm the client+server both report a version
docker compose version   # confirm the compose plugin is present
```

### B3. Clone the repo

```bash
git clone https://github.com/Ayush-142/online-judge.git codearena
cd codearena
```

### B4. Point DuckDNS at this VM

```bash
# Replace <subdomain> and <token> with your actual values from Part A.1. The empty `ip=`
# parameter tells DuckDNS to use the IP the request arrived from — since you're running this
# from the VM itself, that's automatically the VM's own public IP, no manual lookup needed.
curl "https://www.duckdns.org/update?domains=<subdomain>&token=<token>&ip="
# Expect the response body "OK". Confirm propagation (may take a minute):
dig +short <subdomain>.duckdns.org
```

### B5. Generate secrets

All three commands produce hex strings — safe to embed directly in connection strings and env
files with no URL-encoding concerns (unlike base64, which can contain `/` and `+`).

```bash
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 24   # → MONGO_ROOT_PASSWORD
openssl rand -hex 24   # → MINIO_ROOT_PASSWORD
```

Run each once and keep the three values handy for the next step — you'll paste each one into
**two** files (the root `.env.production` for Compose's own interpolation, and the matching
`api`/`worker` `.env.production` for the actual connection strings — these are two different
substitution mechanisms that don't share values automatically; see the comments in each
`.env.production.example`).

### B6. Create the four `.env.production` files

```bash
cp .env.production.example .env.production
cp api/.env.production.example api/.env.production
cp worker/.env.production.example worker/.env.production
```

Now edit all three with a real editor (`nano .env.production`, etc.) and fill in:

**`.env.production`** (repo root):
- `MONGO_ROOT_USERNAME` — pick anything, e.g. `codearena`
- `MONGO_ROOT_PASSWORD` — the second `openssl rand -hex 24` value from B5
- `MINIO_ROOT_USER` — pick anything, e.g. `codearena`
- `MINIO_ROOT_PASSWORD` — the third `openssl rand -hex 24` value from B5
- `DOMAIN` — your full `<subdomain>.duckdns.org` from A1
- `NEXT_PUBLIC_API_URL` — `https://<subdomain>.duckdns.org/api`

**`api/.env.production`**:
- `MONGO_URI` — `mongodb://<MONGO_ROOT_USERNAME>:<MONGO_ROOT_PASSWORD>@mongo:27017/codearena?authSource=admin`, using the SAME values you just put in the root file
- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` — the SAME `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` values
- `JWT_SECRET` — the first `openssl rand -hex 32` value from B5
- `CORS_ORIGIN` — `https://<subdomain>.duckdns.org`
- `GEMINI_API_KEY` — your real key from Google AI Studio (never commit this)
- Leave `COOKIE_SECURE=true`, `PORT=3001`, `NODE_ENV=production`, and the hint-limit values as-is

**`worker/.env.production`**:
- `MONGO_URI` — same value as `api/.env.production`
- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` — same values as `api/.env.production`

There's no `frontend/.env.production` to create — `NEXT_PUBLIC_API_URL` is passed as a Docker
build arg from the root `.env.production`, not read from a per-service file (see
`frontend/.env.production.example`'s comment).

### B7. Build and start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production --profile judge-image build judge-image
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

**Never `up --build` on this box.** The first `build` above must run to completion by itself —
it takes several minutes (base image pulls + `npm ci` + `next build`) and pins the 2 vCPUs the
whole time. `up --build` interleaves that same CPU-starved build with `up`'s own healthcheck
polling for `mongo`/`redis`/`minio`, and a busy-but-fine service can get marked `unhealthy` and
wedge the `depends_on: condition: service_healthy` chain (this happened for real on the deployed
VM — see the Troubleshooting section below). Always run `build` to completion, THEN `up -d`.

The first `build` takes several minutes (base image pulls + `npm ci` + `next build`). The
`judge-image` line is a **separate, explicit build** — it produces the `codearena-judge:12-bookworm`
image `worker/src/sandbox.ts` spawns judge sandboxes from (real contestant C++ almost always
`#include <bits/stdc++.h>`, and that image has it precompiled — see `worker/judge/Dockerfile`'s
comment). It's gated behind a compose profile that's never active by default specifically so
the plain `build`/`up -d` above never try to treat it as a long-running service — without this
line, the worker container still starts fine, but the very first real submission fails when
`docker createContainer` can't find an image by that name. `up -d` starts everything in
dependency order — `api` and `worker` wait for `mongo`/`redis`/`minio` to report healthy before
starting (see the `depends_on: condition: service_healthy` blocks in `docker-compose.prod.yml`).

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
# Expect: mongo/redis/minio "healthy"; api/worker/frontend/caddy "Up".
```

### B8. Seed the database

The production image doesn't include `tsx` (a devDependency, omitted from the prod install —
see api/Dockerfile's comment), so seeding runs the **compiled** script directly, not
`npm run seed`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec api node api/dist/scripts/seed.js
```

Expect ~10 lines of `seeded ...` output ending with the two demo contests. Safe to re-run —
idempotent (see ARCHITECTURE.md §14 / the seed script's own comments).

---

## Smoke-test checklist

Run every check below **after** B7/B8 complete. The first block is over SSH on the VM itself
(`/health`, `/ready`, `/metrics` are deliberately not routed by Caddy — see the Caddyfile's
comment — so they're only reachable this way, never through the public domain). By design
`docker-compose.prod.yml` does **not** publish the api container's port to the host, so reach it
via `docker compose exec`, which hits the container's own loopback without needing any port
published:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec api wget -qO- localhost:3001/health
docker compose -f docker-compose.prod.yml --env-file .env.production exec api wget -qO- localhost:3001/ready
docker compose -f docker-compose.prod.yml --env-file .env.production exec api wget -qO- localhost:3001/metrics
```

Then, from your own machine's browser (the real public path):

- [ ] `https://<subdomain>.duckdns.org/` loads the frontend, padlock shows a valid Let's Encrypt
      cert (not a browser warning — if you see one, Caddy is still provisioning it; wait ~30s
      and reload, then check `docker compose logs caddy` if it persists).
- [ ] `https://<subdomain>.duckdns.org/problems` shows the seeded problem list.
- [ ] Register a real account, log in.
- [ ] Submit a correct solution to any seeded problem, watch it go queued → running → **AC**
      live (no page refresh).
- [ ] Visit `/contests`, open **CodeArena Winter Open** → **View leaderboard** → confirm the
      finalized standings with per-problem cells render.
- [ ] `curl -sk -o /dev/null -w '%{http_code}\n' https://<subdomain>.duckdns.org/api/health` from
      your own machine returns **404** (not 200) — confirms `/health` is correctly unreachable
      through the public domain (see the Caddyfile).

- [ ] Reboot the VM (`sudo reboot`), wait ~30s, SSH back in, `docker compose ... ps` — every
      service should be back up on its own (`restart: unless-stopped` on all seven), no manual
      `up` needed.

---

## Running the live demo (day-of)

```bash
# Shifts the seeded live-demo contest to "starts in 2 minutes", wipes prior bot data, re-hides
# its problems (see ARCHITECTURE.md §14 / reset-demo-contest.ts's own comments).
docker compose -f docker-compose.prod.yml --env-file .env.production exec api node api/dist/scripts/reset-demo-contest.js

# Drives it live — real bot registrations, real submissions, real judging. BASE_URL defaults to
# localhost:3001 inside the container's own network namespace, which is correct when run via
# `exec` like this (it's making requests to itself over the compose network).
docker compose -f docker-compose.prod.yml --env-file .env.production exec -e BASE_URL=http://localhost:3001 api node api/dist/scripts/simulate-contest.js

# Afterward, remove the bot accounts:
docker compose -f docker-compose.prod.yml --env-file .env.production exec -e BASE_URL=http://localhost:3001 api node api/dist/scripts/simulate-contest.js --cleanup
```

See DEMO.md for the full narrated walkthrough this fits into.

---

## Acceptance / load test (produces README.md's "Measured performance" numbers)

`simulate-contest.ts --load` is a **separate mode from the demo above** — it deliberately
saturates the judge queue with a sustained submission rate to measure real throughput/latency
under load, and prints a 6-row summary table at the end. Run it once against the deployed VM
after B7/B8, before the first real demo, and paste its output directly into README.md's
"Measured performance" table (the columns are field-for-field identical — no unit conversion or
derivation needed). **Never run this during a live audience demo** — it's an acceptance-test
tool, not a demo feature, and will visibly slow down anything else hitting the same worker while
it runs.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec \
  -e BASE_URL=http://localhost:3001 -e LOAD_BOT_COUNT=15 -e LOAD_DURATION_MINUTES=5 \
  api node api/dist/scripts/simulate-contest.js --load
```

Cleans up its own bot accounts automatically when it finishes — no separate `--cleanup` needed
afterward (unlike the demo-mode bots above).

---

## Common operations

**View logs** (structured JSON via pino — pipe through `jq` for readability if installed):
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f worker
```

**Redeploy after a code change** (on the VM):
```bash
cd ~/codearena
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production --profile judge-image build judge-image
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

**Full stop** (keeps volumes — Mongo/MinIO/Caddy cert data survive):
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production down
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Caddy shows a self-signed/invalid cert warning | ACME challenge failed — usually port 80 blocked (recheck the NSG rule from A2) or DNS hasn't propagated yet (recheck B4's `dig`). `docker compose logs caddy` shows the actual ACME error. |
| `api`/`worker` stuck restarting | `docker compose logs api` (or `worker`) — almost always a wrong value in `api/.env.production`/`worker/.env.production` (check `MONGO_URI`'s username/password match the root file exactly — env_file values are literal, not `${VAR}`-substituted). |
| `worker` can't spawn judge containers | Confirm `/var/run/docker.sock` is actually mounted (`docker compose config` should show it under `worker.volumes`) and that Docker itself is running on the host (`sudo systemctl status docker`). |
| Registration/login "rate limited" during testing | `rl:auth:{ip}` is 10 attempts/15min/IP (`api/src/config/rateLimits.ts`) — shared between register and login from the same source IP; wait out the window or use a different account for the next test. |
| `git pull` conflicts with local `.env.production` files | It shouldn't — they're gitignored and were never tracked. If you see a conflict, something else was edited in a tracked file; resolve normally, the env files are untouched either way. |
| Submissions from during a Redis outage stuck at `queued` | Expected — see ARCHITECTURE.md §11. Once Redis is back: `docker compose -f docker-compose.prod.yml --env-file .env.production exec api node api/dist/scripts/recover-stalled-submissions.js`. |
| A service (e.g. `minio`) shows `unhealthy` during heavy load, like mid-build | Check `docker stats` / `free -h` before assuming the service is broken — the box is genuinely small and can be busy, not dead. The healthchecks are already tuned tolerant for this (`start_period: 30s`, `timeout: 10s`, `retries: 12` — see `docker-compose.prod.yml`); this row is for while you're waiting on those to catch up, or if it still doesn't recover. |
| A container's `BLOCK I/O` in `docker stats` keeps growing by gigabytes while it sits pinned at its `mem_limit` | The limit is too small for that service's actual working set — it's thrashing its page cache against disk (confirmed root cause for `minio` at 256m: memory pinned at the limit, ~186GB cumulative block reads during one `up --build`, which saturated the IOPS-capped Azure disk and starved its own healthcheck). Raise `mem_limit` for that service rather than assuming it's hung or broken. |
| Services were slow/unhealthy after a long `build` | Also check Azure CPU credits for the VM (`az vm get-instance-view` or the Azure portal's "CPU credits remaining" metric) — B-series burstable VMs throttle hard once credits are exhausted, and a long build is exactly what burns through them. |
