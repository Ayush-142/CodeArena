// Read-path (browse) load test — simulates concurrent users browsing CodeArena's read-only
// pages, NOT hammering a single endpoint. Run from an operator's own machine against the
// deployed VM (never from the VM itself — this measures what a real client sees, including
// network latency to the VM, and never risks starving the box it's supposed to be judging on).
//
//   BASE_URL=https://codearena-ayush.duckdns.org k6 run scripts/k6-browse.js
//
// Endpoints exercised (confirmed against frontend/lib/api.ts and api/src/routes/{problems,contests}.ts
// — none of these five are rate-limited server-side; only auth/hints/run/submissions POST routes
// are, per api/src/routes/*.ts's `rateLimit(...)` usage):
//   GET /api/problems                              (problem list)          30%
//   GET /api/problems/:slug                         (problem statement)     30%
//   GET /api/contests/:id                            (contest page)          20%
//   GET /api/contests/:id/leaderboard                (leaderboard)           20%
// All five are public (no requireAuth) as long as the target contest isn't in its 'running'
// phase — CONTEST_ID below is winter-open, already ended and finalized, so every request here
// runs fully unauthenticated. No bot tokens needed.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'https://codearena-ayush.duckdns.org';
// winter-open — real demo contest, finalized/ended, public without auth (see header comment).
const CONTEST_ID = '6a5254e9094b67512ace494f';
// The 4 currently-published problems (is-prime/two-sum/longest-increasing-subsequence are
// gated behind an unrelated in-progress contest right now and would 404 unauthenticated).
const PROBLEM_SLUGS = ['max-subarray-sum', 'reverse-a-string', 'square-number', 'sum-of-n-numbers'];

export const errors = new Rate('errors');
export const count429 = new Counter('errors_429');
export const count5xx = new Counter('errors_5xx');
export const countTimeout = new Counter('errors_timeout');
export const countOther = new Counter('errors_other');

// Stage boundaries in ms since test start — mirrors the `stages` option below exactly, so every
// request can be tagged with which stage it landed in for later per-stage breakdown. Keep these
// two in sync by hand; k6 doesn't expose "current stage index" directly.
const STAGE_BOUNDARIES_MS = [
  { end: 60_000, label: 'ramp_to_50' },
  { end: 180_000, label: 'hold_50' },
  { end: 240_000, label: 'ramp_to_100' },
  { end: 360_000, label: 'hold_100' },
  { end: 420_000, label: 'ramp_to_250' },
  { end: 720_000, label: 'hold_250' },
  { end: 780_000, label: 'ramp_down' },
];

function currentStage() {
  const t = exec.instance.currentTestRunDuration;
  for (const b of STAGE_BOUNDARIES_MS) {
    if (t < b.end) return b.label;
  }
  return 'ramp_down';
}

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 }, // ramp to 50
        { duration: '2m', target: 50 }, // hold 50
        { duration: '1m', target: 100 }, // ramp to 100
        { duration: '2m', target: 100 }, // hold 100
        { duration: '1m', target: 250 }, // ramp to 250
        { duration: '5m', target: 250 }, // hold 250
        { duration: '1m', target: 0 }, // ramp down
      ],
      gracefulRampDown: '30s',
    },
  },
  // Verdict criterion, per the request: error rate and p95 latency specifically at the 250-VU
  // hold. Thresholds don't abort the run; they're just flagged pass/fail in the summary.
  thresholds: {
    'errors{stage:hold_250}': ['rate<0.01'],
    'http_req_duration{stage:hold_250}': ['p(95)<1000'],
  },
};

function classify(res) {
  const ok = res.status >= 200 && res.status < 300;
  errors.add(!ok);
  if (!ok) {
    if (res.status === 429) count429.add(1);
    else if (res.status >= 500) count5xx.add(1);
    else if (res.status === 0 || res.error_code) countTimeout.add(1); // k6: status 0 + error_code set = network-level failure (timeout/reset/DNS)
    else countOther.add(1);
  }
  return ok;
}

export default function () {
  const stage = currentStage();
  const tags = { stage };
  const r = Math.random();

  if (r < 0.3) {
    const res = http.get(`${BASE_URL}/api/problems`, { tags: { ...tags, endpoint: 'problem_list' } });
    check(res, { 'problem list 2xx': (r) => classify(r) });
  } else if (r < 0.6) {
    const slug = PROBLEM_SLUGS[Math.floor(Math.random() * PROBLEM_SLUGS.length)];
    const res = http.get(`${BASE_URL}/api/problems/${slug}`, { tags: { ...tags, endpoint: 'problem_detail' } });
    check(res, { 'problem detail 2xx': (r) => classify(r) });
  } else if (r < 0.8) {
    const res = http.get(`${BASE_URL}/api/contests/${CONTEST_ID}`, { tags: { ...tags, endpoint: 'contest_page' } });
    check(res, { 'contest page 2xx': (r) => classify(r) });
  } else {
    const res = http.get(`${BASE_URL}/api/contests/${CONTEST_ID}/leaderboard`, {
      tags: { ...tags, endpoint: 'leaderboard' },
    });
    check(res, { 'leaderboard 2xx': (r) => classify(r) });
  }

  sleep(1 + Math.random() * 2); // 1-3s think time between requests, per VU
}
