import type { NextConfig } from 'next';

// 'standalone' traces and bundles only the production dependencies actually used, into
// .next/standalone — run via `node server.js` instead of `next start`, which needs the full
// node_modules + .next in the image. Meaningfully smaller image / lower memory floor, the right
// tradeoff sharing a 4GB VM with five other containers (api, worker, redis, mongo, minio) — see
// DEPLOY.md. One gotcha this mode requires: public/ and .next/static/ aren't included in the
// standalone output by default and must be copied in manually (see frontend/Dockerfile).
const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
