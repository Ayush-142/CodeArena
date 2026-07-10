# syntax=docker/dockerfile:1
# Multi-stage build for the API — built from the repo root context (a single npm-workspaces
# lockfile covers api/worker/frontend together), see docker-compose.prod.yml's `context: .`.
# node:22-alpine is safe here: api's dependencies are pure-JS (bcryptjs, not native bcrypt —
# see ARCHITECTURE.md's Phase 7 deploy notes), no native compilation needed.

FROM node:22-alpine AS deps
WORKDIR /app
# Only the package manifests — lets Docker cache this (slow) layer separately from source
# changes. npm workspaces resolves the whole tree from these four files alone.
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM deps AS build
COPY api ./api
RUN npm run build --workspace api

# Separate clean production-only install, rather than `npm prune --omit=dev` on the `deps`
# stage's tree: pruning after the fact got this wrong in testing (it silently dropped the
# top-level `redis` package — a real runtime `dependencies` entry, not a devDependency — while
# leaving its own transitive sub-packages behind; npm's workspace-graph pruning logic seems to
# get confused when other workspaces are present only as bare package.json manifests, as they
# are in this build). A fresh `npm ci --omit=dev` from the same lockfile has no such ambiguity.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
# The whole prod-deps tree, not just the root node_modules — npm workspaces doesn't always
# hoist every package (confirmed here: `redis` itself lands in api/node_modules/redis, not
# hoisted to root, even though nothing conflicts on its version) and enumerating which specific
# packages end up nested is fragile against a future `npm install` changing that decision.
COPY --from=prod-deps /app ./
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/package.json ./api/package.json
# api/src/scripts/seed.ts resolves problem data relative to itself as ../../../problems (repo
# root) — needed so `node api/dist/scripts/seed.js` can run inside this image (the compiled
# script has no tsx/devDependency requirement, unlike `npm run seed`, which isn't available
# here since prod-deps omits devDependencies). See DEPLOY.md's seeding step.
COPY problems ./problems
USER app
EXPOSE 3001
CMD ["node", "api/dist/index.js"]
