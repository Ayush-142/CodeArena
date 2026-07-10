# syntax=docker/dockerfile:1
# Multi-stage build for the judge worker — built from the repo root context, see api/Dockerfile's
# comment on why (shared npm-workspaces lockfile). node:22-alpine is safe here too: dockerode
# talks to the Docker daemon over its HTTP API via a unix socket, no native compilation needed.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM deps AS build
COPY worker ./worker
RUN npm run build --workspace worker

# Separate clean production-only install rather than `npm prune --omit=dev` on the `deps`
# stage's tree — see api/Dockerfile's comment for why (prune silently dropped a real runtime
# dependency in testing when other workspaces are present only as bare package.json manifests).
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# The whole prod-deps tree, not just root node_modules — see api/Dockerfile's comment: npm
# workspaces leaves some packages nested per-workspace (redis, b4a, tar-stream here) rather
# than hoisted, and enumerating which ones is fragile against a future lockfile change.
COPY --from=prod-deps /app ./
COPY --from=build /app/worker/dist ./worker/dist
COPY --from=build /app/worker/package.json ./worker/package.json
# Deliberately NO non-root `USER` directive here — the one intentional exception in this
# fleet's Dockerfiles. This container bind-mounts /var/run/docker.sock (see
# docker-compose.prod.yml) to talk to the HOST's Docker daemon via dockerode, spawning judge
# sandbox containers — in practice that requires root, or a user in a group matching the host
# socket's GID, which isn't portable to set up generically at image-build time. This is a
# known, standard tradeoff of the "container talks to host Docker via socket" pattern, not an
# oversight: a process with access to the host's Docker socket can, in principle, launch
# arbitrary privileged containers and so is equivalent to root on the host. Stated plainly here
# and in ARCHITECTURE.md §6 / DEPLOY.md, not left implicit. Future hardening path (not built):
# a Docker-socket proxy (e.g. docker-socket-proxy) exposing only the specific create/start/
# stop/remove calls the worker actually needs, run as a non-root user talking to that proxy
# instead of the raw socket.
CMD ["node", "worker/dist/index.js"]
