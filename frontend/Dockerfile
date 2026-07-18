# syntax=docker/dockerfile:1
# Multi-stage build for the frontend — built from the repo root context, see api/Dockerfile's
# comment on why. Uses Next's 'standalone' output (frontend/next.config.ts) instead of
# `next start`, which needs the full node_modules + .next copied into the image.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY worker/package.json worker/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY frontend ./frontend
# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time, not read at runtime —
# must be supplied via `docker build --build-arg NEXT_PUBLIC_API_URL=...` (see DEPLOY.md and
# docker-compose.prod.yml's build.args). Baking in the wrong value silently ships a frontend
# that calls the wrong API host; there is no runtime fallback for this one.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# Found missing during Nakalchi's Phase 7 production-hardening pass: without this ARG/ENV pair,
# frontend/app/admin/contests/[id]/page.tsx's `NEXT_PUBLIC_NAKALCHI_WEB_URL` read is always
# undefined in the built image regardless of what any .env.production file contains — same
# build-time-only inlining as NEXT_PUBLIC_API_URL above, and the same silent-wrong-value risk if
# omitted (here, the "View full report in Nakalchi" link just doesn't render — see that page's
# own fallback text — rather than pointing at the wrong host).
ARG NEXT_PUBLIC_NAKALCHI_WEB_URL
ENV NEXT_PUBLIC_NAKALCHI_WEB_URL=${NEXT_PUBLIC_NAKALCHI_WEB_URL}
RUN npm run build --workspace frontend

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
ENV PORT=3000
# 'standalone' output preserves the monorepo path (this is an npm-workspaces package, not a
# standalone app) — the entry point is .next/standalone/frontend/server.js, not a flat
# server.js at the output root. Static assets and (if this app ever gains one) public/ are
# deliberately excluded from standalone tracing by Next and must be copied in separately; this
# app has no public/ directory today, so only .next/static is copied.
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/.next/static ./frontend/.next/static
USER app
EXPOSE 3000
CMD ["node", "frontend/server.js"]
