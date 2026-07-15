// Ceiling-finding load test — pushes VU count (250 -> 500 -> 750 -> 1000) until the read path
// (API JSON endpoints + real Next.js page routes) actually degrades, unlike k6-browse.js's
// fixed 250-VU profile which found no bottleneck. Run from an operator's own machine (WSL),
// NEVER from the VM itself.
//
//   BASE_URL=https://codearena-ayush.duckdns.org k6 run scripts/k6-pages.js
//
// IMPORTANT caveat on "SSR": /problems, /problems/:slug, /contests/:id, and
// /contests/:id/leaderboard are all `'use client'` components (confirmed by reading
// frontend/app/**/page.tsx) — they fetch their data client-side via useEffect, not as part of
// Next.js server rendering. Hitting these routes with k6 still costs the frontend container real
// work (Next.js renders the initial HTML shell server-side for every request, client component
// or not), but it does NOT itself trigger a server-side call to the API — that only happens in a
// real browser after hydration. The separate `class:api` 50% of this script's traffic
// approximates that client-side fetch load a real browser fleet would additionally generate;
// it is not causally chained to the `class:page` requests within one iteration.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'https://codearena-ayush.duckdns.org';
const CONTEST_ID = '6a5254e9094b67512ace494f'; // winter-open — ended/finalized, public, no auth
const PROBLEM_SLUGS = ['max-subarray-sum', 'reverse-a-string', 'square-number', 'sum-of-n-numbers'];

export const errors = new Rate('errors');
export const count429 = new Counter('errors_429');
export const count5xx = new Counter('errors_5xx');
export const countTimeout = new Counter('errors_timeout');
export const countOther = new Counter('errors_other');

// Mirrors STAGE_BOUNDARIES_MS's role in k6-browse.js — kept in sync with `stages` below by hand.
const STAGE_BOUNDARIES_MS = [
  { end: 30_000, label: 'ramp_to_250' },
  { end: 150_000, label: 'hold_250' },
  { end: 180_000, label: 'ramp_to_500' },
  { end: 300_000, label: 'hold_500' },
  { end: 330_000, label: 'ramp_to_750' },
  { end: 450_000, label: 'hold_750' },
  { end: 480_000, label: 'ramp_to_1000' },
  { end: 600_000, label: 'hold_1000' },
  { end: 630_000, label: 'ramp_down' },
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
        { duration: '30s', target: 250 },
        { duration: '2m', target: 250 },
        { duration: '30s', target: 500 },
        { duration: '2m', target: 500 },
        { duration: '30s', target: 750 },
        { duration: '2m', target: 750 },
        { duration: '30s', target: 1000 },
        { duration: '2m', target: 1000 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Abort safety net (STEP 2's "stop rather than grind the VM") — a real threshold breach,
    // evaluated globally across the whole run, not per-stage. delayAbortEval gives it 10s of
    // data before the first evaluation so a brief blip at ramp start can't trip it instantly.
    errors: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '10s' }],
    // Degradation criteria defined BEFORE running (STEP 2): >0.5% errors or p95>1.5s at a given
    // hold stage. These do NOT abort — they're evaluated after the run to identify the ceiling.
    'errors{stage:hold_250}': ['rate<0.005'],
    'errors{stage:hold_500}': ['rate<0.005'],
    'errors{stage:hold_750}': ['rate<0.005'],
    'errors{stage:hold_1000}': ['rate<0.005'],
    'http_req_duration{stage:hold_250}': ['p(95)<1500'],
    'http_req_duration{stage:hold_500}': ['p(95)<1500'],
    'http_req_duration{stage:hold_750}': ['p(95)<1500'],
    'http_req_duration{stage:hold_1000}': ['p(95)<1500'],
  },
};

// `tags` MUST be passed explicitly to every custom metric .add() call — unlike k6's built-in
// http_* metrics (which auto-inherit the tags passed to http.get()), custom Rate/Counter metrics
// have no implicit tag context. Confirmed the hard way: an earlier version of this function called
// .add() with no tags, so every `errors{stage:X}` submetric in the live console silently showed a
// false 0.00% for the whole run — the real per-stage error rates had to be reconstructed after
// the fact from the auto-tagged built-in http_req_failed metric instead. See
// scripts/results/k6-ceiling-2026-07-15.txt's "CORRECTION" section for the full story.
function classify(res, tags) {
  const ok = res.status >= 200 && res.status < 300;
  errors.add(!ok, tags);
  if (!ok) {
    if (res.status === 429) count429.add(1, tags);
    else if (res.status >= 500) count5xx.add(1, tags);
    else if (res.status === 0 || res.error_code) countTimeout.add(1, tags);
    else countOther.add(1, tags);
  }
  return ok;
}

export default function () {
  const stage = currentStage();
  const r = Math.random();
  const slug = PROBLEM_SLUGS[Math.floor(Math.random() * PROBLEM_SLUGS.length)];

  // 50% page routes (class:page), split 15/15/10/10 mirroring k6-browse.js's API proportions.
  // 50% API routes (class:api), same 15/15/10/10 split, same 4 logical endpoints as before.
  let url;
  let tags;
  if (r < 0.15) {
    url = `${BASE_URL}/problems`;
    tags = { stage, class: 'page', endpoint: 'problems_list_page' };
  } else if (r < 0.3) {
    url = `${BASE_URL}/problems/${slug}`;
    tags = { stage, class: 'page', endpoint: 'problem_detail_page' };
  } else if (r < 0.4) {
    url = `${BASE_URL}/contests/${CONTEST_ID}`;
    tags = { stage, class: 'page', endpoint: 'contest_page_page' };
  } else if (r < 0.5) {
    url = `${BASE_URL}/contests/${CONTEST_ID}/leaderboard`;
    tags = { stage, class: 'page', endpoint: 'leaderboard_page' };
  } else if (r < 0.65) {
    url = `${BASE_URL}/api/problems`;
    tags = { stage, class: 'api', endpoint: 'problem_list_api' };
  } else if (r < 0.8) {
    url = `${BASE_URL}/api/problems/${slug}`;
    tags = { stage, class: 'api', endpoint: 'problem_detail_api' };
  } else if (r < 0.9) {
    url = `${BASE_URL}/api/contests/${CONTEST_ID}`;
    tags = { stage, class: 'api', endpoint: 'contest_page_api' };
  } else {
    url = `${BASE_URL}/api/contests/${CONTEST_ID}/leaderboard`;
    tags = { stage, class: 'api', endpoint: 'leaderboard_api' };
  }

  const res = http.get(url, { tags });
  check(res, { '2xx': (r) => classify(r, tags) });

  sleep(1 + Math.random() * 2);
}
